import { S3 } from 'aws-sdk';
import assert from 'assert';

import getConfig from '../support/config';
import { generateCorsParams } from '../../lib/utility/cors-util';

const config = getConfig('default', { signatureVersion: 'v4' });
const s3 = new S3(config);

const bucket = 'bucketcorsrequestmethod';
const objectKey = 'objectKeyName';
const allowedOrigin = 'http://www.allowedwebsite.com';

const corsHeaders = {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-methods': 'GET',
    'access-control-allow-credentials': 'true',
    'vary': 'Origin, Access-Control-Request-Headers, ' +
        'Access-Control-Request-Method',
};

function _customS3Request(action, params, requestHeaders, callback) {
    const method = action.bind(s3);
    const request = method(params);
    // modify underlying http request object created by aws sdk to add
    // custom headers
    request.on('build', () => {
        Object.assign(request.httpRequest.headers, requestHeaders);
    });
    request.on('success', response => {
        const resData = {
            statusCode: response.httpResponse.statusCode,
            headers: response.httpResponse.headers,
            body: response.httpResponse.body.toString('utf8'),
        };
        callback(null, resData);
    });
    request.on('error', err => {
        const resData = {
            statusCode: request.response.httpResponse.statusCode,
            headers: request.response.httpResponse.headers,
            body: request.response.httpResponse.body.toString('utf8'),
        };
        callback(err, resData);
    });
    request.send();
}

function _putObjectAndAssertCorsHeaders(expectCorsHeaders, customHeaders, cb) {
    const params = { Bucket: bucket, Key: objectKey };
    _customS3Request(s3.putObject, params, customHeaders, (err, res) => {
        assert.strictEqual(err, null,
            `Expected no err but got ${err}`);
        assert.strictEqual(res.statusCode, 200,
            `Expected status code 200 but got ${res.statusCode}`);
        if (expectCorsHeaders) {
            Object.keys(corsHeaders).forEach(header => {
                assert.strictEqual(res.headers[header],
                corsHeaders[header],
                `Unexpected value for ${header}: ` +
                `${res.headers[header]}`);
            });
        } else {
            Object.keys(corsHeaders).forEach(header => {
                assert.strictEqual(res.headers[header], undefined,
                `Expected no ${header} value ` +
                `but got ${res.headers[header]}`);
            });
        }
        cb();
    });
}

describe('S3 API requests + \'Access-Control-Request-Method\' header', () => {
    beforeEach(done => {
        s3.createBucket({ Bucket: bucket }, done);
    });

    describe('on bucket with CORS configuration only allowing \'GET\' method',
    () => {
        const corsParams = generateCorsParams(bucket, {
            allowedMethods: ['GET'],
            allowedOrigins: [allowedOrigin],
        });

        beforeEach(done => s3.putBucketCors(corsParams, done));

        it('should not respond with CORS headers to PUT object normally',
        done => {
            _putObjectAndAssertCorsHeaders(false, {}, done);
        });

        it('should not respond with CORS headers if PUT object with request ' +
        'header \'Access-Control-Request-Method\': \'DELETE\'', done => {
            const customHeaders = {
                'origin': allowedOrigin,
                'access-control-request-method': 'DELETE',
            };
            _putObjectAndAssertCorsHeaders(false, customHeaders, done);
        });

        it('should respond with CORS headers if PUT object with request ' +
        'header \'Access-Control-Request-Method\': \'GET\'', done => {
            const customHeaders = {
                'origin': allowedOrigin,
                'access-control-request-method': 'GET',
            };
            _putObjectAndAssertCorsHeaders(true, customHeaders, done);
        });
    });
});
