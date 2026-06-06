"use strict";

const { getAccessibleAccounts } = require("../../services/access/access-control");
const { isDevUser } = require("../../services/access/dev-preview");
const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  aggregateCharacters,
} = require("./profile/helpers/aggregate");
const {
  preferredSnapshotView,
} = require("./profile/helpers/snapshot-view");
const {
  applyProfileButton,
  applyProfileSelect,
  createProfileSessionStore,
  renderSessionPayload,
} = require("./profile/session");

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
  const sessionStore = createProfileSessionStore();

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
    // Visibility: default hide (ephemeral, only the caller sees it). `show`
    // posts the profile publicly in the channel. Reset always stays ephemeral
    // (it's a self-confirm), so `show` only affects the actual profile view.
    const isPublic =
      interaction.options?.getString?.("visibility") === "show" &&
      interaction.options?.getString?.("action") !== "reset";
    await interaction.deferReply(isPublic ? {} : { flags: MessageFlags.Ephemeral });
    const viewerDiscordId = interaction.user.id;
    const lang = await getUserLanguage(viewerDiscordId, { UserModel: User });

    // Preview gate: the whole /raid-profile surface (view + reset) is dev-only
    // for now (DEV_USER allowlist). Checked before any data work.
    if (!isDevUser(viewerDiscordId)) {
      const embed = buildNoticeEmbed(EmbedBuilder, {
        type: "info",
        title: t("raidProfile.previewOnlyTitle", lang),
        description: t("raidProfile.previewOnlyDesc", lang),
      }).setAuthor({ name: "// RAID PROFILE · PREVIEW" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

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

    const session = sessionStore.createSession({
      viewerDiscordId,
      lang,
      entries,
    });
    await interaction.editReply(renderSessionPayload(renderDeps, session));
  }

  async function handleRaidProfileComponent(interaction) {
    // Preview gate: reject component interactions from non-preview users
    // defensively (e.g. a stale component minted before the gate shipped).
    if (!isDevUser(interaction.user?.id)) {
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raidProfile.previewOnlyTitle", lang),
            description: t("raidProfile.previewOnlyDesc", lang),
          }),
        ],
      });
      return;
    }
    const { action, session, forbidden } = sessionStore.getForInteraction(interaction);
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
