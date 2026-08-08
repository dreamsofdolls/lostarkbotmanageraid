"use strict";

const { t } = require("../../services/i18n");
const { getGatesForRaid } = require("../../models/Raid");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");
const { getClassEmoji } = require("../../models/Class");
// Aliased: buildLocalSyncConsolePayload takes a `UI` parameter, and an
// unaliased import here would read as the same thing at a glance.
const { UI: sharedUI } = require("../../utils/raid/common/shared");
// Same two helpers /raid-status renders its character fields with · the
// preview feeds them simulated characters, so the rows come out identical.
const {
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
} = require("../../utils/raid/common/character");
const {
  bucketizeLocalSyncDeltas,
  resolvePreviewJobState,
} = require("../../services/local-sync");

const MAX_CHARACTER_FIELDS = 10;
const MAX_RAIDS_PER_CHARACTER = 8;
// Two surfaces render this payload and each needs its own customId
// namespace. The DM preview has no component collector, so its buttons
// must reach the global router (`local-sync:` in
// app/interaction-router-registry.js). The /raid-status sync view lives
// inside a collector-owned message, and the global router would
// editReply() over the whole status embed if it ever saw those clicks -
// `status-local:` is deliberately absent from every router prefix so
// only the collector handles it.
const DM_BUTTON_PREFIX = "local-sync:";
const STATUS_BUTTON_PREFIX = "status-local:";
const RETRYABLE_PENDING_REASONS = new Set([
  "sync_busy",
  "write_error",
  "apply_failed",
]);

// Multi-line locale values are stored as arrays of lines · t() returns
// them verbatim, so the call site joins. Same convention as
// services/raid/channel-monitor/channel-monitor-embeds.js.
function joinIfArray(value) {
  return Array.isArray(value) ? value.join("\n") : value;
}

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

// One icon per state, so the card's condition reads before the words do.
// Matches how /raid-status leads every header line with an icon.
const STATE_ICON = Object.freeze({
  pending: "⏳",
  applying: "🔄",
  applied: "✅",
  cancelled: "✖️",
  superseded: "🔁",
  expired: "⌛",
  failed: "⚠️",
  missing: "❔",
});

function statusColor(state, UI) {
  if (state === "applied") return UI.colors.success;
  if (state === "failed" || state === "expired") return UI.colors.danger;
  if (state === "cancelled" || state === "superseded") return UI.colors.progress;
  return UI.colors.neutral;
}

function buildResultDescription(job, state, lang) {
  const failureReason = String(job?.failureReason || "");
  if (state === "pending" && RETRYABLE_PENDING_REASONS.has(failureReason)) {
    return t(`local-sync-discord.retryReasons.${failureReason}`, lang);
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

/**
 * Which (raid, mode) pairs this preview is about to change, per character.
 * @param {object|null} summary
 * @returns {Map<string, Set<string>>} lowercased char name -> "raidKey::modeKey"
 */
function buildIncomingMap(summary) {
  const map = new Map();
  for (const c of summary?.charsAfterSync || []) {
    const key = String(c.charName || "").toLowerCase();
    const set = map.get(key) || new Set();
    for (const r of c.raids || []) {
      if (r.incoming) set.add(`${r.raidKey}::${r.modeKey}`);
    }
    if (set.size > 0) map.set(key, set);
  }
  return map;
}

/**
 * Body of the card, one roster at a time, in the /raid-status raid-view
 * shape. Not a copy of that layout · projectSummary hands back
 * `accountsAfterSync`, characters whose assignedRaids already reflect the
 * applied preview, so getStatusRaidsForCharacter and formatRaidStatusLine
 * run on them unchanged. Whatever the raid view learns to render, this
 * inherits.
 *
 * The one addition is ✨ on raids this sync flips · raid-status has no
 * such concept because it shows what IS, while this card shows what is
 * about to be.
 *
 * @returns {boolean} false when the summary predates accountsAfterSync,
 *   so the caller can fall back to the delta-only list.
 */
function addRosterPageFields(embed, summary, lang, { rosterIndex = 0 } = {}) {
  const accounts = Array.isArray(summary?.accountsAfterSync) ? summary.accountsAfterSync : [];
  if (accounts.length === 0) return false;

  const index = Math.min(Math.max(0, Number(rosterIndex) || 0), accounts.length - 1);
  const account = accounts[index];
  const incoming = buildIncomingMap(summary);

  if (accounts.length > 1) {
    embed.addFields({
      name: `${sharedUI.icons.folder} ${account.accountName || "?"}`,
      value: t("local-sync-discord.rosterPage", lang, { current: index + 1, total: accounts.length }),
      inline: false,
    });
  }

  for (const character of (account.characters || []).slice(0, MAX_CHARACTER_FIELDS)) {
    const touched = incoming.get(String(character.name || "").toLowerCase());
    const lines = getStatusRaidsForCharacter(character).map((raid) => {
      const mark = touched?.has(`${raid.raidKey}::${raid.modeKey}`) ? " ✨" : "";
      return `${formatRaidStatusLine(raid, lang)}${mark}`;
    });
    if (lines.length === 0) continue;
    const emoji = getClassEmoji(character.class || character.className);
    embed.addFields({
      name: `${emoji ? `${emoji} ` : ""}${character.name} · ${Number(character.itemLevel) || 0}`,
      value: lines.join("\n"),
      inline: true,
    });
  }

  const hidden = (account.characters || []).length - MAX_CHARACTER_FIELDS;
  if (hidden > 0) {
    embed.addFields({
      name: t("local-sync-discord.moreCharactersName", lang),
      value: t("local-sync-discord.moreCharactersValue", lang, { count: hidden }),
      inline: false,
    });
  }
  return true;
}

function addPreviewFields(embed, job, summary, lang, formatGold, options = {}) {
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

  // Preferred body: the raid view, one roster per page.
  if (addRosterPageFields(embed, summary, lang, options)) return;

  // Fallback for previews whose stored projection predates
  // accountsAfterSync · delta list only, no per-raid context.
  const grouped = [...groupPreviewBuckets(job, lang, summary).entries()];
  for (const [charName, raids] of grouped.slice(0, MAX_CHARACTER_FIELDS)) {
    const lines = raids.slice(0, MAX_RAIDS_PER_CHARACTER).map((raid) =>
      `＋ **${raid.label}** · ${raid.gates.join("-")}`
    );
    if (raids.length > MAX_RAIDS_PER_CHARACTER) {
      lines.push(t("local-sync-discord.moreRaids", lang, {
        count: raids.length - MAX_RAIDS_PER_CHARACTER,
      }));
    }
    // No em-dash: project rule covers every user-facing string.
    embed.addFields({ name: charName, value: lines.join("\n") || "·", inline: false });
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
  summary,
  rosterIndex = 0,
  readerUrl,
  lang,
  buttonPrefix = DM_BUTTON_PREFIX,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder = null,
  truncateText = (value) => String(value),
}) {
  const rows = [];
  // Roster picker, same idea as the /raid-status roster dropdown. The
  // jobId rides in the customId and the choice rides in the value, so this
  // needs no session state and works the same on the standalone console,
  // the DM, and the /raid-status view.
  const accounts = Array.isArray(summary?.accountsAfterSync) ? summary.accountsAfterSync : [];
  if (job?.jobId && accounts.length > 1 && StringSelectMenuBuilder) {
    const current = Math.min(Math.max(0, Number(rosterIndex) || 0), accounts.length - 1);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${buttonPrefix}roster:${job.jobId}`)
        .setPlaceholder(truncateText(t("local-sync-discord.rosterPlaceholder", lang), 150))
        // Discord caps a select at 25 options; rosters past that are rare
        // and still reachable once an earlier one is applied.
        .addOptions(accounts.slice(0, 25).map((account, index) => ({
          label: truncateText(account.accountName || `Roster ${index + 1}`, 100),
          value: String(index),
          emoji: sharedUI.icons.folder,
          default: index === current,
        })))
    ));
  }
  if (job?.jobId) {
    const actionRow = new ActionRowBuilder();
    // Prev/next ride on the action row because Discord forbids mixing a
    // select with buttons in one row. Current page travels in the
    // customId so the stateless surfaces know where they are.
    if (accounts.length > 1) {
      const current = Math.min(Math.max(0, Number(rosterIndex) || 0), accounts.length - 1);
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`${buttonPrefix}roster-prev:${job.jobId}:${current}`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("◀")
          .setDisabled(current <= 0),
        new ButtonBuilder()
          .setCustomId(`${buttonPrefix}roster-next:${job.jobId}:${current}`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("▶")
          .setDisabled(current >= accounts.length - 1)
      );
    }
    if (state === "pending") {
      actionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`${buttonPrefix}apply:${job.jobId}`)
          .setStyle(ButtonStyle.Success)
          .setEmoji("✅")
          .setLabel(t("local-sync-discord.buttons.apply", lang)),
        new ButtonBuilder()
          .setCustomId(`${buttonPrefix}cancel:${job.jobId}`)
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("✖️")
          .setLabel(t("local-sync-discord.buttons.cancel", lang))
      );
    }
    actionRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`${buttonPrefix}refresh:${job.jobId}`)
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

/**
 * Render the Local Sync preview console (embed + action rows).
 * @param {object} options
 * @param {object|null} options.job - stored preview job, null when none exists
 * @param {object|null} options.summary - projected change summary for the job
 * @param {string|null} options.readerUrl - signed web-companion URL, omits the link row when null
 * @param {string|null} options.activeScope - COMPANION_SCOPE value, null renders the disabled card
 * @param {string} [options.lang='vi']
 * @param {string} [options.buttonPrefix='local-sync:'] - customId namespace · see DM_BUTTON_PREFIX / STATUS_BUTTON_PREFIX
 * @param {number} [options.rosterIndex=0] - which roster page of accountsAfterSync to render
 * @param {Function} [options.StringSelectMenuBuilder] - omit to render without the roster picker
 * @returns {{embeds: object[], components: object[]}} discord.js message payload fragment
 */
function buildLocalSyncConsolePayload({
  job = null,
  summary = null,
  readerUrl = null,
  activeScope = null,
  lang = "vi",
  buttonPrefix = DM_BUTTON_PREFIX,
  rosterIndex = 0,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder = null,
  truncateText,
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
    embed.setDescription(joinIfArray(t("local-sync-discord.noPreviewDescription", lang)));
  } else {
    const scopeLabel = t(
      job.scope === "solo"
        ? "local-sync-discord.scopeSolo"
        : "local-sync-discord.scopeFull",
      lang
    );
    const expiresAt = unixSeconds(job.expiresAt);
    const key = statusKey(state);
    // Header shape borrowed from the /raid-status views: every data line
    // opens with an icon and a bold label, and the sentence explaining
    // what to do next follows with no icon of its own.
    //
    // The expiry line is a labelled value rather than prose on purpose ·
    // Discord renders <t:…:R> in the VIEWER's client language, so
    // "in 2 hours" would otherwise sit mid-clause inside a Vietnamese
    // sentence. After a label it reads as data.
    embed.setDescription([
      `🌐 **${t("local-sync-discord.scopeName", lang)}:** ${scopeLabel}`,
      `${STATE_ICON[key] || ""} **${t("local-sync-discord.statusName", lang)}:** ${t(`local-sync-discord.states.${key}`, lang)}`.trim(),
      expiresAt > 0 && state === "pending"
        ? t("local-sync-discord.expiresLine", lang, { timestamp: `<t:${expiresAt}:R>` })
        : "",
      buildResultDescription(job, state, lang),
    ].filter(Boolean).join("\n"));
    addPreviewFields(embed, job, summary, lang, formatGold, { rosterIndex });
  }

  return {
    embeds: [embed],
    components: buildRows({
      job,
      state,
      summary,
      rosterIndex,
      readerUrl,
      lang,
      buttonPrefix,
      ActionRowBuilder,
      ButtonBuilder,
      ButtonStyle,
      StringSelectMenuBuilder,
      truncateText,
    }),
  };
}

module.exports = {
  DM_BUTTON_PREFIX,
  STATUS_BUTTON_PREFIX,
  MAX_CHARACTER_FIELDS,
  MAX_RAIDS_PER_CHARACTER,
  groupProjectedChanges,
  groupPreviewBuckets,
  buildResultDescription,
  buildLocalSyncConsolePayload,
};
