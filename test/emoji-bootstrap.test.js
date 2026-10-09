const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  bootstrapEmojiFolder,
  getEmojiAssetDirs,
} = require("../bot/services/discord/emoji-bootstrap");

test("emoji bootstrap resolves icon folders from the repo root assets directory", () => {
  const dirs = getEmojiAssetDirs();

  assert.equal(path.basename(dirs.rootAssetsDir), "assets");
  assert.ok(fs.existsSync(path.join(dirs.classIconsDir, "bard.png")));
  assert.ok(fs.existsSync(path.join(dirs.artistIconsDir, "shy.png")));
  assert.doesNotMatch(dirs.classIconsDir.replace(/\\/g, "/"), /\/bot\/assets\//);
  assert.doesNotMatch(dirs.artistIconsDir.replace(/\\/g, "/"), /\/bot\/assets\//);
});

test("generic emoji bootstrap uploads canonical art once and maps aliases to its id", async () => {
  const dirs = getEmojiAssetDirs();
  const postedNames = [];
  const client = {
    application: { id: "app-1" },
    rest: {
      get: async () => [],
      delete: async () => undefined,
      post: async (_route, { body }) => {
        postedNames.push(body.name);
        return { id: "emoji-1", name: body.name };
      },
    },
  };
  const emojiMap = {};

  const result = await bootstrapEmojiFolder(client, {
    namespace: "test-emoji",
    iconsDir: dirs.classIconsDir,
    emojiMap,
    resolveDisplayKey: (fileBase) => (
      ["soulmaster", "force_master"].includes(fileBase) ? fileBase : null
    ),
    aliasGroups: [["soulmaster", "force_master"]],
    mutationDelayMs: 0,
  });

  assert.equal(postedNames.length, 1);
  assert.match(postedNames[0], /^soulmaster_[0-9a-f]{6}$/);
  assert.equal(result.uploaded, 1);
  assert.equal(result.aliasResolved, 1);
  assert.equal(result.total, 2);
  assert.equal(emojiMap.soulmaster, emojiMap.force_master);
});

test("an oversized replacement keeps the uploaded emoji instead of deleting it", async (t) => {
  const os = require("node:os");
  const iconsDir = fs.mkdtempSync(path.join(os.tmpdir(), "emoji-oversize-"));
  t.after(() => fs.rmSync(iconsDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(iconsDir, "big.png"), Buffer.alloc(256 * 1024 + 1));
  const deleted = [];
  const posted = [];
  const client = {
    application: { id: "app-1" },
    rest: {
      get: async () => [{ id: "old-1", name: "big_aaaaaa" }],
      delete: async (route) => { deleted.push(route); },
      post: async (_route, { body }) => { posted.push(body.name); return { id: "new-1", name: body.name }; },
    },
  };
  const emojiMap = {};

  const result = await bootstrapEmojiFolder(client, {
    namespace: "test-emoji",
    iconsDir,
    emojiMap,
    resolveDisplayKey: (fileBase) => (fileBase === "big" ? "big" : null),
    mutationDelayMs: 0,
  });

  assert.deepEqual(deleted, []);
  assert.deepEqual(posted, []);
  assert.equal(emojiMap.big, "<:big_aaaaaa:old-1>");
  // The refresh failed, and the emoji kept in use still counts as active.
  assert.equal(result.failed, 1);
  assert.equal(result.reused, 1);
});
