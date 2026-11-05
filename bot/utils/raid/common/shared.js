const {
  CORE_MODE_ALIASES,
  SHORTHAND_MODE_ALIASES,
  buildModeAliasMap,
} = require("../../../domain/difficulty-aliases");
const { t } = require("../../../services/i18n");
const { getClassEmoji } = require("../../../models/Class");

const UI = {
  colors: {
    success: 0x57f287,
    progress: 0xfee75c,
    neutral: 0x5865f2,
    danger: 0xed4245,
    muted: 0x99aab5,
  },
  icons: {
    done: "🟢",
    partial: "🟡",
    pending: "⚪",
    reset: "🔄",
    lock: "🔒",
    warn: "⚠️",
    info: "ℹ️",
    folder: "📁",
    roster: "📥",
  },
};

const NOTICE_STYLE_BY_TYPE = Object.freeze({
  error: { color: UI.colors.danger, icon: UI.icons.warn },
  info: { color: UI.colors.neutral, icon: UI.icons.info },
  lock: { color: UI.colors.danger, icon: UI.icons.lock },
  muted: { color: UI.colors.muted, icon: UI.icons.info },
  success: { color: UI.colors.success, icon: UI.icons.done },
  warn: { color: UI.colors.progress, icon: UI.icons.warn },
});

/**
 * Kinds of notice. Each kind has one icon and one colour, so a situation
 * reads the same in every command; red is kept for real failures. ✅ is the
 * done icon because 🟢 already means "raid cleared" on /raid-status.
 */
const NoticeKind = Object.freeze({
  GUARD: "guard",         // blocked by permission, wrong user, wrong place, view-only share
  EXPIRED: "expired",     // session, button, picker or card no longer valid
  INPUT: "input",         // input to fix, an option missing, nothing to do
  EMPTY: "empty",         // a normal empty result: no roster, not found
  BUSY: "busy",           // cooldown, another sync running, an outside service not answering
  FAILURE: "failure",     // something actually broke
  PROGRESS: "progress",   // work in flight
  DONE: "done",           // saved, changed, switched, cancelled on request
  PARTIAL: "partial",     // done in part
  CONFIRM: "confirm",     // a prompt waiting for a button
});

const NOTICE_STYLE_BY_KIND = Object.freeze({
  guard: { color: UI.colors.progress, icon: "🔒" },
  expired: { color: UI.colors.muted, icon: "⌛" },
  input: { color: UI.colors.progress, icon: "✏️" },
  empty: { color: UI.colors.neutral, icon: "🔍" },
  busy: { color: UI.colors.progress, icon: "🚦" },
  failure: { color: UI.colors.danger, icon: "❌" },
  progress: { color: UI.colors.neutral, icon: "⏳" },
  done: { color: UI.colors.success, icon: "✅" },
  partial: { color: UI.colors.progress, icon: "⚠️" },
  confirm: { color: UI.colors.progress, icon: "❔" },
});

class ConcurrencyLimiter {
  constructor(max) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._dispatch();
    });
  }

  _dispatch() {
    while (this.active < this.max && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          this.active -= 1;
          this._dispatch();
        });
    }
  }
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function foldName(value) {
  return normalizeName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseNumericStat(rawValue) {
  const sanitized = String(rawValue || "0")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  const parsed = parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseItemLevel(rawValue) {
  return parseNumericStat(rawValue);
}

function parseCombatScore(rawValue) {
  return parseNumericStat(rawValue);
}

const MODE_LABELS = Object.freeze({
  hard: "Hard",
  nightmare: "Nightmare",
  solo: "Solo",
});

function toModeLabel(modeKey) {
  const lower = normalizeName(modeKey);
  return MODE_LABELS[lower] || "Normal";
}

const MODE_KEYS = buildModeAliasMap(CORE_MODE_ALIASES, SHORTHAND_MODE_ALIASES);

function toModeKey(modeLabel) {
  return MODE_KEYS.get(normalizeName(modeLabel)) || "normal";
}

function getCharacterName(character) {
  return character?.name || character?.charName || "";
}

function getCharacterClass(character) {
  return character?.class || character?.className || "Unknown";
}

function truncateText(s, max) {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function formatShortRelative(timestamp) {
  const diffMs = Date.now() - Number(timestamp);
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatNextCooldownRemaining(lastAttemptAt, cooldownMs) {
  const last = Number(lastAttemptAt) || 0;
  if (last <= 0 || cooldownMs <= 0) return null;
  const remaining = last + Number(cooldownMs) - Date.now();
  if (remaining <= 0) return null;

  const totalSeconds = Math.ceil(remaining / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.ceil(remaining / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
}

function splitEmbedFieldValue(value, limit = 1024) {
  const chunks = [];
  let current = "";
  for (const rawLine of String(value || "").split("\n")) {
    const lineParts = [];
    let remaining = rawLine;
    while (remaining.length > limit) {
      let cutAt = remaining.lastIndexOf(" ", limit);
      if (cutAt < Math.floor(limit * 0.6)) cutAt = limit;
      lineParts.push(remaining.slice(0, cutAt).trimEnd());
      remaining = remaining.slice(cutAt).trimStart();
    }
    lineParts.push(remaining);
    for (const part of lineParts) {
      const next = current ? `${current}\n${part}` : part;
      if (next.length > limit && current) {
        chunks.push(current);
        current = part;
      } else {
        current = next;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : ["_No details_"];
}

function addChunkedEmbedField(
  embed,
  name,
  value,
  { limit = 1024, inline = false } = {}
) {
  const chunks = splitEmbedFieldValue(value, limit);
  chunks.forEach((chunk, index) => {
    embed.addFields({
      name: index === 0 ? name : `${name} (${index + 1})`,
      value: chunk,
      inline,
    });
  });
  return embed;
}

function waitWithBudget(promise, budgetMs) {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true, value: null }), budgetMs);
  });
  return Promise.race([
    promise.then((value) => ({ timedOut: false, value })),
    timeout,
  ]).finally(() => clearTimeout(timeoutId));
}

function buildDiscordIdentityFields(source) {
  const user = source?.user || source || {};
  const member = source?.member || {};
  const username = String(user.username || "").trim();
  const globalName = String(user.globalName || "").trim();
  const memberDisplayName = String(member.displayName || member.nick || "").trim();
  const userDisplayName = String(user.displayName || globalName || username || "").trim();

  return {
    discordUsername: username,
    discordGlobalName: globalName,
    discordDisplayName: memberDisplayName || userDisplayName,
  };
}

const EMBED_DESCRIPTION_MAX_LENGTH = 4096;
const EMBED_TITLE_MAX_LENGTH = 256;

const EMBED_FIELD_NAME_MAX_LENGTH = 256;
const EMBED_FIELD_VALUE_MAX_LENGTH = 1024;
const EMBED_FOOTER_MAX_LENGTH = 2048;
const TIP_ICON = "💡";

/**
 * Discord renders no markdown in an embed footer, so bold and code marks in
 * a tip would arrive as literal `**` and backticks. The marks are dropped,
 * the text kept: "Gõ `/raid-status`" reads as "Gõ /raid-status".
 * @param {string} value
 * @returns {string}
 */
function stripInlineMarkdown(value) {
  return String(value ?? "")
    .replace(/\*\*(.+?)\*\*/gsu, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gsu, "$1")
    .replace(/__(.+?)__/gsu, "$1")
    .replace(/`([^`]+)`/gu, "$1");
}

/**
 * Build a notice embed for a refusal, an empty result, a wait, a failure,
 * a progress line, a confirmation or a prompt.
 *
 * A `kind` (NoticeKind) sets the title icon and the colour from one table,
 * so the same situation looks the same in every command. `type` is the
 * older severity option, kept until every caller names a kind. Every text
 * part is clamped to Discord's limits, since titles and errors can carry
 * user input and an over-long part would make the builder throw.
 *
 * Caller passes EmbedBuilder so this helper stays free of a discord.js
 * import.
 *
 * @param {Function} EmbedBuilder - discord.js EmbedBuilder class
 * @param {object} options
 * @param {string} [options.kind] - one of NoticeKind.*
 * @param {string} [options.type] - legacy severity (info, warn, lock, muted, success, error)
 * @param {string} [options.title] - short result, shown behind the icon
 * @param {string} [options.description] - hero sentence, markdown allowed
 * @param {Array<{name: string, value: string, inline?: boolean}|null>} [options.fields] - concrete data; empty values and nulls are dropped
 * @param {string} [options.tip] - next step, shown as the footer behind 💡 with markdown removed
 * @returns {object} the EmbedBuilder instance
 */
function buildNoticeEmbed(EmbedBuilder, { kind, type = "info", title, description, fields = [], tip } = {}) {
  const kindStyle = NOTICE_STYLE_BY_KIND[kind];
  const { color, icon } = kindStyle || NOTICE_STYLE_BY_TYPE[type] || NOTICE_STYLE_BY_TYPE.info;
  const separator = kindStyle ? "  " : " ";
  const embed = new EmbedBuilder().setColor(color).setTimestamp(new Date());
  if (title) embed.setTitle(truncateText(`${icon}${separator}${title}`, EMBED_TITLE_MAX_LENGTH));
  if (description) embed.setDescription(truncateText(description, EMBED_DESCRIPTION_MAX_LENGTH));
  // Discord rejects a field with an empty value.
  const cleanFields = fields
    .filter((field) => field && String(field.value ?? "").trim() !== "")
    .map((field) => ({
      ...field,
      name: truncateText(String(field.name), EMBED_FIELD_NAME_MAX_LENGTH),
      value: truncateText(String(field.value), EMBED_FIELD_VALUE_MAX_LENGTH),
    }));
  if (cleanFields.length > 0) embed.addFields(...cleanFields);
  if (tip) embed.setFooter({ text: truncateText(`${TIP_ICON} ${stripInlineMarkdown(tip)}`, EMBED_FOOTER_MAX_LENGTH) });
  return embed;
}

/**
 * A character name as notices show it: the class icon, then the name in
 * bold. A class with no emoji (unknown, or not bootstrapped yet) leaves the
 * bare bold name, as `/raid-status` does.
 * @param {string} name
 * @param {string} [className]
 * @returns {string}
 */
function formatCharacterLabel(name, className) {
  const icon = className ? getClassEmoji(className) : "";
  return icon ? `${icon} **${name}**` : `**${name}**`;
}

/**
 * The shared "no roster yet" notice, one copy for every command.
 * @param {string} [lang]
 * @returns {{kind: string, title: string, description: string, tip: string}}
 */
function buildNoRosterNotice(lang) {
  return {
    kind: NoticeKind.EMPTY,
    title: t("common.notice.noRosterTitle", lang),
    description: t("common.notice.noRosterDescription", lang),
    tip: t("common.notice.noRosterTip", lang),
  };
}

/**
 * The shared notice for a roster named in a command that the user does not
 * have. A button on an older card whose roster is gone uses its own expired
 * copy instead.
 * @param {string} rosterName - the name as typed
 * @param {string} [lang]
 * @returns {{kind: string, title: string, description: string, tip: string}}
 */
function buildRosterNotFoundNotice(rosterName, lang) {
  return {
    kind: NoticeKind.EMPTY,
    title: t("common.notice.rosterNotFoundTitle", lang),
    description: t("common.notice.rosterNotFoundDescription", lang, { rosterName }),
    tip: t("common.notice.rosterNotFoundTip", lang),
  };
}

/**
 * The "🧾 Chi tiết" field a failure card uses for the technical error,
 * in code font and clamped to the field limit (the two backticks included).
 * @param {string} [detail] - the error text; empty gives no field
 * @param {string} [lang]
 * @returns {{name: string, value: string, inline: boolean}|null}
 */
function buildDetailField(detail, lang) {
  const text = String(detail ?? "").trim();
  if (!text) return null;
  return {
    name: t("common.fields.details", lang),
    value: `\`${truncateText(text, EMBED_FIELD_VALUE_MAX_LENGTH - 2)}\``,
    inline: false,
  };
}

/**
 * Render the shared `🟢 N done · 🟡 N partial · ⚪ N pending [· 🔒 N not eligible]`
 * footer line used by `/raid-status` (caller's own roster rollup) and
 * `/raid-check` (subject-scoped or filtered roster rollup). Caller owns
 * the aggregation upstream - this just formats the icon line so the two
 * surfaces can't drift on icon ordering / spacing / "not eligible"
 * suffix rules.
 *
 * `notEligible` is optional: omit / pass 0 to suppress the lock segment
 * (raid-status doesn't track it; raid-check does for chars below the
 * raid floor).
 */
function formatProgressTotals(totals, UI, lang) {
  // Default lang back-compat: omit `lang` and t() falls back to vi via the
  // resolver.
  const done = Number(totals?.done) || 0;
  const partial = Number(totals?.partial) || 0;
  const pending = Number(totals?.pending) || 0;
  const notEligible = Number(totals?.notEligible) || 0;
  const parts = [
    `${UI.icons.done} ${done} ${t("common.progress.done", lang)}`,
    `${UI.icons.partial} ${partial} ${t("common.progress.partial", lang)}`,
    `${UI.icons.pending} ${pending} ${t("common.progress.pending", lang)}`,
  ];
  if (notEligible > 0) {
    parts.push(`${UI.icons.lock} ${notEligible} ${t("common.progress.notEligible", lang)}`);
  }
  return parts.join(" · ");
}

/**
 * Render the Bible auto-sync freshness line /raid-status shows:
 * `🔄 Last synced … · ⏳ Sync ready …`. Callers decide when the next sync
 * opens, so each keeps its own cooldown source.
 * @param {object} state
 * @param {number} state.lastSyncAt - last successful sync in ms, 0 when never
 * @param {number} state.readyAt - when the next sync opens in ms, 0 when open now
 * @param {object} UI - shared icon palette
 * @param {string} lang - locale
 * @returns {string} the freshness line
 */
function formatAutoManageFreshnessLine({ lastSyncAt, readyAt }, UI, lang) {
  const lastSync = lastSyncAt > 0
    ? `${UI.icons.reset} ${t("raid-status.freshness.lastSynced", lang)} <t:${Math.floor(lastSyncAt / 1000)}:R>`
    : `${UI.icons.reset} ${t("raid-status.freshness.neverSynced", lang)}`;
  if (readyAt <= 0) {
    return `${lastSync} · ✅ ${t("raid-status.freshness.syncReadyNow", lang)}`;
  }
  return `${lastSync} · ⏳ ${t("raid-status.freshness.syncReady", lang)} <t:${Math.floor(readyAt / 1000)}:R>`;
}

/**
 * Render a gold amount with locale-style thousands separators and a
 * trailing `G` suffix (e.g. `26,000G`). Used by the per-character gold
 * line in `/raid-status` and the account / cross-account rollup. Negative
 * inputs (shouldn't occur in normal flow) and non-finite values floor to
 * `0G` rather than printing `NaN` so a render bug can't crash the embed.
 */
function formatGold(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "0G";
  return `${Math.floor(n).toLocaleString("en-US")}G`;
}

// Discord MessageFlags.Ephemeral as a literal constant. Imported once
// here so the notice-reply wrappers below don't need every caller to
// thread MessageFlags through. discord.js exports it as a frozen enum
// (numeric value 64) - safe to bake in.
const MESSAGE_FLAG_EPHEMERAL = 1 << 6; // 64

/**
 * Reply with a notice embed, ephemeral by default. Wrapper around the
 * common 7-line pattern:
 *   await interaction.reply({
 *     embeds: [buildNoticeEmbed(EmbedBuilder, { type, title, description })],
 *     flags: MessageFlags.Ephemeral,
 *   });
 *
 * Caller passes EmbedBuilder so this stays decoupled from discord.js
 * imports. Pass `ephemeral: false` to broadcast to the channel, and
 * include extra reply payload fields such as `components` when needed.
 */
function replyNotice(interaction, EmbedBuilder, options, { ephemeral = true, ...extras } = {}) {
  const payload = {
    embeds: [buildNoticeEmbed(EmbedBuilder, options)],
    ...extras,
  };
  if (ephemeral) payload.flags = MESSAGE_FLAG_EPHEMERAL;
  return interaction.reply(payload);
}

/**
 * Reply with already-built embed(s), ephemeral by default. Use this for
 * richer custom embeds that do not fit the notice shape but still repeat
 * the same `embeds + flags` Discord payload boilerplate.
 */
function replyEmbed(interaction, embedOrEmbeds, { ephemeral = true, ...extras } = {}) {
  const payload = {
    embeds: Array.isArray(embedOrEmbeds) ? embedOrEmbeds : [embedOrEmbeds],
    ...extras,
  };
  if (ephemeral) payload.flags = MESSAGE_FLAG_EPHEMERAL;
  return interaction.reply(payload);
}

/**
 * Defer an interaction reply as ephemeral. Keeps the raw Discord flag in
 * one place for longer-running command branches.
 */
function deferEphemeralReply(interaction) {
  return interaction.deferReply({ flags: MESSAGE_FLAG_EPHEMERAL });
}

/**
 * Follow up with a notice embed, ephemeral by default. Mirrors
 * replyNotice for component flows that already used deferUpdate and need
 * a lightweight toast without re-rendering the source message.
 */
function followUpNotice(interaction, EmbedBuilder, options, { ephemeral = true } = {}) {
  const payload = {
    embeds: [buildNoticeEmbed(EmbedBuilder, options)],
  };
  if (ephemeral) payload.flags = MESSAGE_FLAG_EPHEMERAL;
  return interaction.followUp(payload);
}

/**
 * editReply with a notice embed. Used for follow-up edits on a deferred
 * reply or after a slow operation. ephemeral flag is determined by the
 * original deferReply, so this wrapper just edits in place.
 */
function editNotice(interaction, EmbedBuilder, options, extras = {}) {
  return interaction.editReply({
    ...extras,
    embeds: [buildNoticeEmbed(EmbedBuilder, options)],
  });
}

/**
 * editReply with already-built embed(s). Pairs with replyEmbed for
 * deferred branches that build richer custom embeds.
 */
function editEmbed(interaction, embedOrEmbeds, extras = {}) {
  return interaction.editReply({
    ...extras,
    embeds: Array.isArray(embedOrEmbeds) ? embedOrEmbeds : [embedOrEmbeds],
  });
}

/**
 * component.update with a notice embed - used by collector handlers
 * that swap a button-bearing message into a final state. Components
 * default to empty (= remove the buttons), pass `components` in
 * `extras` to keep them.
 */
function updateNotice(component, EmbedBuilder, options, { components = [] } = {}) {
  return component.update({
    embeds: [buildNoticeEmbed(EmbedBuilder, options)],
    components,
  });
}

// Frozen zero-width-space inline field used as a 2-column layout spacer.
// Discord auto-packs `inline: true` fields up to 3 per row; injecting one
// of these between every char card forces exactly 2 cards per row instead.
// Kept frozen so accidental mutation (e.g. a caller setting `.inline =
// false`) can't poison every other render that shares the reference.
const INLINE_SPACER = Object.freeze({
  name: "​",
  value: "​",
  inline: true,
});

/**
 * Re-pack an array of inline-true fields into a 2-column layout by
 * interleaving INLINE_SPACER between each pair. The trailing card on an
 * odd-length array gets one extra spacer so Discord doesn't stretch it
 * to full width on the last row.
 *
 *   pack2Columns([A, B, C]) → [A, spacer, B, A, spacer, spacer]   ❌ wrong
 *
 * Output shape is `[A, spacer, B, C, spacer, spacer]` -
 *   row 1: A | spacer | B
 *   row 2: C | spacer | spacer
 * Discord renders 3 inline fields per row, so the spacer at index 1
 * pushes B to a new column visually inside row 1, etc.
 */
function pack2Columns(fields) {
  const out = [];
  for (let i = 0; i < fields.length; i += 2) {
    out.push(fields[i]);
    out.push(INLINE_SPACER);
    out.push(fields[i + 1] ? fields[i + 1] : INLINE_SPACER);
  }
  return out;
}

module.exports = {
  addChunkedEmbedField,
  buildNoticeEmbed,
  buildDetailField,
  buildNoRosterNotice,
  buildRosterNotFoundNotice,
  formatCharacterLabel,
  NoticeKind,
  ConcurrencyLimiter,
  UI,
  normalizeName,
  foldName,
  parseItemLevel,
  parseCombatScore,
  toModeLabel,
  toModeKey,
  getCharacterName,
  getCharacterClass,
  truncateText,
  formatShortRelative,
  formatNextCooldownRemaining,
  waitWithBudget,
  buildDiscordIdentityFields,
  INLINE_SPACER,
  pack2Columns,
  formatProgressTotals,
  formatAutoManageFreshnessLine,
  formatGold,
  replyNotice,
  replyEmbed,
  deferEphemeralReply,
  followUpNotice,
  editNotice,
  editEmbed,
  updateNotice,
};
