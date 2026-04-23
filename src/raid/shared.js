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
  if (lower === "nightmare" || lower === "nm" || lower === "9m") return "nightmare";
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

module.exports = {
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
};
