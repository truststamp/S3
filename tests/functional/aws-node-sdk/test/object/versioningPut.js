import assert from 'assert';
import { S3 } from 'aws-sdk';
import async from 'async';

import getConfig from '../support/config';

const bucket = `versioning-bucket-${Date.now()}`;
const key = '/';
const versioningEnabled = { Status: 'Enabled' };
const versioningSuspended = { Status: 'Suspended' };
const config = getConfig('default', { signatureVersion: 'v4' });
const s3 = new S3(config);

function _assertNoError(err, desc) {
    assert.strictEqual(err, null, `Unexpected err ${desc}: ${err}`);
}
function getParams() {
    return { Bucket: bucket, Key: key };
}

function _deleteVersionList(versionList, bucket, callback) {
    async.each(versionList, (versionInfo, cb) => {
        const versionId = versionInfo.VersionId;
        const params = { Bucket: bucket, Key: versionInfo.Key,
        VersionId: versionId };
        s3.deleteObject(params, cb);
    }, callback);
}

function _removeAllVersions(bucket, callback) {
    return s3.listObjectVersions({ Bucket: bucket }, (err, data) => {
        // console.log('list object versions before deletion', data);
        if (err) {
            callback(err);
        }
        return _deleteVersionList(data.DeleteMarkers, bucket, err => {
            if (err) {
                callback(err);
            }
            _deleteVersionList(data.Versions, bucket, callback);
        });
    });
}

describe('aws-node-sdk test object versioning', function testSuite() {
    this.timeout(600000);
    const counter = 100;

    before(done => {
        s3.createBucket({ Bucket: bucket }, done);
    });

    afterEach(done => {
        // TODO: remove conditional after listing is implemented
        if (process.env.AWS_ON_AIR) {
            return _removeAllVersions(bucket, err => {
                if (err) {
                    return done(err);
                }
                return s3.deleteBucket({ Bucket: bucket }, err => {
                    assert.strictEqual(err, null,
                        `Error deleting bucket: ${err}`);
                    return done();
                });
            });
        }
        return done();
    });

    it('should create a non-versioned object', done => {
        const params = { Bucket: bucket, Key: key };
        s3.putObject(params, (err, data) => {
            _assertNoError(err, 'putting object');
            assert.strictEqual(data.VersionId, undefined);
            s3.getObject(params, err => {
                _assertNoError(err, 'getting object');
                assert.strictEqual(data.VersionId, undefined);
                done();
            });
        });
    });

    describe('on a version-enabled bucket', () => {
        beforeEach(done => {
            s3.putBucketVersioning({
                Bucket: bucket,
                VersioningConfiguration: versioningEnabled,
            }, done);
        });

        it('should create a new version for an object', done => {
            const params = getParams();
            s3.putObject(params, (err, data) => {
                _assertNoError(err, 'putting object');
                params.VersionId = data.VersionId;
                s3.getObject(params, (err, data) => {
                    _assertNoError(err, 'getting object');
                    assert.strictEqual(params.VersionId, data.VersionId,
                            'version ids are not equal');
                    done();
                });
            });
        });
    });

    describe('on a version-enabled bucket with non-versioned object', () => {
        const data = ['foo1', 'foo2'];
        const eTags = [];

        beforeEach(done => {
            s3.putObject({ Bucket: bucket, Key: key, Body: data[0] },
                (err, data) => {
                    if (err) {
                        done(err);
                    }
                    eTags.push(data.ETag);
                    s3.putBucketVersioning({
                        Bucket: bucket,
                        VersioningConfiguration: versioningEnabled,
                    }, done);
                });
        });

        afterEach(done => {
            // reset eTags
            eTags.length = 0;
            done();
        });

        it('should get null version in versioning enabled bucket',
        done => {
            const paramsNull = { Bucket: bucket, Key: '/', VersionId: 'null' };
            s3.getObject(paramsNull, err => {
                _assertNoError(err, 'getting null version');
                done();
            });
        });

        it('should keep null version and create a new version for an object',
        done => {
            const params = { Bucket: bucket, Key: key, Body: data[1] };
            s3.putObject(params, (err, data) => {
                const newVersion = data.VersionId;
                eTags.push(data.ETag);
                s3.getObject({ Bucket: bucket, Key: key,
                    VersionId: newVersion }, (err, data) => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(data.VersionId, newVersion,
                        'version ids are not equal');
                    assert.strictEqual(data.ETag, eTags[1]);
                    s3.getObject({ Bucket: bucket, Key: key,
                    VersionId: 'null' }, (err, data) => {
                        _assertNoError(err, 'getting null version');
                        assert.strictEqual(data.VersionId, 'null');
                        assert.strictEqual(data.ETag, eTags[0]);
                        done();
                    });
                });
            });
        });

        it('should create new versions but still keep nullVersionId',
        done => {
            const versionIds = [];
            const params = { Bucket: bucket, Key: key };
            const paramsNull = { Bucket: bucket, Key: key, VersionId: 'null' };
            // create new versions
            async.timesSeries(counter, (i, next) => s3.putObject(params,
                (err, data) => {
                    versionIds.push(data.VersionId);
                    // get the 'null' version
                    s3.getObject(paramsNull, (err, nullVerData) => {
                        assert.strictEqual(err, null);
                        assert.strictEqual(nullVerData.ETag, eTags[0]);
                        assert.strictEqual(nullVerData.VersionId, 'null');
                        next(err);
                    });
                }), done);
        });
    });

    describe('on version-suspended bucket', () => {
        beforeEach(done => {
            s3.putBucketVersioning({
                Bucket: bucket,
                VersioningConfiguration: versioningSuspended,
            }, done);
        });

        it('should not return version id for new object', done => {
            const params = { Bucket: bucket, Key: key, Body: 'foo' };
            const paramsNull = { Bucket: bucket, Key: key, VersionId: 'null' };
            s3.putObject(params, (err, data) => {
                const eTag = data.ETag;
                _assertNoError(err, 'putting object');
                assert.strictEqual(data.VersionId, undefined);
                // getting null version should return object we just put
                s3.getObject(paramsNull, (err, nullVerData) => {
                    _assertNoError(err, 'getting null version');
                    assert.strictEqual(nullVerData.ETag, eTag);
                    assert.strictEqual(nullVerData.VersionId, 'null');
                    done();
                });
            });
        });
    });

    describe('on a version-suspended bucket with non-versioned object', () => {
        const eTags = [];
        const data = ['test'];

        beforeEach(done => {
            s3.putObject({ Bucket: bucket, Key: key, Body: data[0] },
                (err, data) => {
                    if (err) {
                        done(err);
                    }
                    eTags.push(data.ETag);
                    s3.putBucketVersioning({
                        Bucket: bucket,
                        VersioningConfiguration: versioningSuspended,
                    }, done);
                });
        });

        it('should get null version in versioning suspended bucket',
        done => {
            const paramsNull = { Bucket: bucket, Key: '/', VersionId: 'null' };
            s3.getObject(paramsNull, err => {
                _assertNoError(err, 'getting null version');
                done();
            });
        });

        it('should update null version in versioning suspended bucket',
        done => {
            const params = { Bucket: bucket, Key: '/' };
            const paramsNull = { Bucket: bucket, Key: '/', VersionId: 'null' };
            async.waterfall([
                callback => s3.getObject(paramsNull, (err, data) => {
                    assert.strictEqual(data.VersionId, 'null');
                    _assertNoError(err, 'getting null version');
                    callback();
                }),
                callback => s3.putObject(params, (err, data) => {
                    _assertNoError(err, 'putting object');
                    assert.strictEqual(data.VersionId, undefined);
                    eTags.push(data.ETag);
                    callback();
                }),
                callback => s3.getObject(paramsNull, (err, data) => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(data.VersionId, 'null');
                    assert.strictEqual(data.ETag, eTags[1],
                        'wrong object data');
                    callback();
                }),
                callback => s3.getObject(params, (err, data) => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(data.VersionId, 'null');
                    assert.strictEqual(data.ETag, eTags[1],
                        'wrong object data');
                    callback();
                }),
            ], done);
        });
    });

    /* it('should enable versioning and preserve the null version', done => {
        const paramsVersioning = {
            Bucket: bucket,
            VersioningConfiguration: {
                Status: 'Enabled',
            },
        };
        const params = { Bucket: bucket, Key: '/' };
        const paramsNull = { Bucket: bucket, Key: '/', VersionId: 'null' };
        let nullVersionId = undefined;
        async.waterfall([
            callback => s3.getObject(paramsNull, (err, data) => {
                assert.strictEqual(err, null);
                nullVersionId = data.VersionId;
                callback();
            }),
            callback => s3.putBucketVersioning(paramsVersioning,
                err => callback(err)),
            callback => async.timesSeries(counter, (i, next) =>
                s3.putObject(params, (err, data) => {
                    assert.strictEqual(err, null);
                    versionIds.push(data.VersionId);
                    next();
                }), err => callback(err)),
            callback => s3.getObject(paramsNull, (err, data) => {
                assert.strictEqual(err, null);
                assert.strictEqual(nullVersionId, data.VersionId,
                        'version ids are not equal');
                callback();
            }),
        ], done);
    }); */

    /* it('should create a bunch of objects and their versions', done => {
        const vids = [];
        const keycount = 50;
        const versioncount = 20;
        const value = '{"foo":"bar"}';
        async.times(keycount, (i, next1) => {
            const key = `foo${i}`;
            const params = { Bucket: bucket, Key: key, Body: value };
            async.times(versioncount, (j, next2) =>
                s3.putObject(params, (err, data) => {
                    assert.strictEqual(err, null);
                    assert(data.VersionId, 'invalid versionId');
                    vids.push({ Key: key, VersionId: data.VersionId });
                    next2();
                }), next1);
        }, err => {
            assert.strictEqual(err, null);
            assert.strictEqual(vids.length, keycount * versioncount);
            // TODO use delete marker and check with the result
            process.stdout.write('creating objects done, now deleting...');
            done();
        });
    }); */
});
