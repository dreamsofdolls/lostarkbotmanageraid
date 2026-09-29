"use strict";

export function decodePayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const normalized = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    // atob returns one character per byte, and the server encodes the payload
    // as UTF-8, so names with diacritics need the bytes decoded first.
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function resolveCompanionScope(payload) {
  return payload?.scope === "solo" ? "solo" : "full";
}

export function readAndScrubLocalSyncToken(windowRef = window) {
  const url = new URL(windowRef.location.href);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = hashParams.get("token") || url.searchParams.get("token");
  if (!token) return null;

  // Fragments stay out of proxy logs and Referer headers. Once JavaScript has
  // captured the bearer token, remove it from the address bar/history too so
  // screenshots and copied URLs cannot accidentally disclose it.
  hashParams.delete("token");
  url.searchParams.delete("token");
  const remainingHash = hashParams.toString();
  const cleanUrl = `${url.pathname}${url.search}${remainingHash ? `#${remainingHash}` : ""}`;
  windowRef.history.replaceState(null, "", cleanUrl);
  return token;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// The header line only names the linked user and the time left on the link.
// Failed states render nothing here; the page shows them in the well.
function renderWho({ whoEl, authState, t, escapeHtml }) {
  if (authState.kind !== "ok") {
    whoEl.innerHTML = "";
    delete whoEl.dataset.tone;
    return;
  }
  const remSec = Math.max(0, authState.expSec - nowSec());
  const validity = remSec >= 60
    ? t("identity.linkValid", { n: Math.floor(remSec / 60) })
    : t("identity.linkValidSec", { n: remSec });
  const name = authState.username
    ? `<b>${escapeHtml(authState.username)}</b>`
    : escapeHtml(t("identity.linkedAnonymous"));
  whoEl.innerHTML = `${name} · ${escapeHtml(validity)}`;
  if (remSec < 60) whoEl.dataset.tone = "warn";
  else delete whoEl.dataset.tone;
}

/**
 * Resolve the link token into an auth state, render the header line and
 * expose the token to the page while the link is valid.
 * @param {object} options
 * @param {string|null} options.token - raw link token
 * @param {object|null} options.payload - decoded token payload
 * @param {HTMLElement} options.whoEl - header element for the identity line
 * @param {Function} options.t - i18n lookup
 * @param {Function} options.escapeHtml
 * @param {Function} [options.onExpire] - called once when a valid link runs out
 * @returns {{readonly state: {kind: "noToken"|"malformed"|"expired"|"ok"}}}
 */
export function bootstrapAuthSession({
  token,
  payload,
  whoEl,
  t,
  escapeHtml,
  onExpire = null,
  windowRef = window,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let authState;
  if (!token) {
    authState = { kind: "noToken" };
  } else if (!payload || !payload.discordId) {
    authState = { kind: "malformed" };
  } else {
    const expSec = payload.exp || 0;
    authState = {
      kind: expSec && expSec < nowSec() ? "expired" : "ok",
      expSec,
      username: typeof payload.username === "string" ? payload.username : null,
    };
  }

  const render = () => renderWho({ whoEl, authState, t, escapeHtml });
  render();

  if (authState.kind === "ok") {
    windowRef.__artistSyncToken = token;
    windowRef.__artistDiscordId = payload.discordId;
    const timer = setIntervalFn(() => {
      if (authState.expSec && authState.expSec <= nowSec()) {
        authState = { kind: "expired" };
        clearIntervalFn(timer);
        render();
        if (onExpire) onExpire();
        return;
      }
      render();
    }, 1000);
  }

  return {
    get state() {
      return authState;
    },
  };
}
