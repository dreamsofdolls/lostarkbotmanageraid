"use strict";

const { t } = require("../../services/i18n");
const { getGatesForRaid } = require("../../models/Raid");
const { getRaidModeLabel } = require("../../utils/raid/common/labels");
const { getClassEmoji } = require("../../models/Class");
// Aliased: buildLocalSyncConsolePayload takes a `UI` parameter, and an
// unaliased import here would read as the same thing at a glance.
const { UI: sharedUI, pack2Columns } = require("../../utils/raid/common/shared");
// Same two helpers /raid-status renders its character fields with · the
// preview feeds them simulated characters, so the rows come out identical.
const {
  formatRaidStatusLine,
  getStatusRaidsForCharacter,
} = require("../../utils/raid/common/character");
// The roster dropdown is the /raid-status one, not a lookalike · same
// builder, same labels, same counts.
const {
  buildStatusRosterFilterEntries,
  buildStatusRosterFilterRow,
} = require("../raid-status/raid-filter");
const {
  bucketizeLocalSyncDeltas,
  resolvePreviewJobState,
} = require("../../services/local-sync");

const MAX_CHARACTER_FIELDS = 10;
const MAX_RAIDS_PER_CHARACTER = 8;
// 8 characters pack to 12 fields at two per line, which leaves room for a
// roster header per group inside Discord's 25-field embed cap.
const MAX_CHANGED_CHARACTERS = 8;
const MAX_BODY_FIELDS = 22;
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
 * Rosters this preview touches, each with only the characters it changes.
 * Everything already in sync is left out · the card is about what is
 * about to change, and a full roster listing buries that in rows the
 * viewer has no decision to make about.
 * @param {object|null} summary
 * @param {number|null} rosterFilter - index into accountsAfterSync, null for every roster
 * @returns {Array<{index: number, account: object, characters: object[]}>}
 */
function collectChangedRosters(summary, rosterFilter = null) {
  const accounts = Array.isArray(summary?.accountsAfterSync) ? summary.accountsAfterSync : [];
  const incoming = buildIncomingMap(summary);
  const groups = [];
  accounts.forEach((account, index) => {
    if (rosterFilter !== null && index !== rosterFilter) return;
    const characters = (account.characters || []).filter((character) =>
      incoming.has(String(character.name || "").toLowerCase())
    );
    if (characters.length > 0) groups.push({ index, account, characters });
  });
  return groups;
}

/**
 * Body of the card, in the /raid-status gold-view shape: two columns of
 * inline character fields, each a header line plus one line per raid.
 * Not a copy of that layout · projectSummary hands back
 * `accountsAfterSync`, characters whose assignedRaids already reflect the
 * applied preview, so getStatusRaidsForCharacter and formatRaidStatusLine
 * run on them unchanged and the gate counts read the same everywhere.
 *
 * Only characters this sync changes are listed, and inside them only the
 * raids it changes · that is what lets every roster fit on one card with
 * no paging.
 *
 * @returns {boolean} false when the summary predates accountsAfterSync,
 *   so the caller can fall back to the delta-only list.
 */
function addChangedCharacterFields(embed, summary, lang, { rosterFilter = null } = {}) {
  if (!Array.isArray(summary?.accountsAfterSync)) return false;

  const incoming = buildIncomingMap(summary);
  const groups = collectChangedRosters(summary, rosterFilter);
  if (groups.length === 0) {
    embed.addFields({
      name: t("local-sync-discord.noChangesName", lang),
      value: t("local-sync-discord.noChangesValue", lang),
      inline: false,
    });
    return true;
  }

  const fields = [];
  let budget = MAX_CHANGED_CHARACTERS;
  let hidden = 0;
  for (const group of groups) {
    const charFields = [];
    for (const character of group.characters) {
      const touched = incoming.get(String(character.name || "").toLowerCase());
      const lines = getStatusRaidsForCharacter(character)
        .filter((raid) => touched.has(`${raid.raidKey}::${raid.modeKey}`))
        .map((raid) => formatRaidStatusLine(raid, lang));
      if (lines.length === 0) continue;
      if (budget <= 0) {
        hidden += 1;
        continue;
      }
      budget -= 1;
      const emoji = getClassEmoji(character.class || character.className);
      charFields.push({
        name: `${emoji ? `${emoji} ` : ""}${character.name} · ${Number(character.itemLevel) || 0}`,
        value: lines.join("\n"),
        inline: true,
      });
    }
    if (charFields.length === 0) continue;
    // The roster header only earns its field when more than one roster is
    // on the card · with a single one it says what the title already does.
    if (groups.length > 1) {
      fields.push({
        name: `${sharedUI.icons.folder} ${group.account.accountName || "?"}`,
        value: t("local-sync-discord.rosterChangedChars", lang, { count: charFields.length }),
        inline: false,
      });
    }
    // Two characters per line, the same zero-width-spacer packing the gold
    // and raid views use. Packed per roster so a header always starts a
    // fresh line instead of landing mid-pair.
    fields.push(...pack2Columns(charFields));
  }

  if (hidden > 0) {
    fields.push({
      name: t("local-sync-discord.moreCharactersName", lang),
      value: t("local-sync-discord.moreCharactersValue", lang, { count: hidden }),
      inline: false,
    });
  }
  // Discord caps an embed at 25 fields and the summary row above already
  // spends up to three of them.
  embed.addFields(...fields.slice(0, MAX_BODY_FIELDS));
  return true;
}

/**
 * The preview's totals, as description lines rather than embed fields.
 * The gold view carries its totals the same way · three inline fields
 * would render as a three-across row, and the card's character cards are
 * two-across.
 * @returns {string[]} one "icon **Label:** value" line per available total
 */
function buildSummaryLines(summary, lang, formatGold) {
  const lines = [
    `📊 **${t("local-sync-discord.summaryName", lang)}:** ${t(
      "local-sync-discord.summaryValue",
      lang,
      summary?.changes || { chars: 0, raids: 0, gates: 0 }
    )}`,
  ];

  if (summary?.completion) {
    lines.push(`📈 **${t("local-sync-discord.completionName", lang)}:** ${t(
      "local-sync-discord.completionValue",
      lang,
      { current: summary.completion.percent, projected: summary.completion.projectedPercent }
    )}`);
  }

  if (Number(summary?.goldDelta?.total) > 0) {
    const gold = typeof formatGold === "function"
      ? formatGold(summary.goldDelta.total)
      : String(summary.goldDelta.total);
    lines.push(`💰 **${t("local-sync-discord.goldName", lang)}:** ${t(
      "local-sync-discord.goldValue",
      lang,
      { gold }
    )}`);
  }
  return lines;
}

function addPreviewFields(embed, job, summary, lang, options = {}) {
  // Preferred body: the gold view's two columns, changed characters only.
  if (addChangedCharacterFields(embed, summary, lang, options)) return;

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
  rosterFilter = null,
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
  const accounts = Array.isArray(summary?.accountsAfterSync) ? summary.accountsAfterSync : [];
  const readerButton = readerUrl
    ? new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(readerUrl)
      .setEmoji("🗃️")
      .setLabel(t("local-sync-discord.buttons.openReader", lang))
    : null;

  if (job?.jobId) {
    // One row: the card shows every changed character at once, so there
    // is nothing left to page through and the three preview actions plus
    // the reader link fit inside Discord's five-per-row limit.
    const actionRow = new ActionRowBuilder();
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
    // The link goes last · it leaves Discord, the others stay here.
    if (readerButton) actionRow.addComponents(readerButton);
    rows.push(actionRow);
  } else if (readerButton) {
    // No preview to act on · the reader link is the only way forward.
    rows.push(new ActionRowBuilder().addComponents(readerButton));
  }

  // Roster picker last, under the buttons · same position and the same
  // builder as the /raid-status roster dropdown, so the options carry the
  // same concise "Rosters" all-option and "Tên (Còn x raid · y solo)"
  // per-roster counts. Only the customId namespace differs. The counts are
  // read off accountsAfterSync,
  // so they describe the roster as it will look once applied · the same
  // state the fields above already render.
  //
  // It lists only the rosters this preview touches, and appears only when
  // there is more than one · the card already shows them all at once, so
  // the dropdown is a way to narrow down, not the only way to see them.
  const changedIndices = new Set(collectChangedRosters(summary).map((group) => group.index));
  if (job?.jobId && changedIndices.size > 1 && StringSelectMenuBuilder) {
    const entries = buildStatusRosterFilterEntries({
      accounts,
      getRaidsFor: getStatusRaidsForCharacter,
    }).filter((entry) => changedIndices.has(entry.pageIndex));
    rows.push(buildStatusRosterFilterRow({
      ActionRowBuilder,
      StringSelectMenuBuilder,
      truncateText,
      rosterFilterEntries: entries,
      selectedRosterIndex: rosterFilter,
      disabled: false,
      lang,
      customId: `${buttonPrefix}roster:${job.jobId}`,
    }));
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
 * @param {number|null} [options.rosterFilter=null] - render only this roster of accountsAfterSync; null shows every roster the preview touches
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
  rosterFilter = null,
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
    const headerLines = [
      `🌐 **${t("local-sync-discord.scopeName", lang)}:** ${scopeLabel}`,
      `${STATE_ICON[key] || ""} **${t("local-sync-discord.statusName", lang)}:** ${t(`local-sync-discord.states.${key}`, lang)}`.trim(),
      expiresAt > 0 && state === "pending"
        ? t("local-sync-discord.expiresLine", lang, { timestamp: `<t:${expiresAt}:R>` })
        : "",
      buildResultDescription(job, state, lang),
    ].filter(Boolean);
    // Totals sit under a blank line so they read as their own block.
    embed.setDescription([
      headerLines.join("\n"),
      buildSummaryLines(summary, lang, formatGold).join("\n"),
    ].join("\n\n"));
    addPreviewFields(embed, job, summary, lang, { rosterFilter });
  }

  return {
    embeds: [embed],
    components: buildRows({
      job,
      state,
      summary,
      rosterFilter,
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
