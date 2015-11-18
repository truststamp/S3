import { Readable } from 'stream';

import utils from '../utils';
import { checkAuth } from '../auth/checkAuth';
import serviceGet from '../api/serviceGet';
import bucketGet from '../api/bucketGet';
import objectGet from '../api/objectGet';
import bucketGetACL from '../api/bucketGetACL';
import objectGetACL from '../api/objectGetACL';

export default function routerGET(request, response, datastore, metastore) {
    utils.normalizeRequest(request);
    checkAuth(request, function checkAuthRes(err, accessKey) {
        if (err) {
            return utils.errorXmlResponse(response, err);
        }

        const resourceRes = utils.getResourceNames(request);
        const bucketname = resourceRes.bucket;
        const objectKey = resourceRes.object;

        if (bucketname === undefined && objectKey === undefined) {
            // GET service
            serviceGet(accessKey, metastore, request, (err, xml) => {
                if (err) {
                    return utils.errorXmlResponse(response, err);
                }
                return utils.okXmlResponse(response, xml);
            });
        } else if (objectKey === undefined) {
            // GET bucket ACL
            if (request.query.acl !== undefined) {
                console.log("getting bucket acl");
                bucketGetACL(accessKey, metastore, request, (err, xml) => {
                    if (err) {
                        console.log("err from get bucket acl", err);
                        return utils.errorXmlResponse(response, err);
                    }
                    return utils.okXmlResponse(response, xml);
                });
            } else {
                // GET bucket
                bucketGet(accessKey, metastore, request, (err, xml) => {
                    if (err) {
                        return utils.errorXmlResponse(response, err);
                    }
                    return utils.okXmlResponse(response, xml);
                });
            }
        } else {
            if (request.query.acl !== undefined) {
                console.log("getting object acl");
                objectGetACL(accessKey, metastore, request, (err, xml) => {
                    if (err) {
                        console.log("err from get object acl", err);
                        return utils.errorXmlResponse(response, err);
                    }
                    return utils.okXmlResponse(response, xml);
                });
            } else {
                objectGet(accessKey, datastore, metastore, request,
                    function objectGetRes(err, result, responseMetaHeaders) {
                        if (err) {
                            return utils.errorXmlResponse(response, err);
                        }

                        const readStream = new Readable;
                        result.forEach((val) => {
                            readStream.push(val);
                        });
                        // signal end of stream
                        readStream.push(null);
                        utils.buildSuccessResponse(request.lowerCaseHeaders,
                                response, responseMetaHeaders);
                        readStream.pipe(response, { end: false });
                        readStream.on('end', function readStreamRes() {
                            response.end();
                        });
                    }
                );
            }
        }
    });
}