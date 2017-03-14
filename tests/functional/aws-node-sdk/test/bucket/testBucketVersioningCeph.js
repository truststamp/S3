import assert from 'assert';
import { S3 } from 'aws-sdk';

import getConfig from '../support/config';

const bucket = `versioning-bucket-${Date.now()}`;

describe('aws-node-sdk test bucket versioning', function testSuite() {
    this.timeout(600000);
    let s3 = undefined;
    const key = 'foo';
    const versionIds = [];

    // setup test
    before(done => {
        const config = getConfig('default', { signatureVersion: 'v4' });
        s3 = new S3(config);
        s3.createBucket({ Bucket: bucket }, done);
    });

    // delete bucket after testing
    after(done => s3.deleteBucket({ Bucket: bucket }, done));

    it('should create a non-versioned object', done => {
        const params = { Bucket: bucket, Key: key };
        s3.putObject(params, err => {
            assert.strictEqual(err, null);
            s3.getObject(params, err => {
                assert.strictEqual(err, null);
                done();
            });
        });
    });

    it('should accept valid versioning configuration', done => {
        const params = {
            Bucket: bucket,
            VersioningConfiguration: {
                Status: 'Enabled',
            },
        };
        s3.putBucketVersioning(params, done);
    });

    it('should retrieve the valid versioning configuration', done => {
        const params = { Bucket: bucket };
        s3.getBucketVersioning(params, (error, data) => {
            assert.strictEqual(error, null);
            assert.deepStrictEqual(data, { Status: 'Enabled' });
            done();
        });
    });

    it('should create a new version for an object', done => {
        const params = { Bucket: bucket, Key: key };
        s3.putObject(params, (err, data) => {
            assert.strictEqual(err, null);
            const versionId = data.VersionId;
            versionIds.push(data.VersionId);
            delete params.Key;
            s3.listObjectVersions(params, err => {
                assert.strictEqual(err, null);
                params.Key = key;
                params.VersionId = versionId;
                s3.getObject(params, (err, data) => {
                    assert.strictEqual(err, null);
                    assert.strictEqual(params.VersionId, data.VersionId,
                            'version ids are not equal');
                    // TODO compare the value of null version and the original
                    // version when find out how to include value in the put
                    params.VersionId = 'null';
                    s3.getObject(params, done);
                });
            });
        });
    });

    it('should delete all versions of the object', done => {
        const params = { Bucket: bucket, Key: key };
        s3.getObject(params, (err, data) => {
            assert.strictEqual(err, null);
            params.VersionId = data.VersionId;
            s3.deleteObject(params, (err, data) => {
                assert.strictEqual(err, null);
                assert.strictEqual(params.VersionId, data.VersionId);
                // TODO compare the value of null version and the original
                // version when find out how to include value in the put
                params.VersionId = 'null';
                s3.deleteObject(params, done);
            });
        });
    });
});
