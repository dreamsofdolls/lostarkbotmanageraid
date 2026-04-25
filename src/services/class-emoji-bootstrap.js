/**
 * class-emoji-bootstrap.js
 *
 * Bot-startup bootstrap for class icons. Runs inside `ClientReady` and
 * does whatever's needed to make `getClassEmoji(name)` return a real
 * `<:bard_a3f9b2:123>` form for every class with a PNG in
 * `assets/class-icons/`. After this completes the char-field renderers
 * in /raid-status + /raid-check show class icons inline.
 *
 * **Content-addressed naming.** Each emoji is uploaded with the name
 * `{bibleClassId}_{md5short}` where md5short is the first 6 chars of
 * the PNG's MD5 hash. On every restart the bootstrap:
 *   - Lists existing application emoji
 *   - For each PNG, computes the expected name from current content
 *   - If an existing emoji matches the expected name -> content unchanged,
 *     reuse the ID
 *   - If an existing emoji exists for the bible ID but with a DIFFERENT
 *     hash suffix (or no suffix at all - legacy from pre-hash bootstrap)
 *     -> content changed, DELETE the stale emoji + upload new one
 *   - If no existing emoji for the bible ID -> upload
 *
 * Result: any time a PNG file content changes (new art, color invert,
 * source upgrade) the bot detects it on the next deploy and refreshes
 * Discord's copy automatically. No env var dance, no manual script run.
 *
 * One-time migration cost: first deploy with this code sees the legacy
 * plain-named emoji (`bard`, `paladin`) and treats them as content
 * mismatches because they have no hash suffix. They get deleted +
 * re-uploaded with hash-suffixed names. ~10s overhead, single deploy.
 *
 * Failure mode: any error (REST blocked, app emoji slot exhausted, etc.)
 * is logged and swallowed. Bot keeps running with whatever subset of
 * CLASS_EMOJI_MAP entries got populated; getClassEmoji falls back to
 * empty string for the unmapped ones - char fields render without
 * icons but everything else works.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { CLASS_NAMES, CLASS_EMOJI_MAP } = require("../data/Class");

const ICONS_DIR = path.resolve(__dirname, "..", "..", "assets", "class-icons");

// Bible class IDs that share art with another class - upload ONE emoji
// and point both display names at the same emoji ID. Saves application
// emoji slots (2000 cap, plenty of room, but the dedup is still cleaner).
const ALIAS_GROUPS = [
  ["soulmaster", "force_master"], // both = Soulfist
  ["hawkeye", "hawk_eye"], // both = Sharpshooter
];

function findCanonicalAlias(bibleId) {
  for (const group of ALIAS_GROUPS) {
    if (group.includes(bibleId) && group[0] !== bibleId) return group[0];
  }
  return null;
}

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

function expectedEmojiName(bibleId, buffer) {
  return `${bibleId}_${shortHash(buffer)}`;
}

// Identify an existing application emoji that "belongs" to a given bible
// class ID, regardless of its hash suffix (or lack thereof). Matches:
//   - The exact bible ID with no underscore suffix (legacy pre-hash format)
//   - The bible ID followed by `_` + hex (current hash-suffix format)
// Doesn't accidentally match unrelated emoji that happen to start with
// the same prefix because we anchor on either no-suffix or `_hex` only.
function findExistingForBibleId(existingByName, bibleId) {
  // Exact legacy match
  if (existingByName.has(bibleId)) return existingByName.get(bibleId);
  // Hash-suffixed match: same bible ID + `_` + 1-12 hex chars
  const re = new RegExp(`^${bibleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_[0-9a-f]{1,12}$`);
  for (const [name, emoji] of existingByName) {
    if (re.test(name)) return emoji;
  }
  return null;
}

/**
 * Bootstrap class emoji for the running bot.
 *
 * @param {import('discord.js').Client} client - Logged-in discord.js client.
 * @returns {Promise<{uploaded: number, reused: number, refreshed: number, aliasResolved: number, orphans: number, skipped: number, failed: number, total: number}>}
 */
async function bootstrapClassEmoji(client) {
  const ZERO = { uploaded: 0, reused: 0, refreshed: 0, aliasResolved: 0, orphans: 0, skipped: 0, failed: 0, total: 0 };

  if (!fs.existsSync(ICONS_DIR)) {
    console.warn(
      `[class-emoji] icons dir not found at ${ICONS_DIR}; skipping bootstrap`
    );
    return ZERO;
  }

  const files = fs
    .readdirSync(ICONS_DIR)
    .filter((f) => /\.(png|webp|gif|jpg|jpeg)$/i.test(f));
  if (files.length === 0) {
    console.warn(`[class-emoji] no image files in ${ICONS_DIR}; skipping bootstrap`);
    return ZERO;
  }

  const appId = client.application?.id || client.user?.id;
  if (!appId) {
    console.warn("[class-emoji] could not resolve application id; skipping bootstrap");
    return ZERO;
  }

  let existingByName = new Map();
  try {
    const list = await client.rest.get(`/applications/${appId}/emojis`);
    // Application emoji list endpoint wraps results in `{ items: [...] }`
    // unlike the guild endpoint which returns the array directly.
    const items = Array.isArray(list?.items)
      ? list.items
      : Array.isArray(list)
        ? list
        : [];
    for (const e of items) existingByName.set(e.name, e);
  } catch (err) {
    console.warn(
      `[class-emoji] failed to list app emojis (continuing without bootstrap):`,
      err?.message || err
    );
    return ZERO;
  }

  // Sort canonical files ahead of aliases so canonical IDs exist by the
  // time aliases try to resolve.
  const sortedFiles = files.sort((a, b) => {
    const aIsAlias = !!findCanonicalAlias(path.parse(a).name);
    const bIsAlias = !!findCanonicalAlias(path.parse(b).name);
    if (aIsAlias === bIsAlias) return a.localeCompare(b);
    return aIsAlias ? 1 : -1;
  });

  // Track which existing emoji we matched to a current PNG, so anything
  // left over is a true orphan.
  const matchedEmojiIds = new Set();
  const idByBibleId = {};
  const fullNameByBibleId = {};

  let uploaded = 0;
  let reused = 0;
  let refreshed = 0;
  let aliasResolved = 0;
  let skipped = 0;
  let failed = 0;

  for (const filename of sortedFiles) {
    const bibleId = path.parse(filename).name;
    const displayName = CLASS_NAMES[bibleId];
    if (!displayName) {
      skipped += 1;
      continue;
    }

    // Alias path: don't upload, point at canonical's already-uploaded ID
    const canonical = findCanonicalAlias(bibleId);
    if (canonical) {
      const canonicalId = idByBibleId[canonical];
      const canonicalName = fullNameByBibleId[canonical];
      if (canonicalId && canonicalName) {
        CLASS_EMOJI_MAP[displayName] = `<:${canonicalName}:${canonicalId}>`;
        idByBibleId[bibleId] = canonicalId;
        fullNameByBibleId[bibleId] = canonicalName;
        aliasResolved += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    const buffer = fs.readFileSync(path.join(ICONS_DIR, filename));
    const expectedName = expectedEmojiName(bibleId, buffer);
    const existing = findExistingForBibleId(existingByName, bibleId);

    // Reuse path: existing emoji matches expected hash-suffixed name -
    // content unchanged since last upload, nothing to do but record the ID.
    if (existing && existing.name === expectedName) {
      CLASS_EMOJI_MAP[displayName] = `<:${existing.name}:${existing.id}>`;
      idByBibleId[bibleId] = existing.id;
      fullNameByBibleId[bibleId] = existing.name;
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
          `[class-emoji] failed to delete stale :${existing.name}: (${existing.id}) before refresh:`,
          err?.message || err
        );
        failed += 1;
        continue;
      }
    }

    // Upload (either new or refresh after delete)
    try {
      const mime = detectMime(buffer);
      if (buffer.byteLength > 256 * 1024) {
        console.warn(
          `[class-emoji] ${filename} is ${buffer.byteLength}B (over 256KB cap); skipping`
        );
        failed += 1;
        continue;
      }
      const dataUri = `data:${mime};base64,${buffer.toString("base64")}`;
      const created = await client.rest.post(`/applications/${appId}/emojis`, {
        body: { name: expectedName, image: dataUri },
      });
      if (!created?.id) {
        console.warn(`[class-emoji] ${filename} upload returned no id; skipping`);
        failed += 1;
        continue;
      }
      CLASS_EMOJI_MAP[displayName] = `<:${created.name}:${created.id}>`;
      idByBibleId[bibleId] = created.id;
      fullNameByBibleId[bibleId] = created.name;
      matchedEmojiIds.add(created.id);
      if (existing) refreshed += 1;
      else uploaded += 1;
      // Application emoji rate limit: ~50 / 30s. Sleep 250ms between
      // mutations to stay well under without making startup feel slow.
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed += 1;
      console.warn(
        `[class-emoji] failed to upload ${filename}:`,
        err?.message || err
      );
    }
  }

  // Orphan detection: app emoji whose name parses as a class bible-ID but
  // didn't match any current PNG (matchedEmojiIds didn't pick it up).
  // Don't auto-delete - could be intentional, surface for human cleanup.
  const orphanNames = [];
  for (const [name, emoji] of existingByName) {
    if (matchedEmojiIds.has(emoji.id)) continue;
    // Strip optional `_hex` suffix to get the candidate bible ID.
    const candidateBibleId = name.replace(/_[0-9a-f]{1,12}$/i, "");
    if (CLASS_NAMES[candidateBibleId] !== undefined) {
      orphanNames.push(name);
    }
  }
  if (orphanNames.length > 0) {
    console.warn(
      `[class-emoji] orphan class emoji on application (no matching PNG in assets/class-icons/): ${orphanNames.join(", ")} - delete manually at https://discord.com/developers/applications if no longer wanted`
    );
  }

  const total = uploaded + reused + refreshed + aliasResolved;
  console.log(
    `[class-emoji] bootstrap done: uploaded=${uploaded} refreshed=${refreshed} reused=${reused} aliasResolved=${aliasResolved} orphans=${orphanNames.length} skipped=${skipped} failed=${failed} totalActive=${total}`
  );
  return { uploaded, reused, refreshed, aliasResolved, orphans: orphanNames.length, skipped, failed, total };
}

module.exports = { bootstrapClassEmoji };
