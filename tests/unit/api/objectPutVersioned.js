import async from 'async';
import assert from 'assert';

import bucketPut from '../../../lib/api/bucketPut';
import bucketPutVersioning from '../../../lib/api/bucketPutVersioning';
import objectPut from '../../../lib/api/objectPut';
import { ds } from '../../../lib/data/in_memory/backend';
import DummyRequest from '../DummyRequest';
import { cleanup, DummyRequestLogger, makeAuthInfo } from '../helpers';

const log = new DummyRequestLogger();
const canonicalID = 'accessKey1';
const authInfo = makeAuthInfo(canonicalID);
const namespace = 'default';
const bucketName = 'bucketname';
const objectName = 'objectName';

const testPutBucketRequest = new DummyRequest({
    bucketName,
    namespace,
    headers: { host: `${bucketName}.s3.amazonaws.com` },
    url: '/',
});

function _createBucketPutVersioningReq(status) {
    const request = {
        bucketName,
        headers: {
            host: `${bucketName}.s3.amazonaws.com`,
        },
        url: '/?versioning',
        query: { versioning: '' },
    };
    const xml = '<VersioningConfiguration ' +
    'xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    `<Status>${status}</Status>` +
    '</VersioningConfiguration>';
    request.post = xml;
    return request;
}

function _createPutObjectRequest(body) {
    const params = {
        bucketName,
        namespace,
        objectKey: objectName,
        headers: {},
        url: `/${bucketName}/${objectName}`,
    };
    return new DummyRequest(params, body);
}

const enableVersioningRequest = _createBucketPutVersioningReq('Enabled');
const suspendVersioningRequest = _createBucketPutVersioningReq('Suspended');

describe('objectPut API with versioning', () => {
    beforeEach(() => {
        cleanup();
    });

    function _assertDataStoreValues(expectedValues) {
        assert.strictEqual(ds.length, expectedValues.length + 1);
        for (let i = 0, j = 1; i < expectedValues.length; i++, j++) {
            if (expectedValues[i] === undefined) {
                assert.strictEqual(ds[j], expectedValues[i]);
            } else {
                assert.deepStrictEqual(ds[j].value, expectedValues[i]);
            }
        }
    }

    it('should delete latest version when creating new null version ' +
    'if latest version is null version', done => {
        let i = 0;
        const objData = ['foo0', 'foo1', 'foo2'].map(str =>
            Buffer.from(str, 'utf8'));
        const testPutObjectRequests = objData.map(data =>
            _createPutObjectRequest(data));
        async.series([
            callback => bucketPut(authInfo, testPutBucketRequest, log,
                callback),
            // putting null version by putting obj before versioning configured
            callback => objectPut(authInfo, testPutObjectRequests[i], undefined,
                log, err => {
                    _assertDataStoreValues(objData.slice(0, i + 1));
                    i++;
                    callback(err);
                }),
            callback => bucketPutVersioning(authInfo, suspendVersioningRequest,
                log, callback),
            // creating new null version by putting obj after ver suspended
            callback => objectPut(authInfo, testPutObjectRequests[i],
                undefined, log, err => {
                    // wait until next tick since mem backend executes
                    // deletes in the next tick
                    process.nextTick(() => {
                        // old null version should be deleted
                        objData[i - 1] = undefined;
                        _assertDataStoreValues(objData.slice(0, i + 1));
                        i++;
                        callback(err);
                    });
                }),
            // create another null version
            callback => objectPut(authInfo, testPutObjectRequests[i],
                undefined, log, err => {
                    // wait until next tick since mem backend executes
                    // deletes in the next tick
                    process.nextTick(() => {
                        // old null version should be deleted
                        objData[i - 1] = undefined;
                        _assertDataStoreValues(objData.slice(0, i + 1));
                        i++;
                        callback(err);
                    });
                }),
        ], err => {
            if (err) {
                return done(err);
            }
            return done();
        });
    });

    it('should delete null version when creating new null version, even ' +
    'when null version is not the latest version', done => {
        let i = 0;
        let nullDataIndex;
        const objData = ['foo0', 'foo1', 'foo2', 'foo3', 'foo4'].map(str =>
            Buffer.from(str, 'utf8'));
        const testPutObjectRequests = objData.map(data =>
            _createPutObjectRequest(data));
        async.series([
            callback => bucketPut(authInfo, testPutBucketRequest, log,
                callback),
            // putting null version by putting obj before versioning configured
            callback => objectPut(authInfo, testPutObjectRequests[i], undefined,
                log, err => {
                    // record index of null version
                    nullDataIndex = i;
                    _assertDataStoreValues(objData.slice(0, i + 1));
                    i++;
                    callback(err);
                }),
            callback => bucketPutVersioning(authInfo, enableVersioningRequest,
                log, callback),
            callback => objectPut(authInfo, testPutObjectRequests[i],
                undefined, log, err => {
                    _assertDataStoreValues(objData.slice(0, i + 1));
                    i++;
                    callback(err);
                }),
            callback => bucketPutVersioning(authInfo, suspendVersioningRequest,
                log, callback),
            // creating new null version by putting obj after ver suspended
            callback => objectPut(authInfo, testPutObjectRequests[i],
                undefined, log, err => {
                    // wait until next tick since mem backend executes
                    // deletes in the next tick
                    process.nextTick(() => {
                        // old null version should be deleted
                        objData[nullDataIndex] = undefined;
                        _assertDataStoreValues(objData.slice(0, i + 1));
                        // record index of current null version
                        nullDataIndex = i;
                        i++;
                        callback(err);
                    });
                }),
            callback => bucketPutVersioning(authInfo, enableVersioningRequest,
                log, callback),
            callback => objectPut(authInfo, testPutObjectRequests[i],
                undefined, log, err => {
                    _assertDataStoreValues(objData.slice(0, i + 1));
                    i++;
                    callback(err);
                }),
            // putting another null version
            callback => bucketPutVersioning(authInfo, suspendVersioningRequest,
                log, callback),
            callback => objectPut(authInfo, testPutObjectRequests[i],
                undefined, log, err => {
                    // wait until next tick since mem backend executes
                    // deletes in the next tick
                    process.nextTick(() => {
                        // old null version should be deleted
                        objData[nullDataIndex] = undefined;
                        _assertDataStoreValues(objData.slice(0, i + 1));
                        callback(err);
                    });
                }),
        ], err => {
            if (err) {
                return done(err);
            }
            return done();
        });
    });
});
