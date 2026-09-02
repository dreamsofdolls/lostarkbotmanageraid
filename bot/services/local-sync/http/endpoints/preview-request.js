"use strict";

const { readAuthenticatedJsonRequest } = require("../request-gates");

const PREVIEW_MAX_BODY_BYTES = 256 * 1024;

async function readAuthenticatedPreviewRequest({ req, res, send }) {
  const request = await readAuthenticatedJsonRequest({
    req,
    res,
    send,
    maxBodyBytes: PREVIEW_MAX_BODY_BYTES,
  });
  if (!request) return null;
  return {
    ...request,
    scope: request.payload.scope,
  };
}

module.exports = {
  readAuthenticatedPreviewRequest,
};
