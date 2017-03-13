import querystring from 'querystring';
import constants from '../../constants';

import services from '../services';
import collectCorsHeaders from '../utilities/collectCorsHeaders';
import escapeForXML from '../utilities/escapeForXML';
import { pushMetric } from '../utapi/utilities';
import { errors } from 'arsenal';

//	Sample XML response:
/*	<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>example-bucket</Name>
  <Prefix></Prefix>
  <Marker></Marker>
  <MaxKeys>1000</MaxKeys>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents>
    <Key>sample.jpg</Key>
    <LastModified>2011-02-26T01:56:20.000Z</LastModified>
    <ETag>&quot;bf1d737a4d46a19f3bced6905cc8b902&quot;</ETag>
    <Size>142863</Size>
    <Owner>
      <ID>canonical-user-id</ID>
      <DisplayName>display-name</DisplayName>
    </Owner>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <CommonPrefixes>
    <Prefix>photos/</Prefix>
  </CommonPrefixes>
</ListBucketResult>*/

function processVersions(bucketName, listParams, list) {
    const xml = [];
    xml.push(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
        '<Name>', bucketName, '</Name>'
    );
    const isTruncated = list.IsTruncated ? 'true' : 'false';
    const xmlParams = [
        { tag: 'Prefix', value: listParams.prefix },
        { tag: 'KeyMarker', value: listParams.keyMarker },
        { tag: 'VersionIdMarker', value: listParams.versionIdMarker },
        { tag: 'NextKeyMarker', value: list.NextMarker },
        { tag: 'NextVersionIdMarker', value: list.NextVersionIdMarker },
        { tag: 'MaxKeys', value: listParams.maxKeys },
        { tag: 'Delimiter', value: listParams.delimiter },
        { tag: 'EncodingType', value: listParams.encoding },
        { tag: 'IsTruncated', value: isTruncated },
    ];

    const escapeXmlFn = listParams.encoding === 'url' ?
        querystring.escape : escapeForXML;
    xmlParams.forEach(p => {
        if (p.value) {
            xml.push(`<${p.tag}>${escapeXmlFn(p.value)}</${p.tag}>`);
        }
    });

    let lastKey = listParams.keyMarker;
    list.Versions.forEach(item => {
        const v = JSON.parse(item.value);
        const objectKey = escapeXmlFn(item.key);
        const isLatest = lastKey !== objectKey;
        lastKey = objectKey;
        xml.push(
            v.isDeleteMarker ? '<DeleteMarker>' : '<Version>',
            `<Key>${objectKey}</Key>`,
            '<VersionId>', v.isNull ? 'null' : v.versionId, '</VersionId>',
            `<IsLatest>${isLatest}</IsLatest>`,
            `<LastModified>${v['last-modified']}</LastModified>`,
            `<ETag>&quot;${v['content-md5']}&quot;</ETag>`,
            `<Size>${v['content-length']}</Size>`,
            '<Owner>',
            `<ID>${v['owner-id']}</ID>`,
            `<DisplayName>${v['owner-display-name']}</DisplayName>`,
            '</Owner>',
            `<StorageClass>${v['x-amz-storage-class']}</StorageClass>`,
            v.isDeleteMarker ? '</DeleteMarker>' : '</Version>'
        );
    });
    list.CommonPrefixes.forEach(item => {
        const val = escapeXmlFn(item);
        xml.push(`<CommonPrefixes><Prefix>${val}</Prefix></CommonPrefixes>`);
    });
    xml.push('</ListVersionsResult>');
    return xml.join('');
}

function processMasterVersions(bucketName, listParams, list) {
    const xml = [];
    xml.push(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
        '<Name>', bucketName, '</Name>'
    );
    const isTruncated = list.IsTruncated ? 'true' : 'false';
    const xmlParams = [
        { tag: 'Prefix', value: listParams.prefix },
        { tag: 'Marker', value: listParams.marker },
        { tag: 'NextMarker', value: list.NextMarker },
        { tag: 'MaxKeys', value: listParams.maxKeys },
        { tag: 'Delimiter', value: listParams.delimiter },
        { tag: 'EncodingType', value: listParams.encoding },
        { tag: 'IsTruncated', value: isTruncated },
    ];

    const escapeXmlFn = listParams.encoding === 'url' ?
        querystring.escape : escapeForXML;
    xmlParams.forEach(p => {
        if (p.value) {
            xml.push(`<${p.tag}>${escapeXmlFn(p.value)}</${p.tag}>`);
        }
    });

    list.Contents.forEach(item => {
        const v = JSON.parse(item.value);
        if (v.isDeleteMarker) {
            return null;
        }
        const objectKey = escapeXmlFn(item.key);
        return xml.push(
            '<Contents>',
            `<Key>${objectKey}</Key>`,
            `<LastModified>${v['last-modified']}</LastModified>`,
            `<ETag>&quot;${v['content-md5']}&quot;</ETag>`,
            `<Size>${v['content-length']}</Size>`,
            '<Owner>',
            `<ID>${v['owner-id']}</ID>`,
            `<DisplayName>${v['owner-display-name']}</DisplayName>`,
            '</Owner>',
            `<StorageClass>${v['x-amz-storage-class']}</StorageClass>`,
            '</Contents>'
        );
    });
    list.CommonPrefixes.forEach(item => {
        const val = escapeXmlFn(item);
        xml.push(`<CommonPrefixes><Prefix>${val}</Prefix></CommonPrefixes>`);
    });
    xml.push('</ListBucketResult>');
    return xml.join('');
}

/**
 * bucketGet - Return list of objects in bucket
 * @param  {AuthInfo} authInfo - Instance of AuthInfo class with
 *                               requester's info
 * @param  {object} request - http request object
 * @param  {function} log - Werelogs request logger
 * @param  {function} callback - callback to respond to http request
 *  with either error code or xml response body
 * @return {undefined}
 */
export default function bucketGet(authInfo, request, log, callback) {
    log.debug('processing request', { method: 'bucketGet' });
    const params = request.query;
    const bucketName = request.bucketName;
    const encoding = params['encoding-type'];
    if (encoding !== undefined && encoding !== 'url') {
        return callback(errors.InvalidArgument.customizeDescription('Invalid ' +
            'Encoding Method specified in Request'));
    }
    const escapeXmlFn = encoding === 'url' ? querystring.escape : escapeForXML;
    const requestMaxKeys = params['max-keys'] ?
        Number.parseInt(params['max-keys'], 10) : 1000;
    if (Number.isNaN(requestMaxKeys) || requestMaxKeys < 0) {
        return callback(errors.InvalidArgument);
    }
    // AWS only returns 1000 keys even if max keys are greater.
    // Max keys stated in response xml can be greater than actual
    // keys returned.
    const actualMaxKeys = Math.min(constants.listingHardLimit, requestMaxKeys);

    const metadataValParams = {
        authInfo,
        bucketName,
        requestType: 'bucketGet',
        log,
    };
    const listParams = {
        maxKeys: actualMaxKeys,
        delimiter: params.delimiter,
        marker: params.marker,
        prefix: params.prefix,
    };

    services.metadataValidateAuthorization(metadataValParams, (err, bucket) => {
        const corsHeaders = collectCorsHeaders(request.headers.origin,
            request.method, bucket);
        if (err) {
            log.debug('error processing request', { error: err });
            return callback(err, null, corsHeaders);
        }
        if (bucket.getVersioningConfiguration()) {
            if (params.versions !== undefined) {
                listParams.listingType = 'allversions';
                listParams.marker = params['key-marker'];
                listParams.keyMarker = params['key-marker'];
                listParams.versionIdMarker = params['version-id-marker'];
                if (listParams.marker !== undefined) {
                    listParams.marker += listParams.versionIdMarker ?
                        `\0${listParams.versionIdMarker}` :
                        String.fromCharCode(1);
                }
            } else {
                listParams.listingType = 'masterversions';
            }
        }
        return services.getObjectListing(bucketName, listParams, log,
        (err, list) => {
            if (err) {
                log.debug('error processing request', { error: err });
                return callback(err, null, corsHeaders);
            }
            if (listParams.listingType === 'allversions') {
                pushMetric('listBucket', log, { authInfo, bucket: bucketName });
                listParams.maxKeys = requestMaxKeys;
                listParams.encoding = encoding;
                const res = processVersions(bucketName, listParams, list);
                return callback(null, res, corsHeaders);
            } else if (listParams.listingType === 'masterversions') {
                pushMetric('listBucket', log, { authInfo, bucket: bucketName });
                listParams.maxKeys = requestMaxKeys;
                listParams.encoding = encoding;
                const res = processMasterVersions(bucketName, listParams, list);
                return callback(null, res, corsHeaders);
            }
            const xml = [];
            xml.push(
                '<?xml version="1.0" encoding="UTF-8"?>',
                '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/' +
                    '2006-03-01/">',
                `<Name>${bucketName}</Name>`
            );
            const isTruncated = list.IsTruncated ? 'true' : 'false';
            const xmlParams = [
                { tag: 'Prefix', value: listParams.prefix },
                { tag: 'NextMarker', value: list.NextMarker },
                { tag: 'Marker', value: listParams.marker },
                { tag: 'MaxKeys', value: requestMaxKeys },
                { tag: 'Delimiter', value: listParams.delimiter },
                { tag: 'EncodingType', value: encoding },
                { tag: 'IsTruncated', value: isTruncated },
            ];

            xmlParams.forEach(p => {
                if (p.value) {
                    xml.push(`<${p.tag}>${escapeXmlFn(p.value)}</${p.tag}>`);
                } else if (p.tag !== 'NextMarker' &&
                           p.tag !== 'EncodingType' &&
                           p.tag !== 'Delimiter') {
                    xml.push(`<${p.tag}/>`);
                }
            });

            list.Contents.forEach(item => {
                const v = item.value;
                const objectKey = escapeXmlFn(item.key);

                xml.push(
                    '<Contents>',
                    `<Key>${objectKey}</Key>`,
                    `<LastModified>${v.LastModified}</LastModified>`,
                    `<ETag>&quot;${v.ETag}&quot;</ETag>`,
                    `<Size>${v.Size}</Size>`,
                    '<Owner>',
                    `<ID>${v.Owner.ID}</ID>`,
                    `<DisplayName>${v.Owner.DisplayName}</DisplayName>`,
                    '</Owner>',
                    `<StorageClass>${v.StorageClass}</StorageClass>`,
                    '</Contents>'
                );
            });
            list.CommonPrefixes.forEach(item => {
                const val = escapeXmlFn(item);
                xml.push(
                    `<CommonPrefixes><Prefix>${val}</Prefix></CommonPrefixes>`
                );
            });
            xml.push('</ListBucketResult>');
            pushMetric('listBucket', log, {
                authInfo,
                bucket: bucketName,
            });
            return callback(null, xml.join(''), corsHeaders);
        });
    });
    return undefined;
}
