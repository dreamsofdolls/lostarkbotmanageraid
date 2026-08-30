"use strict";

const { SECURITY_HEADERS } = require("./security-headers");

function createJsonSender({ methods, allowHeaders = "Authorization, Content-Type", extraHeaders = {} }) {
  return function sendJson(res, status, body) {
    const headers = typeof extraHeaders === "function" ? extraHeaders(status) : extraHeaders;
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": allowHeaders,
      ...headers,
    });
    res.end(status === 204 ? "" : JSON.stringify(body));
  };
}

function extractBearerToken(req) {
  const auth = req.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match) return match[1].trim();
  return null;
}

function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    let tooLarge = false;
    const chunks = [];

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("aborted", () => fail(Object.assign(new Error("request aborted"), { status: 400 })));
    req.on("error", fail);

    const contentLength = Number(req.headers?.["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      tooLarge = true;
      req.resume?.();
      fail(Object.assign(new Error("body too large"), { status: 413 }));
      return;
    }

    req.on("data", (chunk) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        // Keep draining the request. Destroying the socket here prevents the
        // handler from delivering its structured 413 response to the client.
        fail(Object.assign(new Error("body too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        const parsed = raw ? JSON.parse(raw) : {};
        settled = true;
        resolve(parsed);
      } catch {
        fail(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
  });
}

module.exports = {
  createJsonSender,
  extractBearerToken,
  readJsonBody,
};
