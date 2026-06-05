"use strict";

const { randomUUID } = require("node:crypto");
const { t } = require("../../../services/i18n");
const {
  buildCharacterEmbed,
  buildOverallEmbed,
  buildRosterEmbed,
} = require("./embeds");
const {
  ROSTER_PAGE_SIZE,
  buildComponents,
  clampPage,
  selectedProfileEntry,
} = require("./components");

const PROFILE_SESSION_TTL_MS = 5 * 60 * 1000;

function parseProfileIndex(value) {
  const idx = Number(value);
  return Number.isInteger(idx) ? idx : -1;
}

function showProfileOverall(session) {
  session.rosterIndex = -1;
  session.charIndex = -1;
}

function applyRosterSelection(session, value) {
  if (value === "overall") {
    showProfileOverall(session);
    return true;
  }

  const idx = parseProfileIndex(value);
  if (!session.entries[idx]) return false;
  session.rosterIndex = idx;
  session.rosterPage = Math.floor(idx / ROSTER_PAGE_SIZE);
  session.charIndex = -1;
  return true;
}

function applyCharacterSelection(session, value) {
  if (value === "overview") {
    session.charIndex = -1;
    return true;
  }

  const entry = selectedProfileEntry(session);
  const idx = parseProfileIndex(value);
  if (!entry?.characters?.[idx]) return false;
  session.charIndex = idx;
  return true;
}

const PROFILE_SELECT_ACTIONS = {
  roster: applyRosterSelection,
  char: applyCharacterSelection,
};

function applyProfileSelect(session, action, value) {
  const handler = PROFILE_SELECT_ACTIONS[action];
  return handler ? handler(session, value) : false;
}

function moveCircularIndex(current, total, action) {
  if (action === "prev") return (current - 1 + total) % total;
  if (action === "next") return (current + 1) % total;
  return current;
}

function applyOverviewButton(session) {
  if (session.rosterIndex >= 0) {
    session.charIndex = -1;
  } else {
    showProfileOverall(session);
  }
  return true;
}

function applyRosterPageButton(session, action) {
  if (session.entries.length <= ROSTER_PAGE_SIZE) return false;
  const totalPages = Math.ceil(session.entries.length / ROSTER_PAGE_SIZE);
  const current = clampPage(session.rosterPage, session.entries.length, ROSTER_PAGE_SIZE);
  session.rosterPage = moveCircularIndex(current, totalPages, action);
  return action === "prev" || action === "next";
}

function applyCharacterPageButton(session, action, entry) {
  const total = entry?.characters?.length || 0;
  if (!total) return false;
  const current = session.charIndex >= 0 ? session.charIndex : 0;
  session.charIndex = moveCircularIndex(current, total, action);
  return action === "prev" || action === "next";
}

function applyPagingButton(session, action) {
  const entry = selectedProfileEntry(session);
  return entry
    ? applyCharacterPageButton(session, action, entry)
    : applyRosterPageButton(session, action);
}

const PROFILE_BUTTON_ACTIONS = {
  overview: applyOverviewButton,
  prev: applyPagingButton,
  next: applyPagingButton,
};

function applyProfileButton(session, action) {
  const handler = PROFILE_BUTTON_ACTIONS[action];
  return handler ? handler(session, action) : false;
}

function renderSessionPayload(deps, session) {
  let embed;
  if (session.rosterIndex < 0) {
    embed = buildOverallEmbed(deps, session);
  } else {
    const entry = session.entries[session.rosterIndex];
    if (session.charIndex >= 0 && entry?.characters?.[session.charIndex]) {
      embed = buildCharacterEmbed(deps, session, entry, entry.characters[session.charIndex]);
    } else {
      embed = buildRosterEmbed(deps, session, entry);
    }
  }
  return {
    embeds: [embed],
    components: buildComponents(deps, session),
  };
}

function createProfileSession({ viewerDiscordId, lang, entries, ttlMs = PROFILE_SESSION_TTL_MS, now = Date.now() }) {
  return {
    id: randomUUID(),
    viewerDiscordId,
    lang,
    entries,
    rosterIndex: -1,
    rosterPage: 0,
    charIndex: -1,
    expiresAt: now + ttlMs,
  };
}

function createProfileSessionStore({ ttlMs = PROFILE_SESSION_TTL_MS } = {}) {
  const sessions = new Map();

  function cleanupSessions(now = Date.now()) {
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  }

  function createSession(input) {
    const session = createProfileSession({ ...input, ttlMs });
    sessions.set(session.id, session);
    return session;
  }

  function getForInteraction(interaction) {
    cleanupSessions();
    const parts = String(interaction.customId || "").split(":");
    const sid = parts[2];
    const session = sessions.get(sid);
    if (!session) return { action: parts[1], session: null };
    if (session.viewerDiscordId !== interaction.user?.id) {
      return { action: parts[1], session: null, forbidden: true };
    }
    session.expiresAt = Date.now() + ttlMs;
    return { action: parts[1], session };
  }

  return {
    createSession,
    getForInteraction,
    __sessions: sessions,
  };
}

module.exports = {
  PROFILE_SESSION_TTL_MS,
  applyProfileButton,
  applyProfileSelect,
  buildComponents,
  createProfileSession,
  createProfileSessionStore,
  renderSessionPayload,
};
