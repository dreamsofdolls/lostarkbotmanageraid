"use strict";

const { randomUUID } = require("node:crypto");
const { getAccessibleAccounts } = require("../../services/access/access-control");
const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  buildCharacterEmbed,
  buildOverallEmbed,
  buildRosterEmbed,
} = require("./profile/embeds");
const {
  aggregateCharacters,
  getEntryLabel,
  preferredSnapshotView,
  roleEmoji,
  roleLabel,
  score,
} = require("./profile/view-helpers");

const PROFILE_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SELECT_OPTIONS = 25;
const MAX_CHARACTER_SELECT_OPTIONS = MAX_SELECT_OPTIONS - 1;
const ROSTER_PAGE_SIZE = MAX_SELECT_OPTIONS - 1;
const profileSessions = new Map();

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

async function buildAccessibleProfileEntries(viewerDiscordId, { RaidProfileSnapshot }) {
  const accessible = await getAccessibleAccounts(viewerDiscordId, { includeOwn: true });
  if (!accessible.length) return { accessible, entries: [] };

  const ownerIds = [...new Set(accessible.map((entry) => entry.ownerDiscordId).filter(Boolean))];
  const snapshots = await RaidProfileSnapshot.find({ discordId: { $in: ownerIds } }).lean();
  const snapshotByOwner = new Map(snapshots.map((snapshot) => [snapshot.discordId, preferredSnapshotView(snapshot)]));
  const entries = [];

  for (const access of accessible) {
    const snapshot = snapshotByOwner.get(access.ownerDiscordId);
    if (!snapshot) continue;
    const account = (snapshot.accounts || []).find(
      (item) => normalizeName(item.accountName) === normalizeName(access.accountName)
    );
    if (!account || !Array.isArray(account.characters) || account.characters.length === 0) continue;
    entries.push({
      ownerDiscordId: access.ownerDiscordId,
      ownerLabel: access.ownerLabel,
      accessLevel: access.accessLevel,
      isOwn: !!access.isOwn,
      accountName: account.accountName || access.accountName,
      generatedAt: snapshot.generatedAt,
      receivedAt: snapshot.receivedAt,
      source: snapshot.source || "local",
      rangeType: snapshot.rangeType || snapshot.criteria?.range?.type || "full",
      characters: account.characters,
    });
  }

  return { accessible, entries };
}

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
  const rosterPage = selectedEntry
    ? Math.floor(session.rosterIndex / ROSTER_PAGE_SIZE)
    : clampPage(session.rosterPage, session.entries.length, ROSTER_PAGE_SIZE);
  const rosterPageStart = rosterPage * ROSTER_PAGE_SIZE;

  const rosterOptions = [
    selectOption(t("raidProfile.optOverall", lang), "overall", t("raidProfile.optOverallDesc", lang), "📊", session.rosterIndex < 0),
    ...session.entries.slice(rosterPageStart, rosterPageStart + ROSTER_PAGE_SIZE).map((entry, offset) => {
      const index = rosterPageStart + offset;
      const agg = aggregateCharacters(entry.characters);
      return selectOption(
        getEntryLabel(entry),
        String(index),
        `${entry.isOwn ? "Own" : "Shared"} · ${agg.charCount} char · ${agg.logs} log`,
        entry.isOwn ? "📁" : "👥",
        session.rosterIndex === index
      );
    }),
  ];

  const rosterRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:roster:${sid}`)
      .setPlaceholder(t("raidProfile.rosterPlaceholder", lang))
      .addOptions(rosterOptions)
  );

  const charPageStart = selectedEntry && session.charIndex >= 0
    ? Math.floor(session.charIndex / MAX_CHARACTER_SELECT_OPTIONS) * MAX_CHARACTER_SELECT_OPTIONS
    : 0;
  const charOptions = selectedEntry
    ? [
        selectOption(t("raidProfile.optRosterOverview", lang), "overview", t("raidProfile.optRosterOverviewDesc", lang), "📁", session.charIndex < 0),
        ...selectedEntry.characters.slice(charPageStart, charPageStart + MAX_CHARACTER_SELECT_OPTIONS).map((character, offset) => {
          const index = charPageStart + offset;
          return selectOption(
            character.name,
            String(index),
            `${roleLabel(character)} · ${character.stats?.encounters || 0} scored · score ${score(character.scores?.overall)}`,
            roleEmoji(character),
            session.charIndex === index
          );
        }),
      ]
    : [selectOption(t("raidProfile.optPickRosterFirst", lang), "disabled", t("raidProfile.optPickRosterFirstDesc", lang), "📁", true)];

  const charRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:char:${sid}`)
      .setPlaceholder(t("raidProfile.charPlaceholder", lang))
      .setDisabled(!selectedEntry)
      .addOptions(charOptions)
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

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of profileSessions) {
    if (session.expiresAt <= now) profileSessions.delete(id);
  }
}

function getSessionForInteraction(interaction) {
  cleanupSessions();
  const parts = String(interaction.customId || "").split(":");
  const sid = parts[2];
  const session = profileSessions.get(sid);
  if (!session) return { action: parts[1], session: null };
  if (session.viewerDiscordId !== interaction.user?.id) {
    return { action: parts[1], session: null, forbidden: true };
  }
  session.expiresAt = Date.now() + PROFILE_SESSION_TTL_MS;
  return { action: parts[1], session };
}

function createRaidProfileCommand(deps) {
  const {
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    RaidProfileSnapshot,
    RaidProfileEncounter,
  } = deps;

  const renderDeps = { ...deps, EmbedBuilder, UI };

  async function resetOwnProfile(interaction, viewerDiscordId, lang) {
    // Self-service wipe: only the caller's own snapshot + per-encounter docs.
    // Re-syncing via the Web Companion rebuilds the profile from encounters.db.
    const [snapshotResult, encounterResult] = await Promise.all([
      RaidProfileSnapshot.deleteOne({ discordId: viewerDiscordId }),
      RaidProfileEncounter.deleteMany({ discordId: viewerDiscordId }),
    ]);
    const snapshots = Number(snapshotResult?.deletedCount) || 0;
    const encounters = Number(encounterResult?.deletedCount) || 0;
    const cleared = snapshots > 0 || encounters > 0;
    const embed = buildNoticeEmbed(EmbedBuilder, {
      type: cleared ? "success" : "info",
      title: cleared ? t("raidProfile.resetDoneTitle", lang) : t("raidProfile.resetEmptyTitle", lang),
      description: cleared
        ? t("raidProfile.resetDoneDesc", lang, { snapshots, encounters })
        : t("raidProfile.resetEmptyDesc", lang),
    }).setAuthor({ name: "// RAID PROFILE · RESET" });
    await interaction.editReply({ embeds: [embed] });
  }

  async function handleRaidProfileCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const viewerDiscordId = interaction.user.id;
    const lang = await getUserLanguage(viewerDiscordId, { UserModel: User });

    if (interaction.options?.getString?.("action") === "reset") {
      await resetOwnProfile(interaction, viewerDiscordId, lang);
      return;
    }

    const { accessible, entries } = await buildAccessibleProfileEntries(viewerDiscordId, {
      RaidProfileSnapshot,
    });

    if (!accessible.length) {
      const embed = buildNoticeEmbed(EmbedBuilder, {
        type: "info",
        title: t("raidProfile.noRosterTitle", lang),
        description: t("raidProfile.noRosterDesc", lang),
      }).setAuthor({ name: "// RAID PROFILE · HEADS UP" });
      await interaction.editReply({
        embeds: [embed],
      });
      return;
    }

    if (!entries.length) {
      const userDoc = await User.findOne({ discordId: viewerDiscordId })
        .select("autoManageEnabled localSyncEnabled lastLocalProfileSyncAt lastLocalSyncAt")
        .lean()
        .catch(() => null);
      let hint;
      if (userDoc?.localSyncEnabled) {
        hint = t("raidProfile.noSnapshotHintOn", lang);
      } else if (userDoc?.autoManageEnabled) {
        hint = t("raidProfile.noSnapshotHintBible", lang);
      } else {
        hint = t("raidProfile.noSnapshotHintOff", lang);
      }
      const embed = buildNoticeEmbed(EmbedBuilder, {
        type: "info",
        title: t("raidProfile.noSnapshotTitle", lang),
        description: hint,
      }).setAuthor({ name: "// RAID PROFILE · HEADS UP" });
      await interaction.editReply({
        embeds: [embed],
      });
      return;
    }

    const sid = randomUUID();
    const session = {
      id: sid,
      viewerDiscordId,
      lang,
      entries,
      rosterIndex: -1,
      rosterPage: 0,
      charIndex: -1,
      expiresAt: Date.now() + PROFILE_SESSION_TTL_MS,
    };
    profileSessions.set(sid, session);
    await interaction.editReply(renderSessionPayload(renderDeps, session));
  }

  async function handleRaidProfileComponent(interaction) {
    const { action, session, forbidden } = getSessionForInteraction(interaction);
    if (!session) {
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: forbidden ? t("raidProfile.forbiddenTitle", lang) : t("raidProfile.expiredTitle", lang),
            description: forbidden
              ? t("raidProfile.forbiddenDesc", lang)
              : t("raidProfile.expiredDesc", lang),
          }),
        ],
      });
      return;
    }

    if (interaction.isStringSelectMenu?.()) {
      const value = interaction.values?.[0] || "";
      applyProfileSelect(session, action, value);
      await interaction.update(renderSessionPayload(renderDeps, session));
      return;
    }

    if (interaction.isButton?.()) {
      applyProfileButton(session, action);
      await interaction.update(renderSessionPayload(renderDeps, session));
    }
  }

  return {
    handleRaidProfileCommand,
    handleRaidProfileComponent,
    __test: {
      aggregateCharacters,
      buildAccessibleProfileEntries,
      preferredSnapshotView,
      renderSessionPayload,
      applyProfileButton,
      applyProfileSelect,
      resetOwnProfile,
    },
  };
}

module.exports = {
  createRaidProfileCommand,
};
