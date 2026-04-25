#!/usr/bin/env node
/**
 * upload-class-emoji.js
 *
 * Bulk-upload class icon PNGs from `assets/class-icons/` as Discord
 * **application emoji** (owned by the bot application, NOT by any single
 * guild), then write the resulting emoji-id map to
 * `assets/class-icons/emoji-map.json`. The bot reads that JSON at startup
 * (via `data/Class.js`) and merges it into `CLASS_EMOJI_MAP` so the char
 * field renderers can prefix `<:bard:123>` before each character name.
 *
 * Why application emoji instead of guild emoji:
 *   - Application emoji are owned by the bot's application, not any
 *     individual guild. The bot can use them in EVERY guild it's in
 *     without needing per-guild upload + permission setup.
 *   - Don't consume Thaemine's 50-slot guild emoji budget (which is
 *     community-shared with member-uploaded emojis).
 *   - Application emoji limit is 2000 per app vs 50 free / 250 boosted
 *     for guild emoji - room for class icons + future feature emoji.
 *   - No "Manage Expressions" permission needed in any guild - the bot
 *     owns the emoji as an application asset.
 *
 * Why a script instead of the Discord UI:
 *   - 23+ files to upload, each requiring a name + a paste-back step
 *   - Discord's developer portal doesn't bulk-import emoji
 *   - This script gets the IDs straight from the API response and dumps a
 *     ready-to-commit JSON file in one shot
 *
 * Requires:
 *   - DISCORD_TOKEN (bot token, .env). The application ID is derived
 *     automatically via `GET /applications/@me` so no extra env var.
 *
 * Usage:
 *   node scripts/upload-class-emoji.js          # upload + write map
 *   node scripts/upload-class-emoji.js --dry    # validate setup, no upload
 *   node scripts/upload-class-emoji.js --force  # re-upload even if name
 *                                                already exists in app
 *
 * Idempotent by default: if an application emoji with the same name
 * already exists, the script SKIPS the upload and reuses the existing
 * ID. Re-runs are cheap (only new files actually upload) and won't
 * waste application emoji slots.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");

const { CLASS_NAMES } = require("../src/data/Class");

const DISCORD_API = "https://discord.com/api/v10";
const ICONS_DIR = path.resolve(__dirname, "..", "assets", "class-icons");
const OUTPUT_MAP = path.join(ICONS_DIR, "emoji-map.json");

const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry");
const FORCE = ARGS.has("--force");

function die(msg, code = 1) {
  console.error(`✖ ${msg}`);
  process.exit(code);
}

function discordRequest(method, route, { token, body, contentType } = {}) {
  const url = new URL(DISCORD_API + route);
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bot ${token}`,
      "User-Agent": "LostArkRaidManageBot (class-emoji-uploader, 1.0)",
    };
    let payload;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = contentType || "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
            } catch (err) {
              resolve({ status: res.statusCode, body: data });
            }
          } else {
            // Discord rate-limit response is JSON with retry_after; surface
            // the body so the caller can see what went wrong.
            reject(new Error(`HTTP ${res.statusCode} ${method} ${route}: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchAppId({ token }) {
  const { body } = await discordRequest("GET", "/applications/@me", { token });
  if (!body?.id) {
    throw new Error("Could not resolve application id from /applications/@me");
  }
  return body.id;
}

async function fetchExistingEmojis({ token, appId }) {
  // Application emoji list endpoint. Wraps the array in `{ items: [...] }`
  // unlike the guild endpoint which returns the array directly - normalize
  // here so the rest of the script doesn't need to know.
  const { body } = await discordRequest(
    "GET",
    `/applications/${appId}/emojis`,
    { token }
  );
  const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
  const byName = new Map();
  for (const e of items) {
    byName.set(e.name, e);
  }
  return byName;
}

async function uploadEmoji({ token, appId, name, imageBuffer, mime }) {
  const dataUri = `data:${mime};base64,${imageBuffer.toString("base64")}`;
  const { body } = await discordRequest("POST", `/applications/${appId}/emojis`, {
    token,
    body: { name, image: dataUri },
  });
  return body;
}

function detectMime(buffer) {
  // PNG signature: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  // RIFF .... WEBP signature
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

// Bible class IDs that share art with another class (alias) - we upload ONE
// emoji and the JSON map points both display names at the same emoji ID.
// Saves Discord emoji slots (50 free per guild).
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

async function main() {
  const { DISCORD_TOKEN } = process.env;
  if (!DISCORD_TOKEN) die("DISCORD_TOKEN missing in env (.env)");
  if (!fs.existsSync(ICONS_DIR)) die(`Icons dir not found: ${ICONS_DIR}`);

  const files = fs
    .readdirSync(ICONS_DIR)
    .filter((f) => /\.(png|webp|gif|jpg|jpeg)$/i.test(f))
    .sort();
  if (files.length === 0) die(`No image files in ${ICONS_DIR}`);

  console.log(`Found ${files.length} image file(s) in assets/class-icons/`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no uploads)" : FORCE ? "FORCE (re-upload existing)" : "IDEMPOTENT (skip existing)"}`);
  console.log("");

  let appId = null;
  let existing = new Map();
  if (!DRY_RUN) {
    appId = await fetchAppId({ token: DISCORD_TOKEN });
    console.log(`Resolved application id: ${appId}`);
    existing = await fetchExistingEmojis({ token: DISCORD_TOKEN, appId });
    console.log(`Application has ${existing.size} existing emoji(s) currently.`);
    console.log("");
  }

  // Map: { displayName: "<:emojiName:emojiId>", ... }
  const emojiMap = {};
  // Per-bibleId emoji ID lookup (used by alias resolution)
  const idByBibleId = {};
  let uploaded = 0;
  let reused = 0;
  let aliasResolved = 0;
  let skipped = 0;
  let failed = 0;

  // Pass 1: upload non-alias entries first so canonical IDs exist before
  // aliases try to resolve.
  const sortedFiles = files.sort((a, b) => {
    const aId = path.parse(a).name;
    const bId = path.parse(b).name;
    const aIsAlias = !!findCanonicalAlias(aId);
    const bIsAlias = !!findCanonicalAlias(bId);
    if (aIsAlias === bIsAlias) return aId.localeCompare(bId);
    return aIsAlias ? 1 : -1;
  });

  for (const filename of sortedFiles) {
    const bibleId = path.parse(filename).name;
    const displayName = CLASS_NAMES[bibleId];
    if (!displayName) {
      console.warn(`  ? ${filename}: bible ID "${bibleId}" not in CLASS_NAMES, skip`);
      skipped += 1;
      continue;
    }
    const emojiName = bibleId; // already lowercase + underscore per Discord rules

    // Alias path: don't upload, just point at canonical's already-uploaded ID
    const canonical = findCanonicalAlias(bibleId);
    if (canonical) {
      const canonicalId = idByBibleId[canonical];
      if (canonicalId) {
        emojiMap[displayName] = `<:${canonical}:${canonicalId}>`;
        idByBibleId[bibleId] = canonicalId;
        aliasResolved += 1;
        console.log(`  ↪ ${filename} -> alias of ${canonical} (display: ${displayName})`);
        continue;
      }
      // Canonical not found yet (DRY run, or canonical missing) - skip alias.
      console.warn(`  ? ${filename}: canonical "${canonical}" not uploaded yet, skip alias`);
      skipped += 1;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [dry] ${filename} -> would upload as :${emojiName}: (display: ${displayName})`);
      continue;
    }

    if (existing.has(emojiName) && !FORCE) {
      const e = existing.get(emojiName);
      emojiMap[displayName] = `<:${e.name}:${e.id}>`;
      idByBibleId[bibleId] = e.id;
      reused += 1;
      console.log(`  = ${filename} -> reuse existing :${e.name}:${e.id} (display: ${displayName})`);
      continue;
    }

    try {
      const buffer = fs.readFileSync(path.join(ICONS_DIR, filename));
      const mime = detectMime(buffer);
      // Discord 256KB cap on emoji uploads. Files in this folder are <15KB
      // each but defend against future re-sourced art that might be heavier.
      if (buffer.byteLength > 256 * 1024) {
        console.warn(`  ✖ ${filename}: ${buffer.byteLength}B exceeds 256KB cap, skip`);
        failed += 1;
        continue;
      }
      const created = await uploadEmoji({
        token: DISCORD_TOKEN,
        appId,
        name: emojiName,
        imageBuffer: buffer,
        mime,
      });
      emojiMap[displayName] = `<:${created.name}:${created.id}>`;
      idByBibleId[bibleId] = created.id;
      uploaded += 1;
      console.log(`  + ${filename} -> uploaded as :${created.name}:${created.id} (display: ${displayName})`);
      // Application emoji rate limit: similar to guild emoji ceiling
      // (~50/30s). Sleep 250ms between uploads to stay well under
      // without making the script slow.
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed += 1;
      console.warn(`  ✖ ${filename}: ${err?.message || err}`);
    }
  }

  console.log("");
  console.log(`Done: uploaded=${uploaded} reused=${reused} alias-resolved=${aliasResolved} skipped=${skipped} failed=${failed}`);

  if (!DRY_RUN && Object.keys(emojiMap).length > 0) {
    fs.writeFileSync(OUTPUT_MAP, JSON.stringify(emojiMap, null, 2) + "\n");
    console.log(`Wrote ${Object.keys(emojiMap).length} entries to ${path.relative(process.cwd(), OUTPUT_MAP)}`);
    console.log("");
    console.log("Next: commit emoji-map.json and push. The bot reads it at");
    console.log("startup via data/Class.js and class icons render in the next");
    console.log("/raid-status and /raid-check open.");
  } else if (DRY_RUN) {
    console.log("(dry run - no upload + no JSON written)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
