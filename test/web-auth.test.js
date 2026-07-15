const test = require("node:test");
const assert = require("node:assert/strict");

if (typeof global.atob !== "function") {
  global.atob = (value) => Buffer.from(value, "base64").toString("binary");
}

function makeToken(payload) {
  return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

function t(key, params = {}) {
  const labels = {
    "identity.noToken": "No token",
    "identity.noTokenHint": "Open from Discord.",
    "identity.malformed": "Bad token",
    "identity.malformedHint": "Request a new link.",
    "identity.expired": "Expired",
    "identity.expiredHint": "Request a new link.",
    "identity.tokenValid": "token valid for ~{n} min",
    "identity.tokenValidSec": "token valid for ~{n} sec",
    "identity.linked": "Linked",
    "identity.linkedAnonymous": "Linked",
  };
  return (labels[key] || key).replace("{n}", params.n);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeDom() {
  return {
    authStatus: { innerHTML: "" },
    fileSection: { hidden: true },
    windowRef: {},
    timers: [],
  };
}

test("web auth bootstrap renders no-token state without opening file section", async () => {
  const { bootstrapAuthSession } = await import("../web/js/core/auth.js");
  const dom = makeDom();

  const session = bootstrapAuthSession({
    token: null,
    payload: null,
    authStatus: dom.authStatus,
    fileSection: dom.fileSection,
    t,
    escapeHtml,
    windowRef: dom.windowRef,
    setIntervalFn: (fn, ms) => dom.timers.push({ fn, ms }),
  });

  assert.match(dom.authStatus.innerHTML, /No token/);
  assert.equal(dom.fileSection.hidden, true);
  assert.equal(dom.windowRef.__artistSyncToken, undefined);
  assert.equal(dom.timers.length, 0);
  assert.equal(session.updateExpSec(Math.floor(Date.now() / 1000) + 30), false);
});

test("web auth bootstrap decodes valid token, exposes globals, and updates expiry", async () => {
  const { bootstrapAuthSession, decodePayload } = await import("../web/js/core/auth.js");
  const dom = makeDom();
  const nowSec = Math.floor(Date.now() / 1000);
  const token = makeToken({
    discordId: "123",
    exp: nowSec + 120,
    username: "Traine<script>",
    avatarUrl: "",
    lang: "en",
  });
  const payload = decodePayload(token);

  const session = bootstrapAuthSession({
    token,
    payload,
    authStatus: dom.authStatus,
    fileSection: dom.fileSection,
    t,
    escapeHtml,
    windowRef: dom.windowRef,
    setIntervalFn: (fn, ms) => dom.timers.push({ fn, ms }),
  });

  assert.equal(payload.discordId, "123");
  assert.equal(dom.windowRef.__artistSyncToken, token);
  assert.equal(dom.windowRef.__artistDiscordId, "123");
  assert.equal(dom.fileSection.hidden, false);
  assert.match(dom.authStatus.innerHTML, /Linked/);
  assert.match(dom.authStatus.innerHTML, /Traine&lt;script&gt;/);
  assert.equal(dom.timers.length, 1);
  assert.equal(dom.timers[0].ms, 1000);

  assert.equal(session.updateExpSec(nowSec + 30), true);
  assert.match(dom.authStatus.innerHTML, /sec/);
});

test("web auth bootstrap renders expired token without enabling sync globals", async () => {
  const { bootstrapAuthSession, decodePayload } = await import("../web/js/core/auth.js");
  const dom = makeDom();
  const token = makeToken({
    discordId: "123",
    exp: Math.floor(Date.now() / 1000) - 5,
    username: "Traine",
  });

  bootstrapAuthSession({
    token,
    payload: decodePayload(token),
    authStatus: dom.authStatus,
    fileSection: dom.fileSection,
    t,
    escapeHtml,
    windowRef: dom.windowRef,
    setIntervalFn: (fn, ms) => dom.timers.push({ fn, ms }),
  });

  assert.match(dom.authStatus.innerHTML, /Expired/);
  assert.equal(dom.fileSection.hidden, true);
  assert.equal(dom.windowRef.__artistSyncToken, undefined);
  assert.equal(dom.timers.length, 0);
});

test("web auth resolves Solo scope explicitly and keeps legacy tokens on full sync", async () => {
  const { resolveCompanionScope } = await import("../web/js/core/auth.js");

  assert.equal(resolveCompanionScope({ scope: "solo" }), "solo");
  assert.equal(resolveCompanionScope({ scope: "full" }), "full");
  assert.equal(resolveCompanionScope({}), "full");
  assert.equal(resolveCompanionScope(null), "full");
  assert.equal(resolveCompanionScope({ scope: "SOLO" }), "full");
});
