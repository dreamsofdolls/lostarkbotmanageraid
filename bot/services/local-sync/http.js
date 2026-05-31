"use strict";

function createJsonSender({ methods, allowHeaders = "Authorization, Content-Type", extraHeaders = {} }) {
  return function sendJson(res, status, body) {
    const headers = typeof extraHeaders === "function" ? extraHeaders(status) : extraHeaders;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": allowHeaders,
      ...headers,
    });
    res.end(status === 204 ? "" : JSON.stringify(body));
  };
}

function extractBearerToken(req, parsedUrl) {
  const auth = req.headers["authorization"] || "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (match) return match[1].trim();
  return parsedUrl?.query?.token || null;
}

function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBodyBytes) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve({});
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

module.exports = {
  createJsonSender,
  extractBearerToken,
  readJsonBody,
};
