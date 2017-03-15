/* import assert from 'assert';
import { S3 } from 'aws-sdk';
import async from 'async';

import getConfig from '../support/config';

const bucket = `versioning-bucket-${Date.now()}`;
const key = 'anObject';

describe('aws-node-sdk test delete object', function testSuite() {
    this.timeout(600000);
    let s3 = undefined;
    let versionIds = undefined;
    const counter = 100;

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
            console.log('list object versions before deletion', data);
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

    // setup test
    before(done => {
        versionIds = [];
        const config = getConfig('default', { signatureVersion: 'v4' });
        s3 = new S3(config);
        s3.createBucket({ Bucket: bucket }, done);
    });

    // delete bucket after testing
    after(done => {
        // TODO: remove conditional after listing is implemented
        if (process.env.AWS_ON_AIR === 'true') {
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

    it('creating non-versionned object', done => {
        s3.putObject({
            Bucket: bucket,
            Key: key,
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            assert.equal(res.VersionId, undefined);
            return done();
        });
    })

    it('enable versioning', done => {
        const params = {
            Bucket: bucket,
            VersioningConfiguration: {
                Status: 'Enabled',
            },
        };
        s3.putBucketVersioning(params, done);
    });

    it('put a version to the object', done => {
        s3.putObject({
            Bucket: bucket,
            Key: key,
            Body: 'test',
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            versionIds.push('null');
            versionIds.push(res.VersionId);
            assert.notEqual(res.VersionId, undefined);
            return done();
        });
    });

    it('should create a delete marker', done => {
        s3.deleteObject({
            Bucket: bucket,
            Key: key,
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            assert.strictEqual(res.DeleteMarker, 'true');
            assert.strictEqual(versionIds.find(item => item === res.VersionId),
                undefined);
            versionIds.push(res.VersionId);
            return done();
        });
    });

    it('should return 404 with a delete marker', done => {
        s3.getObject({
            Bucket: bucket,
            Key: key,
        }, function (err, res) {
            if (!err) {
                return done(new Error('should return 404'));
            }
            const headers = this.httpResponse.headers;
            assert.strictEqual(headers['x-amz-delete-marker'], 'true');
            return done();
        });
    })

    it('should delete the null version', done => {
        console.log(versionIds);
        const version = versionIds.shift();
        console.log('version:', version);
        s3.deleteObject({
            Bucket: bucket,
            Key: key,
            VersionId: version,
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            assert.strictEqual(res.VersionId, version);
            assert.equal(res.DeleteMarker, undefined);
            return done();
        });
    });

    it('should delete the versionned object', done => {
        const version = versionIds.shift();
        s3.deleteObject({
            Bucket: bucket,
            Key:  key,
            VersionId: version,
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            assert.strictEqual(res.VersionId, version);
            assert.equal(res.DeleteMarker, undefined);
            return done();
        });
    });

    it('should delete the delete-marker version', done => {
        const version = versionIds.shift();
        s3.deleteObject({
            Bucket: bucket,
            Key: key,
            VersionId: version
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            assert.strictEqual(res.VersionId, version);
            assert.equal(res.DeleteMarker, 'true');
            return done();
        });
    });

    it('put a new version', done => {
        s3.putObject({
            Bucket: bucket,
            Key: key,
            Body: 'test',
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            versionIds.push(res.VersionId);
            assert.notEqual(res.VersionId, undefined);
            return done();
        });
    });

    it('get the null version', done => {
        s3.getObject({
            Bucket: bucket,
            Key: key,
            VersionId: 'null',
        }, (err, res) => {
            console.log(err);
            if (!err || err.code !== 'NoSuchVersion') {
                return done(err);
            }
            console.log(res);
            return done();
        });
    });

    it('suspending versioning', done => {
        const params = {
            Bucket: bucket,
            VersioningConfiguration: {
                Status: 'Suspended',
            },
        };
        s3.putBucketVersioning(params, done);
    });

    it('should put a new delete marker', done => {
        s3.deleteObject({
            Bucket: bucket,
            Key: key,
        }, (err, res) => {
            if (err) {
                return done(err);
            }
            assert.strictEqual(res.DeleteMarker, 'true');
            assert.strictEqual(res.VersionId, 'null');
            console.log(res);
            return done();
        });
    });

    it('enabling versioning', done => {
        const params = {
            Bucket: bucket,
            VersioningConfiguration: {
                Status: 'Enabled',
            },
        };
        s3.putBucketVersioning(params, done);
    });

    it('should get the null version', done => {
        s3.getObject({
            Bucket: bucket,
            Key: key,
            VersionId: 'null',
        }, function (err, res) {
            const headers = this.httpResponse.headers;
            assert.strictEqual(headers['x-amz-delete-marker'], 'true');
            assert.strictEqual(headers['x-amz-version-id'], 'null');
            if (err && err.code !== 'MethodNotAllowed') {
                return done(err);
            } else if (err) {
                return done();
            }
            return done(new Error('should return an error'));
        });
    });

    // it('put a new version')

});
*/
