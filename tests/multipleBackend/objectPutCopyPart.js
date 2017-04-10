import assert from 'assert';
import async from 'async';
import { parseString } from 'xml2js';

import { cleanup, DummyRequestLogger, makeAuthInfo } from '../unit/helpers';
import { ds } from '../../lib/data/in_memory/backend';
import bucketPut from '../../lib/api/bucketPut';
import initiateMultipartUpload from '../../lib/api/initiateMultipartUpload';
import objectPut from '../../lib/api/objectPut';
import objectPutCopyPart from '../../lib/api/objectPutCopyPart';
import DummyRequest from '../unit/DummyRequest';
import { metadata } from '../../lib/metadata/in_memory/metadata';
import constants from '../../constants';

const splitter = constants.splitter;
const log = new DummyRequestLogger();
const canonicalID = 'accessKey1';
const authInfo = makeAuthInfo(canonicalID);
const namespace = 'default';

const bucketName = 'superbucket9999999';
const sourceObjName = 'supersourceobject';
const destObjName = 'copycatobject';
const mpuBucket = `${constants.mpuBucketPrefix}${bucketName}`;
const body = Buffer.from('I am a body', 'utf8');
function copyPutPart(bucketLoc, mpuLoc, srcObjLoc, requestHost, cb,
errorDescription) {
    const post = bucketLoc ? '<?xml version="1.0" encoding="UTF-8"?>' +
        '<CreateBucketConfiguration ' +
        'xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        `<LocationConstraint>${bucketLoc}</LocationConstraint>` +
        '</CreateBucketConfiguration>' : '';
    const bucketPutReq = new DummyRequest({
        bucketName,
        namespace,
        headers: { host: `${bucketName}.s3.amazonaws.com` },
        url: '/',
        post,
    });
    const initiateReq = {
        bucketName,
        namespace,
        objectKey: destObjName,
        headers: { host: `${bucketName}.s3.amazonaws.com` },
        url: `/${destObjName}?uploads`,
    };
    if (mpuLoc) {
        initiateReq.headers = { 'host': `${bucketName}.s3.amazonaws.com`,
            'x-amz-meta-scal-location-constraint': `${mpuLoc}` };
    }
    if (requestHost) {
        initiateReq.parsedHost = requestHost;
    }
    const sourceObjPutParams = {
        bucketName,
        namespace,
        objectKey: sourceObjName,
        headers: { host: `${bucketName}.s3.amazonaws.com` },
        url: '/',
    };
    if (srcObjLoc) {
        sourceObjPutParams.headers = { 'host': `${bucketName}.s3.amazonaws.com`,
            'x-amz-meta-scal-location-constraint': `${srcObjLoc}` };
    }
    const sourceObjPutReq = new DummyRequest(sourceObjPutParams, body);
    if (requestHost) {
        sourceObjPutReq.parsedHost = requestHost;
    }

    async.waterfall([
        next => {
            bucketPut(authInfo, bucketPutReq, log, err => {
                assert.ifError(err, 'Error putting bucket');
                next(err);
            });
        },
        next => {
            objectPut(authInfo, sourceObjPutReq, undefined, log, err =>
                next(err));
        },
        next => {
            initiateMultipartUpload(authInfo, initiateReq, log, next);
        },
        (result, corsHeaders, next) => {
            const mpuKeys = metadata.keyMaps.get(mpuBucket);
            assert.strictEqual(mpuKeys.size, 1);
            assert(mpuKeys.keys().next().value
                .startsWith(`overview${splitter}${destObjName}`));
            parseString(result, next);
        },
    ],
    (err, json) => {
        if (errorDescription) {
            assert.strictEqual(err.code, 400);
            assert(err.InvalidArgument);
            assert(err.description.indexOf(errorDescription) > -1);
            return cb();
        }
        // Need to build request in here since do not have
        // uploadId until here
        assert.ifError(err, 'Error putting source object or initiate MPU');
        const testUploadId = json.InitiateMultipartUploadResult.
            UploadId[0];
        const copyPartParams = {
            bucketName,
            namespace,
            objectKey: destObjName,
            headers: { host: `${bucketName}.s3.amazonaws.com` },
            url: `/${destObjName}?partNumber=1&uploadId=${testUploadId}`,
            query: {
                partNumber: '1',
                uploadId: testUploadId,
            },
        };
        const copyPartReq = new DummyRequest(copyPartParams);
        return objectPutCopyPart(authInfo, copyPartReq,
            bucketName, sourceObjName, undefined, log, err => {
                assert.strictEqual(err, null);
                cb();
            });
    });
}

describe('ObjectCopyPutPart API with multiple backends', () => {
    beforeEach(() => {
        cleanup();
    });

    it('should return err InvalidArgument if no host and data backend ' +
    'set to "multiple"', done => {
        copyPutPart('file', 'mem', null, null, () => done(), 'Endpoint ' +
        'Location Error');
    });

    it('should copy part to mem based on mpu location', done => {
        copyPutPart('file', 'mem', null, 'localhost', () => {
            // object info is stored in ds beginning at index one,
            // so an array length of two means only one object
            // was stored in mem
            assert.strictEqual(ds.length, 2);
            assert.deepStrictEqual(ds[1].value, body);
            done();
        });
    });

    it('should copy part to file based on mpu location', done => {
        copyPutPart('mem', 'file', null, 'localhost', () => {
            assert.strictEqual(ds.length, 2);
            done();
        });
    });

    it('should copy part to AWS based on mpu location', done => {
        copyPutPart('mem', 'aws-test', null, 'localhost', () => {
            assert.strictEqual(ds.length, 2);
            done();
        });
    });

    it('should copy part to mem based on bucket location', done => {
        copyPutPart('mem', null, null, 'localhost', () => {
            // ds length should be three because both source
            // and copied objects should be in mem
            assert.strictEqual(ds.length, 3);
            assert.deepStrictEqual(ds[2].value, body);
            done();
        });
    });

    it('should copy part to file based on bucket location', done => {
        copyPutPart('file', null, null, 'localhost', () => {
            // ds should be empty because both source and
            // coped objects should be in file
            assert.deepStrictEqual(ds, []);
            done();
        });
    });

    it('should copy part to AWS based on bucket location', done => {
        copyPutPart('aws-test', null, null, 'localhost', () => {
            assert.deepStrictEqual(ds, []);
            done();
        });
    });

    it('should copy part to file based on request endpoint', done => {
        copyPutPart(null, null, 'mem', 'localhost', () => {
            assert.strictEqual(ds.length, 2);
            done();
        });
    });
});
