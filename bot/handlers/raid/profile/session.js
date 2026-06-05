"use strict";

const { randomUUID } = require("node:crypto");
const { t } = require("../../../services/i18n");
const {
  buildCharacterEmbed,
  buildOverallEmbed,
  buildRosterEmbed,
} = require("./embeds");
const {
  aggregateCharacters,
  getEntryLabel,
  roleEmoji,
  roleLabel,
  score,
} = require("./view-helpers");

const PROFILE_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SELECT_OPTIONS = 25;
const MAX_CHARACTER_SELECT_OPTIONS = MAX_SELECT_OPTIONS - 1;
const ROSTER_PAGE_SIZE = MAX_SELECT_OPTIONS - 1;

const EMOJI = {
  chart: "\u{1F4CA}",
  folder: "\u{1F4C1}",
  people: "\u{1F465}",
};

function selectOption(label, value, description, emoji, isDefault = false) {
  const option = {
    label: label.slice(0, 100) || "Unknown",
    value,
    default: isDefault,
  };
  if (description) option.description = description.slice(0, 100);
  if (emoji) option.emoji = emoji;
  return option;
}

function clampPage(page, totalItems, pageSize) {
  const maxPage = Math.max(0, Math.ceil(Math.max(0, totalItems) / pageSize) - 1);
  const n = Number(page) || 0;
  return Math.max(0, Math.min(maxPage, Math.floor(n)));
}

function selectedProfileEntry(session) {
  return session.rosterIndex >= 0 ? session.entries[session.rosterIndex] : null;
}

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

function buildRosterOptions(session, lang) {
  const selectedEntry = selectedProfileEntry(session);
  const rosterPage = selectedEntry
    ? Math.floor(session.rosterIndex / ROSTER_PAGE_SIZE)
    : clampPage(session.rosterPage, session.entries.length, ROSTER_PAGE_SIZE);
  const rosterPageStart = rosterPage * ROSTER_PAGE_SIZE;

  return [
    selectOption(t("raidProfile.optOverall", lang), "overall", t("raidProfile.optOverallDesc", lang), EMOJI.chart, session.rosterIndex < 0),
    ...session.entries.slice(rosterPageStart, rosterPageStart + ROSTER_PAGE_SIZE).map((entry, offset) => {
      const index = rosterPageStart + offset;
      const agg = aggregateCharacters(entry.characters);
      return selectOption(
        getEntryLabel(entry),
        String(index),
        `${entry.isOwn ? "Own" : "Shared"} \u00B7 ${agg.charCount} char \u00B7 ${agg.logs} log`,
        entry.isOwn ? EMOJI.folder : EMOJI.people,
        session.rosterIndex === index
      );
    }),
  ];
}

function buildCharacterOptions(session, selectedEntry, lang) {
  if (!selectedEntry) {
    return [selectOption(t("raidProfile.optPickRosterFirst", lang), "disabled", t("raidProfile.optPickRosterFirstDesc", lang), EMOJI.folder, true)];
  }

  const charPageStart = session.charIndex >= 0
    ? Math.floor(session.charIndex / MAX_CHARACTER_SELECT_OPTIONS) * MAX_CHARACTER_SELECT_OPTIONS
    : 0;
  return [
    selectOption(t("raidProfile.optRosterOverview", lang), "overview", t("raidProfile.optRosterOverviewDesc", lang), EMOJI.folder, session.charIndex < 0),
    ...selectedEntry.characters.slice(charPageStart, charPageStart + MAX_CHARACTER_SELECT_OPTIONS).map((character, offset) => {
      const index = charPageStart + offset;
      return selectOption(
        character.name,
        String(index),
        `${roleLabel(character)} \u00B7 ${character.stats?.encounters || 0} scored \u00B7 score ${score(character.scores?.overall)}`,
        roleEmoji(character),
        session.charIndex === index
      );
    }),
  ];
}

function buildComponents(deps, session) {
  const {
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
  } = deps;
  const sid = session.id;
  const lang = session.lang || "vi";
  const selectedEntry = selectedProfileEntry(session);
  const selectedChar = selectedEntry && session.charIndex >= 0
    ? selectedEntry.characters[session.charIndex]
    : null;

  const rosterRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:roster:${sid}`)
      .setPlaceholder(t("raidProfile.rosterPlaceholder", lang))
      .addOptions(buildRosterOptions(session, lang))
  );

  const charRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:char:${sid}`)
      .setPlaceholder(t("raidProfile.charPlaceholder", lang))
      .setDisabled(!selectedEntry)
      .addOptions(buildCharacterOptions(session, selectedEntry, lang))
  );

  const canPageChars = !!selectedEntry && selectedEntry.characters.length > 0;
  const canPageRosters = !selectedEntry && session.entries.length > ROSTER_PAGE_SIZE;
  const canPage = canPageChars || canPageRosters;
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`raid-profile:prev:${sid}`)
      .setLabel(t("raidProfile.btnPrev", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage),
    new ButtonBuilder()
      .setCustomId(`raid-profile:overview:${sid}`)
      .setLabel(selectedChar ? t("raidProfile.btnRosterOverview", lang) : t("raidProfile.btnOverall", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!selectedEntry),
    new ButtonBuilder()
      .setCustomId(`raid-profile:next:${sid}`)
      .setLabel(t("raidProfile.btnNext", lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage)
  );

  return [rosterRow, charRow, buttonRow];
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
