import async from 'async';
import { errors, versioning } from 'arsenal';

import collectCorsHeaders from '../utilities/collectCorsHeaders';
import locationConstraintCheck from './apiUtils/object/locationConstraintCheck';
import { versioningPreprocessing } from './apiUtils/object/versioning';
import data from '../data/wrapper';
import kms from '../kms/wrapper';
import { logger } from '../utilities/logger';
import services from '../services';
import utils from '../utils';
import validateHeaders from '../utilities/validateHeaders';
import { pushMetric } from '../utapi/utilities';
import removeAWSChunked from './apiUtils/object/removeAWSChunked';
import { metadataValidateBucketAndObj } from
'../metadata/metadataUtils';

const versionIdUtils = versioning.VersionID;

/**
 * Preps metadata to be saved (based on copy or replace request header)
 * @param {object} sourceObjMD - object md of source object
 * @param {object} headers - request headers
 * @param {boolean} sourceIsDestination - whether or not source is same as
 * destination
 * @param {AuthInfo} authInfo - authInfo from Vault
 * @param {string} objectKey - destination key name
 * @param {object} log - logger object
 * @return {object} storeMetadataParams or an error
 */
function _prepMetadata(sourceObjMD, headers, sourceIsDestination, authInfo,
    objectKey, log) {
    let whichMetadata = headers['x-amz-metadata-directive'];
    // Default is COPY
    whichMetadata = whichMetadata === undefined ? 'COPY' : whichMetadata;
    if (whichMetadata !== 'COPY' && whichMetadata !== 'REPLACE') {
        return { error: errors.InvalidArgument };
    }
    const overrideMetadata = {};
    if (headers['x-amz-server-side-encryption']) {
        overrideMetadata['x-amz-server-side-encryption'] =
            headers['x-amz-server-side-encryption'];
    }
    if (headers['x-amz-storage-class']) {
        overrideMetadata['x-amz-storage-class'] =
            headers['x-amz-storage-class'];
    }
    if (headers['x-amz-website-redirect-location']) {
        overrideMetadata['x-amz-website-redirect-location'] =
            headers['x-amz-website-redirect-location'];
    }
    // Cannot copy from same source and destination if no MD
    // changed
    if (sourceIsDestination && whichMetadata === 'COPY' &&
        Object.keys(overrideMetadata).length === 0) {
        return { error: errors.InvalidRequest.customizeDescription('This copy' +
            ' request is illegal because it is trying to copy an ' +
            'object to itself without changing the object\'s metadata, ' +
            'storage class, website redirect location or encryption ' +
            'attributes.') };
    }
    // If COPY, pull all x-amz-meta keys/values from source object
    // Otherwise, pull all x-amz-meta keys/values from request headers
    const userMetadata = whichMetadata === 'COPY' ?
        utils.getMetaHeaders(sourceObjMD) :
        utils.getMetaHeaders(headers);

    // If COPY, pull the necessary headers from source object
    // Otherwise, pull them from request headers
    const headersToStoreSource = whichMetadata === 'COPY' ?
        sourceObjMD : headers;

    const storeMetadataParams = {
        objectKey,
        log,
        headers,
        authInfo,
        metaHeaders: userMetadata,
        size: sourceObjMD['content-length'],
        contentType: headersToStoreSource['content-type'],
        contentMD5: sourceObjMD['content-md5'],
        cacheControl: headersToStoreSource['cache-control'],
        contentDisposition: headersToStoreSource['content-disposition'],
        contentEncoding:
            removeAWSChunked(headersToStoreSource['content-encoding']),
        expires: headersToStoreSource.expires,
        overrideMetadata,
        lastModifiedDate: new Date().toJSON(),
    };

    // In case whichMetadata === 'REPLACE' but contentType is undefined in copy
    // request headers, make sure to keep the original header instead
    if (!storeMetadataParams.contentType) {
        storeMetadataParams.contentType = sourceObjMD['content-type'];
    }

    return storeMetadataParams;
}

/**
 * PUT Object Copy in the requested bucket.
 * @param {AuthInfo} authInfo - Instance of AuthInfo class with
 * requester's info
 * @param {request} request - request object given by router,
 *                            includes normalized headers
 * @param {string} sourceBucket - name of source bucket for object copy
 * @param {string} sourceObject - name of source object for object copy
 * @param {string} sourceVersionId - versionId of source object for copy
 * @param {object} log - the log request
 * @param {function} callback - final callback to call with the result
 * @return {undefined}
 */
export default
function objectCopy(authInfo, request, sourceBucket,
    sourceObject, sourceVersionId, log, callback) {
    log.debug('processing request', { method: 'objectCopy' });
    const destBucketName = request.bucketName;
    const destObjectKey = request.objectKey;
    const sourceIsDestination =
        destBucketName === sourceBucket && destObjectKey === sourceObject;
    const valGetParams = {
        authInfo,
        bucketName: sourceBucket,
        objectKey: sourceObject,
        versionId: sourceVersionId,
        requestType: 'objectGet',
    };
    const valPutParams = {
        authInfo,
        bucketName: destBucketName,
        objectKey: destObjectKey,
        requestType: 'objectPut',
        log,
    };
    const dataStoreContext = {
        bucketName: destBucketName,
        owner: authInfo.getCanonicalID(),
        namespace: request.namespace,
        objectKey: destObjectKey,
    };
    const websiteRedirectHeader =
        request.headers['x-amz-website-redirect-location'];

    if (!utils.validateWebsiteHeader(websiteRedirectHeader)) {
        const err = errors.InvalidRedirectLocation;
        log.debug('invalid x-amz-website-redirect-location' +
            `value ${websiteRedirectHeader}`, { error: err });
        return callback(err);
    }

    return async.waterfall([
        function checkDestAuth(next) {
            return services.metadataValidateAuthorization(valPutParams,
                (err, destBucketMD, destObjMD) => {
                    if (err) {
                        log.debug('error validating put part of request',
                        { error: err });
                        return next(err, destBucketMD);
                    }
                    const flag = destBucketMD.hasDeletedFlag()
                        || destBucketMD.hasTransientFlag();
                    if (flag) {
                        log.trace('deleted flag or transient flag ' +
                        'on destination bucket', { flag });
                        return next(errors.NoSuchBucket);
                    }
                    return next(null, destBucketMD, destObjMD);
                });
        },
        function checkSourceAuthorization(destBucketMD, destObjMD, next) {
            return metadataValidateBucketAndObj(valGetParams, log,
                (err, sourceBucketMD, sourceObjMD) => {
                    if (err) {
                        log.debug('error validating get part of request',
                        { error: err });
                        return next(err, null, destBucketMD);
                    }
                    if (!sourceObjMD) {
                        const err = sourceVersionId ? errors.NoSuchVersion :
                            errors.NoSuchKey;
                        log.debug('no source object', { sourceObject });
                        return next(err, null, destBucketMD);
                    }
                    if (sourceObjMD.isDeleteMarker) {
                        log.debug('delete marker on source object',
                        { sourceObject });
                        if (sourceVersionId) {
                            const err = errors.InvalidRequest
                            .customizeDescription('The source of a copy ' +
                            'request may not specifically refer to a delete' +
                            'marker by version id.');
                            return next(err, destBucketMD);
                        }
                        // if user specifies a key in a versioned source bucket
                        // without specifying a version, and the object has
                        // a delete marker, return NoSuchKey
                        return next(errors.NoSuchKey, destBucketMD);
                    }
                    const headerValResult =
                        validateHeaders(sourceObjMD, request.headers);
                    if (headerValResult.error) {
                        return next(errors.PreconditionFailed, destBucketMD);
                    }
                    const storeMetadataParams =
                        _prepMetadata(sourceObjMD, request.headers,
                            sourceIsDestination, authInfo, destObjectKey, log);
                    if (storeMetadataParams.error) {
                        return next(storeMetadataParams.error, destBucketMD);
                    }
                    let dataLocator;
                    // If 0 byte object just set dataLocator to empty array
                    if (!sourceObjMD.location) {
                        dataLocator = [];
                    } else {
                        // To provide for backwards compatibility before
                        // md-model-version 2, need to handle cases where
                        // objMD.location is just a string
                        dataLocator = Array.isArray(sourceObjMD.location) ?
                        sourceObjMD.location : [{ key: sourceObjMD.location }];
                    }

                    if (sourceObjMD['x-amz-server-side-encryption']) {
                        for (let i = 0; i < dataLocator.length; i++) {
                            dataLocator[i].masterKeyId = sourceObjMD
                            ['x-amz-server-side-encryption-aws-kms-key-id'];
                            dataLocator[i].algorithm =
                                sourceObjMD['x-amz-server-side-encryption'];
                        }
                    }
                    return next(null, storeMetadataParams, dataLocator,
                        destBucketMD, destObjMD);
                });
        },
        function goGetData(storeMetadataParams, dataLocator, destBucketMD,
            destObjMD, next) {
            const serverSideEncryption = destBucketMD.getServerSideEncryption();

            // skip if source and dest the same or 0 byte object
            // still send along serverSideEncryption info so algo
            // and masterKeyId stored properly in metadata
            if (sourceIsDestination || dataLocator.length === 0) {
                return next(null, storeMetadataParams, dataLocator, destObjMD,
                    serverSideEncryption, destBucketMD);
            }

            const backendInfoObj = locationConstraintCheck(request,
                storeMetadataParams.metaHeaders, destBucketMD, log);
            if (backendInfoObj.err) {
                return next(backendInfoObj.err);
            }
            const backendInfo = backendInfoObj.backendInfo;

            // dataLocator is an array.  need to get and put all parts
            // For now, copy 1 part at a time. Could increase the second
            // argument here to increase the number of parts
            // copied at once.
            return async.mapLimit(dataLocator, 1,
                // eslint-disable-next-line prefer-arrow-callback
                function copyPart(part, cb) {
                    return data.get(part, log, (err, stream) => {
                        if (err) {
                            return cb(err);
                        }
                        if (serverSideEncryption) {
                            return kms.createCipherBundle(
                            serverSideEncryption,
                            log, (err, cipherBundle) => {
                                if (err) {
                                    log.debug('error getting cipherBundle');
                                    return cb(errors.InternalError);
                                }
                                return data.put(cipherBundle, stream,
                                part.size, dataStoreContext,
                                backendInfo, log,
                                (error, partRetrievalInfo) => {
                                    if (error) {
                                        return cb(error);
                                    }
                                    const partResult = {
                                        key: partRetrievalInfo.key,
                                        dataStoreName: partRetrievalInfo
                                            .dataStoreName,
                                        start: part.start,
                                        size: part.size,
                                        cryptoScheme: cipherBundle
                                            .cryptoScheme,
                                        cipheredDataKey: cipherBundle
                                            .cipheredDataKey,
                                    };
                                    return cb(null, partResult);
                                });
                            });
                        }
                        // Copied object is not encrypted so just put it
                        // without a cipherBundle

                        return data.put(null, stream, part.size,
                        dataStoreContext, backendInfo,
                        log, (error, partRetrievalInfo) => {
                            if (error) {
                                return cb(error);
                            }
                            const partResult = {
                                key: partRetrievalInfo.key,
                                dataStoreName: partRetrievalInfo.
                                    dataStoreName,
                                start: part.start,
                                size: part.size,
                            };
                            return cb(null, partResult);
                        });
                    });
                }, (err, results) => {
                    if (err) {
                        log.debug('error transferring data from source',
                        { error: err });
                        return next(err, destBucketMD);
                    }
                    return next(null, storeMetadataParams, results,
                        destObjMD, serverSideEncryption, destBucketMD);
                });
        },
        function getVersioningInfo(storeMetadataParams, destDataGetInfoArr,
            destObjMD, serverSideEncryption, destBucketMD, next) {
            return versioningPreprocessing(destBucketName,
                destBucketMD, destObjectKey, destObjMD, null, log,
                (err, options) => {
                    if (err) {
                        log.debug('error processing versioning info',
                        { error: err });
                        return next(err, null, destBucketMD);
                    }
                    // eslint-disable-next-line
                    storeMetadataParams.versionId = options.versionId;
                    // eslint-disable-next-line
                    storeMetadataParams.versioning = options.versioning;
                    // eslint-disable-next-line
                    storeMetadataParams.isNull = options.isNull;
                    // eslint-disable-next-line
                    storeMetadataParams.nullVersionId = options.nullVersionId;
                    const dataToDelete = options.dataToDelete;
                    return next(null, storeMetadataParams, destDataGetInfoArr,
                        destObjMD, serverSideEncryption, destBucketMD,
                        dataToDelete);
                });
        },
        function storeNewMetadata(storeMetadataParams, destDataGetInfoArr,
            destObjMD, serverSideEncryption, destBucketMD, dataToDelete, next) {
            return services.metadataStoreObject(destBucketName,
                destDataGetInfoArr, serverSideEncryption,
                storeMetadataParams, (err, result) => {
                    if (err) {
                        log.debug('error storing new metadata', { error: err });
                        return next(err, null, destBucketMD);
                    }
                    // Clean up any potential orphans in data if object
                    // put is an overwrite of already existing
                    // object with same name, so long as the source is not
                    // the same as the destination
                    if (!sourceIsDestination && dataToDelete) {
                        data.batchDelete(dataToDelete,
                                logger.newRequestLoggerFromSerializedUids(
                                    log.getSerializedUids()));
                    }
                    const sourceObjSize = storeMetadataParams.size;
                    const destObjPrevSize = (destObjMD &&
                        destObjMD['content-length'] !== undefined) ?
                        destObjMD['content-length'] : null;
                    return next(null, result, destBucketMD, storeMetadataParams,
                        serverSideEncryption, sourceObjSize, destObjPrevSize);
                });
        },
    ], (err, storingNewMdResult, destBucketMD, storeMetadataParams,
        serverSideEncryption, sourceObjSize, destObjPrevSize) => {
        const corsHeaders = collectCorsHeaders(request.headers.origin,
            request.method, destBucketMD);

        if (err) {
            return callback(err, null, corsHeaders);
        }
        const xml = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<CopyObjectResult>',
            '<LastModified>', new Date(storeMetadataParams.lastModifiedDate)
                .toISOString(), '</LastModified>',
            '<ETag>&quot;', storeMetadataParams.contentMD5, '&quot;</ETag>',
            '</CopyObjectResult>',
        ].join('');
        const additionalHeaders = corsHeaders || {};
        if (serverSideEncryption) {
            additionalHeaders['x-amz-server-side-encryption'] =
                serverSideEncryption.algorithm;
            if (serverSideEncryption.algorithm === 'aws:kms') {
                additionalHeaders
                ['x-amz-server-side-encryption-aws-kms-key-id'] =
                    serverSideEncryption.masterKeyId;
            }
        }
        if (sourceVersionId) {
            additionalHeaders['x-amz-copy-source-version-id'] =
                versionIdUtils.encode(sourceVersionId);
        }
        if (storingNewMdResult && storingNewMdResult.versionId) {
            additionalHeaders['x-amz-version-id'] =
                versionIdUtils.encode(storingNewMdResult.versionId);
        }
        pushMetric('copyObject', log, {
            authInfo,
            bucket: destBucketName,
            newByteLength: sourceObjSize,
            oldByteLength: destObjPrevSize,
        });
        // Add expiration header if lifecycle enabled
        return callback(null, xml, additionalHeaders);
    });
}
