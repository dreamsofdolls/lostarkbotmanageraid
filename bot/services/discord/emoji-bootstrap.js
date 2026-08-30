/**
 * emoji-bootstrap.js
 *
 * Bot-startup bootstrap that mirrors PNG files in an assets folder onto
 * the bot's Discord application emoji slots. Used for two distinct
 * concerns through the same extensible structure:
 *   - **Class icons** (`assets/class-icons/`) -> class display names in
 *     `CLASS_EMOJI_MAP` -> rendered before character names in
 *     /raid-status + /raid-check char fields.
 *   - **Bot expression icons** (`assets/artist-icons/`) -> expression names
 *     in `ARTIST_EMOJI_MAP` -> used in pinned welcome embeds and other
 *     public bot messages.
 *
 * **Content-addressed naming.** Each emoji is uploaded with the name
 * `{fileBaseName}_{md5short}` where md5short is the first 6 chars of
 * the PNG's MD5 hash. On every restart the bootstrap:
 *   - Lists existing application emoji
 *   - For each PNG, computes the expected name from current content
 *   - If an existing emoji matches the expected name -> content unchanged,
 *     reuse the ID
 *   - If an existing emoji exists for the file base but with a DIFFERENT
 *     hash suffix (or no suffix at all - legacy from pre-hash bootstrap)
 *     -> content changed, DELETE the stale emoji + upload new one
 *   - If no existing emoji for the file base -> upload
 *
 * Result: any time a PNG file content changes (new art, color invert,
 * source upgrade) the bot detects it on the next deploy and refreshes
 * Discord's copy automatically. No env var dance, no manual script run.
 *
 * Optional alias-cleanup pass: when `aliasGroups` is provided, every
 * existing app emoji whose name matches a non-canonical alias entry
 * gets auto-deleted (it's a known structural duplicate of the
 * canonical's art). Used by class-icons for soulmaster/force_master
 * (Soulfist) and hawkeye/hawk_eye (Sharpshooter); artist-icons leaves
 * this empty.
 *
 * Failure mode: any error (REST blocked, app emoji slot exhausted, etc.)
 * is logged and swallowed. Bot keeps running with whatever subset of
 * the target map got populated; getter falls back to empty string for
 * the unmapped ones - render paths degrade gracefully without icons.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { CLASS_NAMES, CLASS_EMOJI_MAP } = require("../../models/Class");
const { ARTIST_EMOJI_MAP } = require("../../models/ArtistEmoji");

const ROOT_ASSETS_DIR = path.resolve(__dirname, "..", "..", "..", "assets");
const CLASS_ICONS_DIR = path.join(ROOT_ASSETS_DIR, "class-icons");
const ARTIST_ICONS_DIR = path.join(ROOT_ASSETS_DIR, "artist-icons");

// Class IDs that share art with another class - upload ONE emoji and
// point both display names at the same emoji ID. Saves application
// emoji slots and keeps aliases tied to one uploaded asset.
const CLASS_ALIAS_GROUPS = [
  ["soulmaster", "force_master"], // both = Soulfist
  ["hawkeye", "hawk_eye"], // both = Sharpshooter
];

const MIME_SIGNATURES = [
  { mime: "image/png", segments: [[0, [0x89, 0x50, 0x4e, 0x47]]] },
  { mime: "image/webp", segments: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]] },
  { mime: "image/gif", segments: [[0, [0x47, 0x49, 0x46]]] },
  { mime: "image/jpeg", segments: [[0, [0xff, 0xd8, 0xff]]] },
];

function detectMime(buffer) {
  const signature = MIME_SIGNATURES.find(({ segments }) => segments.every(
    ([offset, bytes]) => bytes.every((byte, index) => buffer[offset + index] === byte)
  ));
  return signature?.mime || "application/octet-stream";
}

function shortHash(buffer) {
  return crypto.createHash("md5").update(buffer).digest("hex").slice(0, 6);
}

function expectedEmojiName(fileBase, buffer) {
  return `${fileBase}_${shortHash(buffer)}`;
}

// Identify an existing application emoji that "belongs" to a given file
// base name, regardless of its hash suffix (or lack thereof). Matches:
//   - The exact base with no underscore suffix (legacy pre-hash format)
//   - The base followed by `_` + hex (current hash-suffix format)
// Doesn't accidentally match unrelated emoji that happen to start with
// the same prefix because matching is anchored to no suffix or `_hex` only.
function findExistingForFileBase(existingByName, fileBase) {
  if (existingByName.has(fileBase)) return existingByName.get(fileBase);
  const re = new RegExp(`^${fileBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[0-9a-f]{1,12}$`);
  for (const [name, emoji] of existingByName) {
    if (re.test(name)) return emoji;
  }
  return null;
}

async function listAppEmoji({ rest, appId, namespace }) {
  try {
    const list = await rest.get(`/applications/${appId}/emojis`);
    const items = Array.isArray(list?.items)
      ? list.items
      : Array.isArray(list)
        ? list
        : [];
    const byName = new Map();
    for (const e of items) byName.set(e.name, e);
    return byName;
  } catch (err) {
    console.warn(
      `[${namespace}] failed to list app emojis (continuing without bootstrap):`,
      err?.message || err
    );
    return null;
  }
}

const EMPTY_BOOTSTRAP_RESULT = Object.freeze({
  uploaded: 0,
  reused: 0,
  refreshed: 0,
  aliasResolved: 0,
  aliasCleanedUp: 0,
  orphans: 0,
  skipped: 0,
  failed: 0,
  total: 0,
});

function emptyBootstrapResult() {
  return { ...EMPTY_BOOTSTRAP_RESULT };
}

function selectPreferredImageFiles(iconsDir, namespace) {
  const allFiles = fs
    .readdirSync(iconsDir)
    .filter((filename) => /\.(png|webp|gif|jpg|jpeg)$/i.test(filename));
  const extPriority = { png: 0, gif: 1, jpg: 2, jpeg: 2, webp: 3 };
  const preferredByBase = new Map();
  for (const filename of allFiles) {
    const parsed = path.parse(filename);
    const priority = extPriority[parsed.ext.replace(/^\./, "").toLowerCase()] ?? 99;
    const current = preferredByBase.get(parsed.name);
    if (!current || priority < current.priority) {
      preferredByBase.set(parsed.name, { filename, priority });
    }
  }

  if (preferredByBase.size !== allFiles.length) {
    const winners = new Set([...preferredByBase.values()].map((entry) => entry.filename));
    const dropped = allFiles.filter((filename) => !winners.has(filename));
    console.warn(
      `[${namespace}] duplicate basenames in ${iconsDir} - ignoring ${dropped.length} non-preferred file(s): ${dropped.join(", ")}. Remove them from the asset folder to silence this warning.`
    );
  }
  return [...preferredByBase.values()].map((entry) => entry.filename);
}

function createAliasIndex(aliasGroups) {
  const canonicalByAlias = new Map();
  const aliases = new Set();
  for (const [canonical, ...groupAliases] of aliasGroups) {
    for (const alias of groupAliases) {
      canonicalByAlias.set(alias, canonical);
      aliases.add(alias);
    }
  }
  return { canonicalByAlias, aliases };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupAliasEmoji({ client, appId, namespace, existingByName, aliases, delayMs }) {
  let cleaned = 0;
  for (const [name, emoji] of [...existingByName.entries()]) {
    const candidateBase = name.replace(/_[0-9a-f]{1,12}$/i, "");
    if (!aliases.has(candidateBase)) continue;
    try {
      await client.rest.delete(`/applications/${appId}/emojis/${emoji.id}`);
      existingByName.delete(name);
      cleaned += 1;
      console.log(`[${namespace}] deleted duplicate alias :${name}: (canonical handles it)`);
      await delay(delayMs);
    } catch (err) {
      console.warn(
        `[${namespace}] failed to delete duplicate alias :${name}: (${emoji.id}):`,
        err?.message || err
      );
    }
  }
  return cleaned;
}

function sortCanonicalFilesFirst(files, canonicalByAlias) {
  return [...files].sort((left, right) => {
    const leftIsAlias = canonicalByAlias.has(path.parse(left).name);
    const rightIsAlias = canonicalByAlias.has(path.parse(right).name);
    if (leftIsAlias === rightIsAlias) return left.localeCompare(right);
    return leftIsAlias ? 1 : -1;
  });
}

function createEmojiSyncState(aliasCleanedUp) {
  return {
    matchedEmojiIds: new Set(),
    idByFileBase: {},
    fullNameByFileBase: {},
    uploaded: 0,
    reused: 0,
    refreshed: 0,
    aliasResolved: 0,
    aliasCleanedUp,
    skipped: 0,
    failed: 0,
  };
}

function mapAliasEmoji(fileBase, displayKey, canonical, emojiMap, state) {
  const canonicalId = state.idByFileBase[canonical];
  const canonicalName = state.fullNameByFileBase[canonical];
  if (!canonicalId || !canonicalName) {
    state.skipped += 1;
    return;
  }
  emojiMap[displayKey] = `<:${canonicalName}:${canonicalId}>`;
  state.idByFileBase[fileBase] = canonicalId;
  state.fullNameByFileBase[fileBase] = canonicalName;
  state.aliasResolved += 1;
}

function mapExistingEmoji(fileBase, displayKey, existing, emojiMap, state) {
  emojiMap[displayKey] = `<:${existing.name}:${existing.id}>`;
  state.idByFileBase[fileBase] = existing.id;
  state.fullNameByFileBase[fileBase] = existing.name;
  state.matchedEmojiIds.add(existing.id);
  state.reused += 1;
}

async function deleteStaleEmoji({ client, appId, namespace, existing, state, delayMs }) {
  try {
    await client.rest.delete(`/applications/${appId}/emojis/${existing.id}`);
    state.matchedEmojiIds.add(existing.id);
    await delay(delayMs);
    return true;
  } catch (err) {
    console.warn(
      `[${namespace}] failed to delete stale :${existing.name}: (${existing.id}) before refresh:`,
      err?.message || err
    );
    state.failed += 1;
    return false;
  }
}

async function uploadEmoji({ client, appId, namespace, filename, fileBase, displayKey, buffer, expectedName, existing, emojiMap, state, delayMs }) {
  if (buffer.byteLength > 256 * 1024) {
    console.warn(`[${namespace}] ${filename} is ${buffer.byteLength}B (over 256KB cap); skipping`);
    state.failed += 1;
    return;
  }
  try {
    const dataUri = `data:${detectMime(buffer)};base64,${buffer.toString("base64")}`;
    const created = await client.rest.post(`/applications/${appId}/emojis`, {
      body: { name: expectedName, image: dataUri },
    });
    if (!created?.id) {
      console.warn(`[${namespace}] ${filename} upload returned no id; skipping`);
      state.failed += 1;
      return;
    }
    emojiMap[displayKey] = `<:${created.name}:${created.id}>`;
    state.idByFileBase[fileBase] = created.id;
    state.fullNameByFileBase[fileBase] = created.name;
    state.matchedEmojiIds.add(created.id);
    if (existing) state.refreshed += 1;
    else state.uploaded += 1;
    await delay(delayMs);
  } catch (err) {
    state.failed += 1;
    console.warn(`[${namespace}] failed to upload ${filename}:`, err?.message || err);
  }
}

async function syncEmojiFile({ client, appId, namespace, iconsDir, filename, emojiMap, resolveDisplayKey, canonicalByAlias, existingByName, state, delayMs }) {
  const fileBase = path.parse(filename).name;
  const displayKey = resolveDisplayKey(fileBase);
  if (!displayKey) {
    state.skipped += 1;
    return;
  }

  const canonical = canonicalByAlias.get(fileBase);
  if (canonical) {
    mapAliasEmoji(fileBase, displayKey, canonical, emojiMap, state);
    return;
  }

  const buffer = fs.readFileSync(path.join(iconsDir, filename));
  const expectedName = expectedEmojiName(fileBase, buffer);
  const existing = findExistingForFileBase(existingByName, fileBase);
  if (existing?.name === expectedName) {
    mapExistingEmoji(fileBase, displayKey, existing, emojiMap, state);
    return;
  }
  if (existing && !(await deleteStaleEmoji({ client, appId, namespace, existing, state, delayMs }))) {
    return;
  }
  await uploadEmoji({
    client,
    appId,
    namespace,
    filename,
    fileBase,
    displayKey,
    buffer,
    expectedName,
    existing,
    emojiMap,
    state,
    delayMs,
  });
}

function findOrphanEmojiNames(existingByName, matchedEmojiIds, resolveDisplayKey) {
  const names = [];
  for (const [name, emoji] of existingByName) {
    if (matchedEmojiIds.has(emoji.id)) continue;
    const candidateBase = name.replace(/_[0-9a-f]{1,12}$/i, "");
    if (resolveDisplayKey(candidateBase)) names.push(name);
  }
  return names;
}

function summarizeEmojiSync(state, orphanCount) {
  const total = state.uploaded + state.reused + state.refreshed + state.aliasResolved;
  return {
    uploaded: state.uploaded,
    reused: state.reused,
    refreshed: state.refreshed,
    aliasResolved: state.aliasResolved,
    aliasCleanedUp: state.aliasCleanedUp,
    orphans: orphanCount,
    skipped: state.skipped,
    failed: state.failed,
    total,
  };
}

/**
 * @typedef {object} EmojiBootstrapConfig
 * @property {string} namespace - Log prefix tag (e.g., "class-emoji").
 * @property {string} iconsDir - Absolute path to PNG asset folder.
 * @property {object} emojiMap - Mutable map this bootstrap populates with `<:name:id>` strings, keyed by displayKey.
 * @property {(fileBase: string) => string|null} resolveDisplayKey - Maps PNG base name to the key used in emojiMap. Return null/undefined to skip the file.
 * @property {string[][]} [aliasGroups] - Optional `[[canonical, alias, ...], ...]`. Aliases get pointed at canonical's emoji ID instead of consuming a slot.
 */

/**
 * Generic emoji-folder bootstrap. Mirrors PNG files in `iconsDir` to
 * the bot's application emoji slots, populating `emojiMap` with the
 * resulting `<:name:id>` strings keyed by `resolveDisplayKey(fileBase)`.
 *
 * @param {import('discord.js').Client} client
 * @param {EmojiBootstrapConfig} config
 * @returns {Promise<{uploaded: number, reused: number, refreshed: number, aliasResolved: number, aliasCleanedUp: number, orphans: number, skipped: number, failed: number, total: number}>}
 */
async function bootstrapEmojiFolder(client, config) {
  const {
    namespace,
    iconsDir,
    emojiMap,
    resolveDisplayKey,
    aliasGroups = [],
    mutationDelayMs = 250,
  } = config;

  if (!fs.existsSync(iconsDir)) {
    console.warn(`[${namespace}] icons dir not found at ${iconsDir}; skipping bootstrap`);
    return emptyBootstrapResult();
  }
  const files = selectPreferredImageFiles(iconsDir, namespace);
  if (files.length === 0) {
    console.warn(`[${namespace}] no image files in ${iconsDir}; skipping bootstrap`);
    return emptyBootstrapResult();
  }

  const appId = client.application?.id || client.user?.id;
  if (!appId) {
    console.warn(`[${namespace}] could not resolve application id; skipping bootstrap`);
    return emptyBootstrapResult();
  }

  const existingByName = await listAppEmoji({ rest: client.rest, appId, namespace });
  if (!existingByName) return emptyBootstrapResult();

  const aliasIndex = createAliasIndex(aliasGroups);
  const aliasCleanedUp = await cleanupAliasEmoji({
    client,
    appId,
    namespace,
    existingByName,
    aliases: aliasIndex.aliases,
    delayMs: mutationDelayMs,
  });
  const state = createEmojiSyncState(aliasCleanedUp);
  const sortedFiles = sortCanonicalFilesFirst(files, aliasIndex.canonicalByAlias);
  for (const filename of sortedFiles) {
    await syncEmojiFile({
      client,
      appId,
      namespace,
      iconsDir,
      filename,
      emojiMap,
      resolveDisplayKey,
      canonicalByAlias: aliasIndex.canonicalByAlias,
      existingByName,
      state,
      delayMs: mutationDelayMs,
    });
  }

  // Orphan detection: app emoji whose name parses as a known displayKey
  // but didn't match any current PNG. Don't auto-delete - could be
  // intentional, so report it for manual review instead of deleting it.
  const orphanNames = findOrphanEmojiNames(
    existingByName,
    state.matchedEmojiIds,
    resolveDisplayKey
  );
  if (orphanNames.length > 0) {
    console.warn(
      `[${namespace}] orphan emoji on application (no matching PNG in ${path.basename(iconsDir)}/): ${orphanNames.join(", ")} - delete manually at https://discord.com/developers/applications if no longer wanted`
    );
  }

  const result = summarizeEmojiSync(state, orphanNames.length);
  console.log(
    `[${namespace}] bootstrap done: uploaded=${result.uploaded} refreshed=${result.refreshed} reused=${result.reused} aliasResolved=${result.aliasResolved} aliasCleanedUp=${result.aliasCleanedUp} orphans=${result.orphans} skipped=${result.skipped} failed=${result.failed} totalActive=${result.total}`
  );
  return result;
}

/**
 * Bootstrap class emoji (`assets/class-icons/` -> `CLASS_EMOJI_MAP`
 * keyed by class display name like "Bard"). Filename = bible class ID
 * (e.g., `bard.png`); CLASS_NAMES translates to display name.
 */
function bootstrapClassEmoji(client) {
  return bootstrapEmojiFolder(client, {
    namespace: "class-emoji",
    iconsDir: CLASS_ICONS_DIR,
    emojiMap: CLASS_EMOJI_MAP,
    resolveDisplayKey: (bibleId) => CLASS_NAMES[bibleId] || null,
    aliasGroups: CLASS_ALIAS_GROUPS,
  });
}

/**
 * Bootstrap bot expression emoji (`assets/artist-icons/` ->
 * `ARTIST_EMOJI_MAP`, keyed by names such as "shy"). Each filename maps
 * directly to an expression key (for example, `shy.png` -> "shy").
 * Expression assets do not use alias groups.
 */
function bootstrapArtistEmoji(client) {
  return bootstrapEmojiFolder(client, {
    namespace: "artist-emoji",
    iconsDir: ARTIST_ICONS_DIR,
    emojiMap: ARTIST_EMOJI_MAP,
    resolveDisplayKey: (fileBase) =>
      Object.prototype.hasOwnProperty.call(ARTIST_EMOJI_MAP, fileBase) ? fileBase : null,
  });
}

function getEmojiAssetDirs() {
  return {
    rootAssetsDir: ROOT_ASSETS_DIR,
    classIconsDir: CLASS_ICONS_DIR,
    artistIconsDir: ARTIST_ICONS_DIR,
  };
}

module.exports = {
  bootstrapClassEmoji,
  bootstrapArtistEmoji,
  bootstrapEmojiFolder,
  getEmojiAssetDirs,
};
