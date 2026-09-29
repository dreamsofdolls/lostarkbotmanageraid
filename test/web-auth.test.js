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
    "identity.linkValid": "link valid for {n} min",
    "identity.linkValidSec": "link valid for {n} sec",
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
    whoEl: { innerHTML: "", dataset: {} },
    windowRef: {},
    timers: [],
  };
}

function bootstrap(bootstrapAuthSession, dom, options) {
  return bootstrapAuthSession({
    whoEl: dom.whoEl,
    t,
    escapeHtml,
    windowRef: dom.windowRef,
    setIntervalFn: (fn, ms) => {
      dom.timers.push({ fn, ms });
      return dom.timers.length;
    },
    clearIntervalFn: (id) => {
      dom.timers[id - 1].cleared = true;
    },
    ...options,
  });
}

test("web auth bootstrap reports a missing token without exposing sync globals", async () => {
  const { bootstrapAuthSession } = await import("../web/js/core/auth.js");
  const dom = makeDom();

  const session = bootstrap(bootstrapAuthSession, dom, { token: null, payload: null });

  assert.equal(session.state.kind, "noToken");
  assert.equal(dom.whoEl.innerHTML, "");
  assert.equal(dom.windowRef.__artistSyncToken, undefined);
  assert.equal(dom.timers.length, 0);
});

test("web auth bootstrap decodes valid token, names the user and exposes globals", async () => {
  const { bootstrapAuthSession, decodePayload } = await import("../web/js/core/auth.js");
  const dom = makeDom();
  const nowSec = Math.floor(Date.now() / 1000);
  const token = makeToken({
    discordId: "123",
    exp: nowSec + 120,
    username: "Traine<script>",
    lang: "en",
  });
  const payload = decodePayload(token);

  const session = bootstrap(bootstrapAuthSession, dom, { token, payload });

  assert.equal(session.state.kind, "ok");
  assert.equal(dom.windowRef.__artistSyncToken, token);
  assert.equal(dom.windowRef.__artistDiscordId, "123");
  assert.match(dom.whoEl.innerHTML, /<b>Traine&lt;script&gt;<\/b>/);
  assert.match(dom.whoEl.innerHTML, /link valid for [12] min/);
  assert.equal(dom.timers.length, 1);
  assert.equal(dom.timers[0].ms, 1000);
});

test("web auth tells the page once when a valid link runs out", async () => {
  const { bootstrapAuthSession, decodePayload } = await import("../web/js/core/auth.js");
  const dom = makeDom();
  const token = makeToken({ discordId: "123", exp: Math.floor(Date.now() / 1000) + 1 });
  let expiredCalls = 0;

  const session = bootstrap(bootstrapAuthSession, dom, {
    token,
    payload: decodePayload(token),
    onExpire: () => { expiredCalls += 1; },
  });
  assert.equal(dom.whoEl.dataset.tone, "warn");

  const realNow = Date.now;
  Date.now = () => realNow() + 5_000;
  try {
    dom.timers[0].fn();
  } finally {
    Date.now = realNow;
  }

  assert.equal(session.state.kind, "expired");
  assert.equal(expiredCalls, 1);
  assert.equal(dom.timers[0].cleared, true);
  assert.equal(dom.whoEl.innerHTML, "");
});

test("web auth decodes non-ASCII Discord names from the token payload", async () => {
  const { decodePayload } = await import("../web/js/core/auth.js");
  for (const username of ["Trần Văn A", "トレイン"]) {
    assert.equal(decodePayload(makeToken({ discordId: "123", username })).username, username);
  }
});

test("web auth bootstrap reports an expired token without enabling sync globals", async () => {
  const { bootstrapAuthSession, decodePayload } = await import("../web/js/core/auth.js");
  const dom = makeDom();
  const token = makeToken({
    discordId: "123",
    exp: Math.floor(Date.now() / 1000) - 5,
    username: "Traine",
  });

  const session = bootstrap(bootstrapAuthSession, dom, { token, payload: decodePayload(token) });

  assert.equal(session.state.kind, "expired");
  assert.equal(dom.whoEl.innerHTML, "");
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

test("web auth reads fragment token and scrubs credentials from the address bar", async () => {
  const { readAndScrubLocalSyncToken } = await import("../web/js/core/auth.js");
  const replacements = [];
  const windowRef = {
    location: {
      href: "https://sync.example.test/sync?token=legacy&theme=dark#token=fragment&view=reader",
    },
    history: {
      replaceState: (...args) => replacements.push(args),
    },
  };

  assert.equal(readAndScrubLocalSyncToken(windowRef), "fragment");
  assert.deepEqual(replacements, [[null, "", "/sync?theme=dark#view=reader"]]);
});
