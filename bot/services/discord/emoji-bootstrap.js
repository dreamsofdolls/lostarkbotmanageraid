/**
 * emoji-bootstrap.js
 *
 * Bot-startup bootstrap that mirrors PNG files in an assets folder onto
 * the bot's Discord application emoji slots. Used for two distinct
 * concerns today (and easy to extend for future ones):
 *   - **Class icons** (`assets/class-icons/`) -> class display names in
 *     `CLASS_EMOJI_MAP` -> rendered before character names in
 *     /raid-status + /raid-check char fields.
 *   - **Artist persona icons** (`assets/artist-icons/`) -> persona names
 *     in `ARTIST_EMOJI_MAP` -> used in pinned welcome embed + future
 *     bot-voice lines.
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

const CLASS_ICONS_DIR = path.resolve(__dirname, "..", "..", "assets", "class-icons");
const ARTIST_ICONS_DIR = path.resolve(__dirname, "..", "..", "assets", "artist-icons");

// Class IDs that share art with another class - upload ONE emoji and
// point both display names at the same emoji ID. Saves application
// emoji slots (2000 cap, plenty of room, but the dedup is still cleaner).
const CLASS_ALIAS_GROUPS = [
  ["soulmaster", "force_master"], // both = Soulfist
  ["hawkeye", "hawk_eye"], // both = Sharpshooter
];

function detectMime(buffer) {
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  return "application/octet-stream";
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
// the same prefix because we anchor on either no-suffix or `_hex` only.
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
  const { namespace, iconsDir, emojiMap, resolveDisplayKey, aliasGroups = [] } = config;
  const ZERO = { uploaded: 0, reused: 0, refreshed: 0, aliasResolved: 0, aliasCleanedUp: 0, orphans: 0, skipped: 0, failed: 0, total: 0 };

  if (!fs.existsSync(iconsDir)) {
    console.warn(`[${namespace}] icons dir not found at ${iconsDir}; skipping bootstrap`);
    return ZERO;
  }

  const allFiles = fs
    .readdirSync(iconsDir)
    .filter((f) => /\.(png|webp|gif|jpg|jpeg)$/i.test(f));
  if (allFiles.length === 0) {
    console.warn(`[${namespace}] no image files in ${iconsDir}; skipping bootstrap`);
    return ZERO;
  }

  // Dedup by basename. The bootstrap keys every emoji on
  // `path.parse(filename).name` (extension stripped), so two files like
  // `shy.png` + `shy.webp` collide on key "shy". Without this guard, each
  // boot would alternate-delete-reupload the two variants and churn the
  // emoji ID, which silently breaks any pinned message that hardcoded the
  // previous ID. Prefer .png > .gif > .jpg/.jpeg > .webp on conflict and
  // warn loudly so the dev removes the duplicate from the asset folder.
  const extPriority = { png: 0, gif: 1, jpg: 2, jpeg: 2, webp: 3 };
  const filesByBase = new Map();
  for (const f of allFiles) {
    const base = path.parse(f).name;
    const ext = path.parse(f).ext.replace(/^\./, "").toLowerCase();
    const prio = extPriority[ext] ?? 99;
    const current = filesByBase.get(base);
    if (!current || prio < current.prio) {
      filesByBase.set(base, { filename: f, prio });
    }
  }
  if (filesByBase.size !== allFiles.length) {
    const winners = new Set([...filesByBase.values()].map((v) => v.filename));
    const dropped = allFiles.filter((f) => !winners.has(f));
    console.warn(
      `[${namespace}] duplicate basenames in ${iconsDir} - ignoring ${dropped.length} non-preferred file(s): ${dropped.join(", ")}. Remove them from the asset folder to silence this warning.`
    );
  }
  const files = [...filesByBase.values()].map((v) => v.filename);

  const appId = client.application?.id || client.user?.id;
  if (!appId) {
    console.warn(`[${namespace}] could not resolve application id; skipping bootstrap`);
    return ZERO;
  }

  const existingByName = await listAppEmoji({ rest: client.rest, appId, namespace });
  if (!existingByName) return ZERO;

  // Pre-compute alias bookkeeping. Empty `aliasGroups` -> all of this is
  // no-op which keeps the simple-case (artist-icons) cheap.
  const aliasCanonicalByAlias = new Map(); // aliasFileBase -> canonicalFileBase
  const aliasFileBases = new Set();
  for (const group of aliasGroups) {
    const [canonical, ...aliases] = group;
    for (const alias of aliases) {
      aliasCanonicalByAlias.set(alias, canonical);
      aliasFileBases.add(alias);
    }
  }

  // Alias cleanup pass: existing emoji whose name matches a known
  // non-canonical alias is a structural duplicate of the canonical's art.
  // Auto-delete is safe because aliases are KNOWN duplicates by design.
  let aliasCleanedUp = 0;
  for (const [name, emoji] of [...existingByName.entries()]) {
    const candidateBase = name.replace(/_[0-9a-f]{1,12}$/i, "");
    if (aliasFileBases.has(candidateBase)) {
      try {
        await client.rest.delete(`/applications/${appId}/emojis/${emoji.id}`);
        existingByName.delete(name);
        aliasCleanedUp += 1;
        console.log(`[${namespace}] deleted duplicate alias :${name}: (canonical handles it)`);
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.warn(
          `[${namespace}] failed to delete duplicate alias :${name}: (${emoji.id}):`,
          err?.message || err
        );
      }
    }
  }

  // Sort canonical files ahead of aliases so canonical IDs exist by the
  // time aliases try to resolve.
  const sortedFiles = files.sort((a, b) => {
    const aIsAlias = aliasCanonicalByAlias.has(path.parse(a).name);
    const bIsAlias = aliasCanonicalByAlias.has(path.parse(b).name);
    if (aIsAlias === bIsAlias) return a.localeCompare(b);
    return aIsAlias ? 1 : -1;
  });

  const matchedEmojiIds = new Set();
  const idByFileBase = {};
  const fullNameByFileBase = {};

  let uploaded = 0;
  let reused = 0;
  let refreshed = 0;
  let aliasResolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const filename of sortedFiles) {
    const fileBase = path.parse(filename).name;
    const displayKey = resolveDisplayKey(fileBase);
    if (!displayKey) {
      skipped += 1;
      continue;
    }

    // Alias path: don't upload, point at canonical's already-uploaded ID
    const canonical = aliasCanonicalByAlias.get(fileBase);
    if (canonical) {
      const canonicalId = idByFileBase[canonical];
      const canonicalName = fullNameByFileBase[canonical];
      if (canonicalId && canonicalName) {
        emojiMap[displayKey] = `<:${canonicalName}:${canonicalId}>`;
        idByFileBase[fileBase] = canonicalId;
        fullNameByFileBase[fileBase] = canonicalName;
        aliasResolved += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const buffer = fs.readFileSync(path.join(iconsDir, filename));
    const expectedName = expectedEmojiName(fileBase, buffer);
    const existing = findExistingForFileBase(existingByName, fileBase);

    if (existing && existing.name === expectedName) {
      emojiMap[displayKey] = `<:${existing.name}:${existing.id}>`;
      idByFileBase[fileBase] = existing.id;
      fullNameByFileBase[fileBase] = existing.name;
      matchedEmojiIds.add(existing.id);
      reused += 1;
      continue;
    }

    // Refresh path: existing emoji has the wrong name (different hash, or
    // legacy plain name pre-hash bootstrap). Discord emoji image is
    // immutable - delete the stale one then upload fresh content.
    if (existing) {
      try {
        await client.rest.delete(`/applications/${appId}/emojis/${existing.id}`);
        matchedEmojiIds.add(existing.id);
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        console.warn(
          `[${namespace}] failed to delete stale :${existing.name}: (${existing.id}) before refresh:`,
          err?.message || err
        );
        failed += 1;
        continue;
      }
    }

    try {
      const mime = detectMime(buffer);
      if (buffer.byteLength > 256 * 1024) {
        console.warn(
          `[${namespace}] ${filename} is ${buffer.byteLength}B (over 256KB cap); skipping`
        );
        failed += 1;
        continue;
      }
      const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
      const created = await client.rest.post(`/applications/${appId}/emojis`, {
        body: { name: expectedName, image: dataUri },
      });
      if (!created?.id) {
        console.warn(`[${namespace}] ${filename} upload returned no id; skipping`);
        failed += 1;
        continue;
      }
      emojiMap[displayKey] = `<:${created.name}:${created.id}>`;
      idByFileBase[fileBase] = created.id;
      fullNameByFileBase[fileBase] = created.name;
      matchedEmojiIds.add(created.id);
      if (existing) refreshed += 1;
      else uploaded += 1;
      // Application emoji rate limit: ~50 / 30s. Sleep 250ms between
      // mutations to stay well under without making startup feel slow.
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed += 1;
      console.warn(
        `[${namespace}] failed to upload ${filename}:`,
        err?.message || err
      );
    }
  }

  // Orphan detection: app emoji whose name parses as a known displayKey
  // but didn't match any current PNG. Don't auto-delete - could be
  // intentional (different concern), surface for human cleanup.
  const orphanNames = [];
  for (const [name, emoji] of existingByName) {
    if (matchedEmojiIds.has(emoji.id)) continue;
    const candidateBase = name.replace(/_[0-9a-f]{1,12}$/i, "");
    if (resolveDisplayKey(candidateBase)) {
      orphanNames.push(name);
    }
  }
  if (orphanNames.length > 0) {
    console.warn(
      `[${namespace}] orphan emoji on application (no matching PNG in ${path.basename(iconsDir)}/): ${orphanNames.join(", ")} - delete manually at https://discord.com/developers/applications if no longer wanted`
    );
  }

  const total = uploaded + reused + refreshed + aliasResolved;
  console.log(
    `[${namespace}] bootstrap done: uploaded=${uploaded} refreshed=${refreshed} reused=${reused} aliasResolved=${aliasResolved} aliasCleanedUp=${aliasCleanedUp} orphans=${orphanNames.length} skipped=${skipped} failed=${failed} totalActive=${total}`
  );
  return { uploaded, reused, refreshed, aliasResolved, aliasCleanedUp, orphans: orphanNames.length, skipped, failed, total };
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
 * Bootstrap artist persona emoji (`assets/artist-icons/` ->
 * `ARTIST_EMOJI_MAP` keyed by persona name like "shy"). Filename =
 * persona name directly (e.g., `shy.png` -> map key "shy"). No alias
 * groups - each persona expression is unique art.
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

module.exports = {
  bootstrapClassEmoji,
  bootstrapArtistEmoji,
  bootstrapEmojiFolder,
};
