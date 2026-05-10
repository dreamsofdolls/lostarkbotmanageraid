const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getEmojiAssetDirs } = require("../bot/services/discord/emoji-bootstrap");

test("emoji bootstrap resolves icon folders from the repo root assets directory", () => {
  const dirs = getEmojiAssetDirs();

  assert.equal(path.basename(dirs.rootAssetsDir), "assets");
  assert.ok(fs.existsSync(path.join(dirs.classIconsDir, "bard.png")));
  assert.ok(fs.existsSync(path.join(dirs.artistIconsDir, "shy.png")));
  assert.doesNotMatch(dirs.classIconsDir.replace(/\\/g, "/"), /\/bot\/assets\//);
  assert.doesNotMatch(dirs.artistIconsDir.replace(/\\/g, "/"), /\/bot\/assets\//);
});
