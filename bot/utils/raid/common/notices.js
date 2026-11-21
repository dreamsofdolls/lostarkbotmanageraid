/**
 * utils/raid/common/notices.js
 * Shared UI palette, NoticeKind taxonomy, notice embed builder, and standard
 * notice/field helpers across RaidManage commands.
 */

"use strict";

const { t, tPick } = require("../../../services/i18n");
const { truncateText } = require("./text");

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
 * so the same situation looks the same in every command. A missing or
 * unknown kind still sends the notice, in the neutral colour with no icon,
 * because the message matters more than its look; the notice drift guard
 * test flags an options object written in source without a kind, but not
 * one assembled at runtime. Every text part is clamped to Discord's
 * limits, since titles and errors can carry user input and an over-long part
 * would make the builder throw.
 *
 * Caller passes EmbedBuilder so this helper stays free of a discord.js
 * import.
 *
 * @param {Function} EmbedBuilder - discord.js EmbedBuilder class
 * @param {object} options
 * @param {string} options.kind - one of NoticeKind.*
 * @param {string} [options.title] - short result, shown behind the icon
 * @param {string} [options.description] - hero sentence, markdown allowed
 * @param {Array<{name: string, value: string, inline?: boolean}|null>} [options.fields] - concrete data; empty values and nulls are dropped
 * @param {string} [options.tip] - next step, shown as the footer behind 💡 with markdown removed
 * @returns {object} the EmbedBuilder instance
 */
function buildNoticeEmbed(EmbedBuilder, { kind, title, description, fields = [], tip } = {}) {
  const style = NOTICE_STYLE_BY_KIND[kind];
  const embed = new EmbedBuilder().setColor(style?.color ?? UI.colors.neutral).setTimestamp(new Date());
  const shownTitle = style ? `${style.icon}  ${title}` : title;
  if (title) embed.setTitle(truncateText(shownTitle, EMBED_TITLE_MAX_LENGTH));
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
 * Notice options whose copy lives at `<keyBase>Title`, `<keyBase>Description`
 * and `<keyBase>Tip`. The vars fill all three, and a pooled key gives one of
 * its phrasings.
 * @param {{kind: string, keyBase: string, lang?: string, vars?: Object}} options
 * @returns {{kind: string, title: string, description: string, tip: string}}
 */
function buildKeyedNotice({ kind, keyBase, lang, vars }) {
  return {
    kind,
    title: tPick(`${keyBase}Title`, lang, vars),
    description: tPick(`${keyBase}Description`, lang, vars),
    tip: tPick(`${keyBase}Tip`, lang, vars),
  };
}

/**
 * The shared "no roster yet" notice, one copy for every command.
 * @param {string} [lang]
 * @returns {{kind: string, title: string, description: string, tip: string}}
 */
function buildNoRosterNotice(lang) {
  return buildKeyedNotice({ kind: NoticeKind.EMPTY, keyBase: "common.notice.noRoster", lang });
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
  return buildKeyedNotice({ kind: NoticeKind.EMPTY, keyBase: "common.notice.rosterNotFound", lang, vars: { rosterName } });
}

/**
 * The "🧾 Chi tiết" field a failure card uses for the technical error,
 * in code font and clamped to the field limit (the two backticks included).
 * @param {string} [detail] - the error text; empty gives no field
 * @param {string} [lang]
 * @returns {{name: string, value: string, inline: boolean}|null}
 */
function buildDetailField(detail, lang) {
  // One inline code span: a backtick would close it early and a line break
  // would split it, so both are flattened.
  const text = String(detail ?? "").replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return {
    name: t("common.fields.details", lang),
    value: `\`${truncateText(text, EMBED_FIELD_VALUE_MAX_LENGTH - 2)}\``,
    inline: false,
  };
}

/**
 * The detail field for a caught error: its message, or the thrown value as
 * text when it is not an Error.
 * @param {unknown} err - what the failed call threw
 * @param {string} [lang]
 * @returns {{name: string, value: string, inline: boolean}|null}
 */
function buildErrorDetailField(err, lang) {
  return buildDetailField(err?.message || String(err), lang);
}

/**
 * The "👥 Ai dùng được: Raid Manager" field a guard card shows when only a
 * Raid Manager may run the command or press the button.
 * @param {string} [lang]
 * @returns {{name: string, value: string, inline: boolean}}
 */
function buildManagerOnlyField(lang) {
  return {
    name: t("common.fields.whoCanUse", lang),
    value: t("common.fields.raidManagerOnly", lang),
    inline: true,
  };
}

module.exports = {
  UI,
  NoticeKind,
  buildNoticeEmbed,
  buildKeyedNotice,
  buildNoRosterNotice,
  buildRosterNotFoundNotice,
  buildDetailField,
  buildErrorDetailField,
  buildManagerOnlyField,
};
