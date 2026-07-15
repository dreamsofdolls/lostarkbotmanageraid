"use strict";

export function decodePayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const normalized = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export function resolveCompanionScope(payload) {
  return payload?.scope === "solo" ? "solo" : "full";
}

function renderAuthStatus({ authStatus, authState, t, escapeHtml }) {
  if (!authState) return;
  const { kind, expSec, username, avatarUrl } = authState;
  if (kind === "noToken") {
    authStatus.innerHTML = `<span class="status-err">${t("identity.noToken")}</span> ${t("identity.noTokenHint")}`;
    return;
  }
  if (kind === "malformed") {
    authStatus.innerHTML = `<span class="status-err">${t("identity.malformed")}</span> ${t("identity.malformedHint")}`;
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const remSec = Math.max(0, expSec - nowSec);
  if (expSec && remSec === 0) {
    authStatus.innerHTML = `<span class="status-err">${t("identity.expired")}</span> ${t("identity.expiredHint")}`;
    return;
  }

  const validStr = remSec >= 60
    ? t("identity.tokenValid", { n: Math.floor(remSec / 60) })
    : t("identity.tokenValidSec", { n: remSec });
  let identityPill;
  if (username || avatarUrl) {
    const avatarImg = avatarUrl
      ? `<img class="auth-avatar" src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer">`
      : `<span class="auth-avatar auth-avatar--placeholder">${escapeHtml((username || "?").slice(0, 1).toUpperCase())}</span>`;
    const nameSpan = username
      ? `<span class="auth-name">${escapeHtml(username)}</span>`
      : "";
    const linkedLabel = `<span class="auth-linked-label">${escapeHtml(t("identity.linked"))}</span>`;
    identityPill = `<span class="auth-pill auth-identity-pill"><span class="auth-status-dot"></span>${avatarImg}<span class="auth-pill-text">${linkedLabel}${nameSpan}</span></span>`;
  } else {
    identityPill = `<span class="auth-pill auth-identity-pill"><span class="auth-status-dot"></span><span class="auth-pill-text"><span class="auth-name">${escapeHtml(t("identity.linkedAnonymous"))}</span></span></span>`;
  }

  const timerClass = remSec < 60
    ? "auth-pill auth-timer-pill auth-timer-pill--warn"
    : "auth-pill auth-timer-pill";
  const timerStr = `<span class="${timerClass}"><span class="auth-timer-icon">&#9201;</span><span>${escapeHtml(validStr)}</span></span>`;
  authStatus.innerHTML = `<div class="auth-row">${identityPill}${timerStr}</div>`;
}

export function bootstrapAuthSession({
  token,
  payload,
  authStatus,
  fileSection,
  t,
  escapeHtml,
  windowRef = window,
  setIntervalFn = setInterval,
}) {
  let authState = null;

  function render() {
    renderAuthStatus({ authStatus, authState, t, escapeHtml });
  }

  if (!token) {
    authState = { kind: "noToken" };
    render();
  } else if (!payload || !payload.discordId) {
    authState = { kind: "malformed" };
    render();
  } else {
    const expSec = payload.exp || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const identityFields = {
      username: typeof payload.username === "string" ? payload.username : null,
      avatarUrl: typeof payload.avatarUrl === "string" ? payload.avatarUrl : null,
    };
    authState = { kind: "ok", expSec, discordId: payload.discordId, ...identityFields };
    render();

    if (!(expSec && expSec < nowSec)) {
      setIntervalFn(render, 1000);
      windowRef.__artistSyncToken = token;
      windowRef.__artistDiscordId = payload.discordId;
      if (fileSection) fileSection.hidden = false;
    }
  }

  return {
    get state() {
      return authState;
    },
    render,
    updateExpSec(newExpSec) {
      if (!newExpSec || !authState || authState.kind !== "ok") return false;
      authState.expSec = newExpSec;
      render();
      return true;
    },
  };
}
