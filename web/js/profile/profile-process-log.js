"use strict";

const DEFAULT_LIMIT = 16;

function defaultEscapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusClass(kind) {
  if (kind === "err") return "status-err";
  if (kind === "ok") return "status-ok";
  if (kind === "warn") return "status-warn";
  return "hint";
}

function rowKind(kind) {
  if (kind === "err" || kind === "ok" || kind === "warn") return kind;
  return "info";
}

function formatProcessTime(date) {
  const d = date instanceof Date ? date : new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function rollingProgressGroup(message) {
  const text = String(message || "");
  if (/^Copying encounters\.db snapshot\.\.\./i.test(text)) {
    return "snapshot-copy";
  }
  if (/encounters\.db/i.test(text) && /\.\.\./.test(text) && /\d+s\b/.test(text)) {
    return "scan-heartbeat";
  }
  if (/MongoDB/i.test(text) && /\d+s\b/.test(text)) {
    return "upload-heartbeat";
  }
  if (/encounters\.db/i.test(text) && /\d+(?:\.\d+)?%/.test(text)) {
    return "snapshot-copy";
  }
  return "";
}

function makeEntry({ kind, message, now, sequence }) {
  const text = String(message || "");
  const group = rollingProgressGroup(text);
  return {
    id: sequence,
    kind: rowKind(kind),
    group,
    message: text,
    time: formatProcessTime(now()),
  };
}

export function renderProfileProcessLogHtml(entries, current, kind, {
  escapeHtml = defaultEscapeHtml,
} = {}) {
  const rows = entries.map((entry) => {
    const kindName = rowKind(entry.kind);
    return [
      `<li class="process-log-row process-log-row--${kindName}">`,
      `<time>${escapeHtml(entry.time)}</time>`,
      '<span class="process-log-dot" aria-hidden="true"></span>',
      `<span class="process-log-message">${escapeHtml(entry.message)}</span>`,
      "</li>",
    ].join("");
  }).join("");

  return [
    '<div class="process-panel" role="status" aria-live="polite">',
    '<div class="process-current">',
    '<span class="process-current-label">Current</span>',
    `<span class="process-current-message ${statusClass(kind)}">${escapeHtml(current)}</span>`,
    "</div>",
    '<ol class="process-log" aria-label="Profile import process log">',
    rows,
    "</ol>",
    "</div>",
  ].join("");
}

export function createProfileProcessLogRenderer({
  container,
  escapeHtml = defaultEscapeHtml,
  limit = DEFAULT_LIMIT,
  now = () => new Date(),
} = {}) {
  let entries = [];
  let sequence = 0;

  function reset() {
    entries = [];
    if (container) {
      container.hidden = true;
      container.innerHTML = "";
    }
  }

  function render(kind, message) {
    if (!container) return;
    if (!kind || !message) {
      reset();
      return;
    }

    const next = makeEntry({
      kind,
      message,
      now,
      sequence: ++sequence,
    });
    const last = entries.at(-1);
    if (
      last
      && (
        last.message === next.message
        || (next.group && last.group === next.group)
      )
    ) {
      entries[entries.length - 1] = { ...last, ...next, id: last.id };
    } else {
      entries.push(next);
      if (entries.length > limit) entries = entries.slice(-limit);
    }

    container.hidden = false;
    container.innerHTML = renderProfileProcessLogHtml(entries, next.message, kind, { escapeHtml });
  }

  return {
    render,
    reset,
    getEntries: () => entries.map((entry) => ({ ...entry })),
  };
}

export const __test = {
  rollingProgressGroup,
  statusClass,
  formatProcessTime,
};
