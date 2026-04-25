/**
 * class-emoji-bootstrap.js
 *
 * Bot-startup bootstrap for class icons. Runs inside `ClientReady` and
 * does whatever's needed to make `getClassEmoji(name)` return a real
 * `<:bard:123>` form for every class with a PNG in
 * `assets/class-icons/`. After this completes the char-field renderers
 * in /raid-status + /raid-check show class icons inline.
 *
 * Why bot-startup instead of a manual script:
 *   - Traine wants the deploy flow to be just "git push -> Railway"
 *   - One-time-script-then-commit-JSON pattern adds a step Traine has
 *     to remember any time class art is added or replaced
 *   - The bot already has DISCORD_TOKEN + the discord.js REST manager,
 *     so it can do this work itself with zero new credentials
 *
 * Idempotent: lists existing application emoji on every startup, only
 * uploads PNGs whose name doesn't already exist. After the first deploy
 * uploads ~25 emoji, every subsequent startup is just one GET + skip
 * (~500ms overhead). Safe to run on every restart.
 *
 * Self-healing: if an application emoji gets manually deleted from the
 * Discord developer portal, the next bot restart re-uploads it.
 *
 * Failure mode: any error (REST blocked, app emoji slot exhausted, etc.)
 * is logged and swallowed. Bot keeps running with whatever subset of
 * CLASS_EMOJI_MAP entries got populated; getClassEmoji falls back to
 * empty string for the unmapped ones - char fields render without
 * icons but everything else works.
 */

const fs = require("fs");
const path = require("path");

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

/**
 * Bootstrap class emoji for the running bot.
 * @param {import('discord.js').Client} client - Logged-in discord.js client.
 * @returns {Promise<{uploaded: number, reused: number, aliasResolved: number, skipped: number, failed: number, total: number}>}
 */
async function bootstrapClassEmoji(client) {
  if (!fs.existsSync(ICONS_DIR)) {
    console.warn(
      `[class-emoji] icons dir not found at ${ICONS_DIR}; skipping bootstrap`
    );
    return { uploaded: 0, reused: 0, aliasResolved: 0, skipped: 0, failed: 0, total: 0 };
  }

  const files = fs
    .readdirSync(ICONS_DIR)
    .filter((f) => /\.(png|webp|gif|jpg|jpeg)$/i.test(f));
  if (files.length === 0) {
    console.warn(`[class-emoji] no image files in ${ICONS_DIR}; skipping bootstrap`);
    return { uploaded: 0, reused: 0, aliasResolved: 0, skipped: 0, failed: 0, total: 0 };
  }

  const appId = client.application?.id || client.user?.id;
  if (!appId) {
    console.warn("[class-emoji] could not resolve application id; skipping bootstrap");
    return { uploaded: 0, reused: 0, aliasResolved: 0, skipped: 0, failed: 0, total: 0 };
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
    return { uploaded: 0, reused: 0, aliasResolved: 0, skipped: 0, failed: 0, total: 0 };
  }

  // Upload non-alias entries first so canonical IDs exist when aliases
  // try to resolve. Sort canonical ahead of aliases.
  const sortedFiles = files.sort((a, b) => {
    const aIsAlias = !!findCanonicalAlias(path.parse(a).name);
    const bIsAlias = !!findCanonicalAlias(path.parse(b).name);
    if (aIsAlias === bIsAlias) return a.localeCompare(b);
    return aIsAlias ? 1 : -1;
  });

  const idByBibleId = {};
  let uploaded = 0;
  let reused = 0;
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
    const emojiName = bibleId;

    // Alias path: don't upload, point at canonical's emoji ID
    const canonical = findCanonicalAlias(bibleId);
    if (canonical) {
      const canonicalId = idByBibleId[canonical];
      if (canonicalId) {
        CLASS_EMOJI_MAP[displayName] = `<:${canonical}:${canonicalId}>`;
        idByBibleId[bibleId] = canonicalId;
        aliasResolved += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    // Existing emoji: reuse without re-uploading
    if (existingByName.has(emojiName)) {
      const e = existingByName.get(emojiName);
      CLASS_EMOJI_MAP[displayName] = `<:${e.name}:${e.id}>`;
      idByBibleId[bibleId] = e.id;
      reused += 1;
      continue;
    }

    // Upload missing emoji
    try {
      const buffer = fs.readFileSync(path.join(ICONS_DIR, filename));
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
        body: { name: emojiName, image: dataUri },
      });
      if (!created?.id) {
        console.warn(`[class-emoji] ${filename} upload returned no id; skipping`);
        failed += 1;
        continue;
      }
      CLASS_EMOJI_MAP[displayName] = `<:${created.name}:${created.id}>`;
      idByBibleId[bibleId] = created.id;
      uploaded += 1;
      // Application emoji rate limit: ~50 / 30s. Sleep 250ms between
      // uploads to stay well under without making startup feel slow.
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed += 1;
      console.warn(
        `[class-emoji] failed to upload ${filename}:`,
        err?.message || err
      );
    }
  }

  const total = uploaded + reused + aliasResolved;
  console.log(
    `[class-emoji] bootstrap done: uploaded=${uploaded} reused=${reused} aliasResolved=${aliasResolved} skipped=${skipped} failed=${failed} totalActive=${total}`
  );
  return { uploaded, reused, aliasResolved, skipped, failed, total };
}

module.exports = { bootstrapClassEmoji };
