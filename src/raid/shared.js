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

function parseItemLevel(rawValue) {
  const sanitized = String(rawValue || "0")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  const parsed = parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCombatScore(rawValue) {
  const sanitized = String(rawValue || "0")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "");
  const parsed = parseFloat(sanitized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toModeLabel(modeKey) {
  const lower = normalizeName(modeKey);
  if (lower === "hard") return "Hard";
  if (lower === "nightmare") return "Nightmare";
  return "Normal";
}

function toModeKey(modeLabel) {
  const lower = normalizeName(modeLabel);
  if (lower === "hard" || lower === "hm") return "hard";
  if (lower === "nightmare" || lower === "9m") return "nightmare";
  // `nm` moved from nightmare to normal per Traine's alias preference: in
  // this VN community `nm` reads as "nor-mal" more naturally than "9m".
  // Nightmare keeps `9m` as the sole shorthand.
  return "normal";
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

// Build a richer ephemeral notice embed for user-facing rejection /
// guidance / "session expired" surfaces. Replaces the plain
// `interaction.reply({ content: "⚠️ ..." })` pattern that read flat
// in-channel — color-coded embed reads at a glance and gives the
// Artist persona room for a friendlier voice.
//
// Caller passes EmbedBuilder so this helper stays in raid/shared
// (Discord.js dep doesn't need to leak in here). `type` picks color +
// header icon by intent; defaults: info=blue, warn=yellow, lock=red,
// success=green, error=red, muted=gray.
function buildNoticeEmbed(EmbedBuilder, { type = "info", title, description }) {
  const color =
    type === "warn"
      ? UI.colors.progress
      : type === "lock" || type === "error"
        ? UI.colors.danger
        : type === "success"
          ? UI.colors.success
          : type === "muted"
            ? UI.colors.muted
            : UI.colors.neutral;
  const icon =
    type === "warn"
      ? UI.icons.warn
      : type === "lock"
        ? UI.icons.lock
        : type === "error"
          ? UI.icons.warn
          : type === "success"
            ? UI.icons.done
            : UI.icons.info;
  const embed = new EmbedBuilder().setColor(color);
  if (title) embed.setTitle(`${icon} ${title}`);
  if (description) embed.setDescription(description);
  return embed;
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
function formatProgressTotals(totals, UI) {
  const done = Number(totals?.done) || 0;
  const partial = Number(totals?.partial) || 0;
  const pending = Number(totals?.pending) || 0;
  const notEligible = Number(totals?.notEligible) || 0;
  const parts = [
    `${UI.icons.done} ${done} done`,
    `${UI.icons.partial} ${partial} partial`,
    `${UI.icons.pending} ${pending} pending`,
  ];
  if (notEligible > 0) {
    parts.push(`${UI.icons.lock} ${notEligible} not eligible`);
  }
  return parts.join(" · ");
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
  buildNoticeEmbed,
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
};
