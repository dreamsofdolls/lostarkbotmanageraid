"use strict";

const { t } = require("../../services/i18n");
const { getGatesForRaid } = require("../../models/Raid");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");
const {
  bucketizeLocalSyncDeltas,
  resolvePreviewJobState,
} = require("../../services/local-sync");

const MAX_CHARACTER_FIELDS = 10;
const MAX_RAIDS_PER_CHARACTER = 8;

function unixSeconds(value) {
  const ms = Number(new Date(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function groupProjectedChanges(summary, lang) {
  const byCharacter = new Map();
  for (const character of summary?.changeDetails || []) {
    const charName = String(character?.charName || "?");
    const raids = (character?.raids || []).map((raid) => ({
      raidKey: raid.raidKey,
      modeKey: raid.modeKey,
      label: getRaidModeLabel(raid.raidKey, raid.modeKey, lang),
      gates: Array.isArray(raid.gates) ? raid.gates : [],
    }));
    if (raids.length > 0) byCharacter.set(charName, raids);
  }
  return byCharacter;
}

function groupPreviewBuckets(job, lang, summary = null) {
  const projected = groupProjectedChanges(summary, lang);
  if (projected.size > 0 || Array.isArray(summary?.changeDetails)) return projected;

  const byCharacter = new Map();
  for (const bucket of bucketizeLocalSyncDeltas(job?.deltas || [])) {
    const charName = String(bucket.charName || "?");
    if (!byCharacter.has(charName)) byCharacter.set(charName, []);
    const gates = getGatesForRaid(bucket.raidKey).slice(0, bucket.gateIndex + 1);
    byCharacter.get(charName).push({
      raidKey: bucket.raidKey,
      modeKey: bucket.modeKey,
      label: getRaidModeLabel(bucket.raidKey, bucket.modeKey, lang),
      gates,
    });
  }
  return byCharacter;
}

function statusKey(state) {
  const known = new Set([
    "pending",
    "applying",
    "applied",
    "cancelled",
    "superseded",
    "expired",
    "failed",
  ]);
  return known.has(state) ? state : "missing";
}

function statusColor(state, UI) {
  if (state === "applied") return UI.colors.success;
  if (state === "failed" || state === "expired") return UI.colors.danger;
  if (state === "cancelled" || state === "superseded") return UI.colors.progress;
  return UI.colors.neutral;
}

function buildResultDescription(job, state, lang) {
  if (state === "pending" && job?.failureReason === "sync_busy") {
    return t("local-sync-discord.failureReasons.sync_busy", lang);
  }
  if (state === "applied") {
    const result = job?.result || {};
    return t("local-sync-discord.appliedDescription", lang, {
      applied: result.applied?.length || 0,
      skipped: result.skipped?.length || 0,
      rejected: result.rejected?.length || 0,
    });
  }
  if (state === "failed") {
    const reason = String(job?.failureReason || "apply_failed");
    const reasonKey = `local-sync-discord.failureReasons.${reason}`;
    const localized = t(reasonKey, lang);
    return t("local-sync-discord.failedDescription", lang, {
      reason: localized === reasonKey ? reason : localized,
    });
  }
  return t(`local-sync-discord.stateDescriptions.${statusKey(state)}`, lang);
}

function addPreviewFields(embed, job, summary, lang, formatGold) {
  const changes = summary?.changes || { chars: 0, raids: 0, gates: 0 };
  embed.addFields({
    name: t("local-sync-discord.summaryName", lang),
    value: t("local-sync-discord.summaryValue", lang, changes),
    inline: true,
  });

  if (summary?.completion) {
    embed.addFields({
      name: t("local-sync-discord.completionName", lang),
      value: t("local-sync-discord.completionValue", lang, {
        current: summary.completion.percent,
        projected: summary.completion.projectedPercent,
      }),
      inline: true,
    });
  }

  if (Number(summary?.goldDelta?.total) > 0) {
    const gold = typeof formatGold === "function"
      ? formatGold(summary.goldDelta.total)
      : String(summary.goldDelta.total);
    embed.addFields({
      name: t("local-sync-discord.goldName", lang),
      value: t("local-sync-discord.goldValue", lang, { gold }),
      inline: true,
    });
  }

  const grouped = [...groupPreviewBuckets(job, lang, summary).entries()];
  for (const [charName, raids] of grouped.slice(0, MAX_CHARACTER_FIELDS)) {
    const lines = raids.slice(0, MAX_RAIDS_PER_CHARACTER).map((raid) =>
      `＋ **${raid.label}** · ${raid.gates.join("–")}`
    );
    if (raids.length > MAX_RAIDS_PER_CHARACTER) {
      lines.push(t("local-sync-discord.moreRaids", lang, {
        count: raids.length - MAX_RAIDS_PER_CHARACTER,
      }));
    }
    embed.addFields({ name: charName, value: lines.join("\n") || "—", inline: false });
  }
  if (grouped.length > MAX_CHARACTER_FIELDS) {
    embed.addFields({
      name: t("local-sync-discord.moreCharactersName", lang),
      value: t("local-sync-discord.moreCharactersValue", lang, {
        count: grouped.length - MAX_CHARACTER_FIELDS,
      }),
      inline: false,
    });
  }
}

function buildRows({
  job,
  state,
  readerUrl,
  lang,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
}) {
  const rows = [];
  if (job?.jobId) {
    const actionRow = new ActionRowBuilder();
    if (state === "pending") {
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`local-sync:apply:${job.jobId}`)
          .setStyle(ButtonStyle.Success)
          .setEmoji("✅")
          .setLabel(t("local-sync-discord.buttons.apply", lang)),
        new ButtonBuilder()
          .setCustomId(`local-sync:cancel:${job.jobId}`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("✖️")
          .setLabel(t("local-sync-discord.buttons.cancel", lang))
      );
    }
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`local-sync:refresh:${job.jobId}`)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🔄")
        .setLabel(t("local-sync-discord.buttons.refresh", lang))
    );
    rows.push(actionRow);
  }

  if (readerUrl) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(readerUrl)
        .setEmoji("🗃️")
        .setLabel(t("local-sync-discord.buttons.openReader", lang))
    ));
  }
  return rows;
}

function buildLocalSyncConsolePayload({
  job = null,
  summary = null,
  readerUrl = null,
  activeScope = null,
  lang = "vi",
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UI,
  formatGold,
}) {
  const state = job ? resolvePreviewJobState(job) : "missing";
  const embed = new EmbedBuilder()
    .setTitle(`🗃️ ${t("local-sync-discord.title", lang)}`)
    .setColor(statusColor(state, UI))
    .setTimestamp();

  if (!activeScope) {
    embed.setDescription(t("local-sync-discord.disabledDescription", lang));
    return { embeds: [embed], components: [] };
  }

  if (!job) {
    embed.setDescription(t("local-sync-discord.noPreviewDescription", lang));
  } else {
    const scopeLabel = t(
      job.scope === "solo"
        ? "local-sync-discord.scopeSolo"
        : "local-sync-discord.scopeFull",
      lang
    );
    const expiresAt = unixSeconds(job.expiresAt);
    embed.setDescription([
      `**${t("local-sync-discord.scopeName", lang)}:** ${scopeLabel}`,
      `**${t("local-sync-discord.statusName", lang)}:** ${t(`local-sync-discord.states.${statusKey(state)}`, lang)}`,
      buildResultDescription(job, state, lang),
      expiresAt > 0 && state === "pending"
        ? t("local-sync-discord.expiresLine", lang, { timestamp: `<t:${expiresAt}:R>` })
        : "",
    ].filter(Boolean).join("\n"));
    addPreviewFields(embed, job, summary, lang, formatGold);
  }

  return {
    embeds: [embed],
    components: buildRows({
      job,
      state,
      readerUrl,
      lang,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
    }),
  };
}

module.exports = {
  MAX_CHARACTER_FIELDS,
  MAX_RAIDS_PER_CHARACTER,
  groupProjectedChanges,
  groupPreviewBuckets,
  buildLocalSyncConsolePayload,
};
