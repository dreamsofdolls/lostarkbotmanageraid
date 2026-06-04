"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require("discord.js");

const COMPONENT_DEPS = { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder };
const { createCanvas, loadImage } = require("@napi-rs/canvas");

const UserBackground = require("../bot/models/userBackground");
const bgLoader = require("../bot/services/raid-card/bg-loader");
const raidBgModule = require("../bot/handlers/raid/bg");
const { createRaidBgCommand } = raidBgModule;

function makeUserModel(language = "en", accountNames = ["Roster A"]) {
  const doc = {
    language,
    accounts: accountNames.map((accountName) => ({ accountName })),
  };
  return {
    findOne: () => ({
      select: () => ({
        lean: async () => doc,
      }),
      lean: async () => doc,
    }),
  };
}

function makePngBuffer(width = 1600, height = 900, color = "#223344") {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas.toBuffer("image/png");
}

function makeSvgBuffer(width = 800, height = 600, color = "#223344") {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${color}"/></svg>`
  );
}

function insertPngChunkBeforeIdat(buffer, type, data) {
  const idatTypeOffset = buffer.indexOf(Buffer.from("IDAT", "ascii"));
  assert.notEqual(idatTypeOffset, -1, "test PNG should contain IDAT");
  const insertOffset = idatTypeOffset - 4;
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(0, 8 + data.length);
  return Buffer.concat([
    buffer.subarray(0, insertOffset),
    chunk,
    buffer.subarray(insertOffset),
  ]);
}

function arrayBufferFromBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function makeAttachment(buffer, overrides = {}) {
  return {
    url: overrides.url || "https://cdn.example/original.png",
    name: overrides.name || "background.png",
    contentType: Object.prototype.hasOwnProperty.call(overrides, "contentType")
      ? overrides.contentType
      : "image/png",
    size: overrides.size ?? buffer.length,
  };
}

function makeCollectorHarness() {
  const handlers = {};
  const collector = {
    on(event, handler) {
      handlers[event] = handler;
      return collector;
    },
    stop(reason) {
      Promise.resolve(handlers.end?.([], reason)).catch(() => {});
    },
  };
  return {
    handlers,
    message: { createMessageComponentCollector: () => collector },
  };
}

function makeSetOptions(attachments, mode = null, action = null) {
  const byName = new Map();
  for (let i = 0; i < attachments.length; i += 1) {
    byName.set(i === 0 ? "image" : `image_${i + 1}`, attachments[i]);
  }
  return {
    getSubcommand: () => "set",
    getAttachment: (name, required = false) => {
      const attachment = byName.get(name) || null;
      if (!attachment && required) {
        throw new Error(`Missing required test attachment: ${name}`);
      }
      return attachment;
    },
    getString: (name) => (name === "action" ? action : mode),
  };
}

test("raid-bg PNG sanitizer strips unsafe metadata chunks before decode", async () => {
  const png = makePngBuffer(800, 600);
  const withCabx = insertPngChunkBeforeIdat(
    png,
    "caBX",
    Buffer.from("c2pa metadata placeholder"),
  );

  assert.equal(
    raidBgModule.__test.detectMime({ contentType: "application/octet-stream" }, withCabx),
    "image/png",
  );

  const stripped = raidBgModule.__test.stripPngAncillaryChunks(withCabx);
  assert.ok(stripped.length < withCabx.length);
  assert.equal(stripped.indexOf(Buffer.from("caBX", "ascii")), -1);

  const decoded = await loadImage(stripped);
  assert.equal(decoded.width, 800);
  assert.equal(decoded.height, 600);
});

test("raid-bg set normalizes uploads to a wide embed image", async (t) => {
  const png = makePngBuffer(800, 1200);
  const originalFetch = global.fetch;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(png),
  });
  let savedUpdate = null;
  UserBackground.findOneAndUpdate = async (_filter, update) => {
    savedUpdate = update;
    return { _id: "doc-1", ...update.$set };
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-1" },
    options: makeSetOptions([
      makeAttachment(png, {
        url: "https://cdn.example/original.png",
        name: "background.png",
      }),
    ]),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  // The resize pipeline always re-encodes to JPEG, so the stored buffer
  // and mime should reflect the post-resize state regardless of source.
  assert.equal(savedUpdate.$set.discordId, "user-1");
  assert.equal(savedUpdate.$set.mode, "even");
  assert.equal(savedUpdate.$set.images.length, 1);
  assert.equal(savedUpdate.$set.images[0].mime, "image/jpeg");
  assert.ok(Buffer.isBuffer(savedUpdate.$set.images[0].imageData));
  assert.ok(savedUpdate.$set.images[0].imageData.length > 0);
  assert.ok(savedUpdate.$set.images[0].imageData.length <= 2 * 1024 * 1024);
  assert.equal(savedUpdate.$set.images[0].originalFilename, "background.png");
  assert.equal(savedUpdate.$set.images[0].width, 1600);
  assert.equal(savedUpdate.$set.images[0].height, 900);
  assert.equal(savedUpdate.$set.images[0].originalWidth, 800);
  assert.equal(savedUpdate.$set.images[0].originalHeight, 1200);
  const storedImage = await loadImage(savedUpdate.$set.images[0].imageData);
  assert.equal(storedImage.width, 1600);
  assert.equal(storedImage.height, 900);
  assert.deepEqual(savedUpdate.$set.assignments, [
    { accountName: "Roster A", accountKey: "roster a", imageIndex: 0 },
  ]);
  assert.equal(savedUpdate.$unset.imageData, "");
  assert.match(edits[0].embeds[0].data.title, /tucked away|Background/i);
});

test("raid-bg set accepts SVG uploads with generic mime and stores them as JPEG", async (t) => {
  const svg = makeSvgBuffer(800, 600);
  const originalFetch = global.fetch;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(svg),
  });
  let savedUpdate = null;
  UserBackground.findOneAndUpdate = async (_filter, update) => {
    savedUpdate = update;
    return { _id: "doc-1", ...update.$set };
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-svg" },
    options: makeSetOptions([
      makeAttachment(svg, {
        url: "https://cdn.example/background.svg",
        name: "background.svg",
        contentType: "application/octet-stream",
      }),
    ]),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.equal(savedUpdate.$set.images.length, 1);
  assert.equal(savedUpdate.$set.images[0].mime, "image/jpeg");
  assert.equal(savedUpdate.$set.images[0].originalMime, "image/svg+xml");
  assert.equal(savedUpdate.$set.images[0].originalWidth, 800);
  assert.equal(savedUpdate.$set.images[0].originalHeight, 600);
  assert.match(edits[0].embeds[0].data.title, /tucked away|Background/i);
});

test("raid-bg set can distribute multiple images across owned rosters", async (t) => {
  const pngA = makePngBuffer(1600, 900, "#112233");
  const pngB = makePngBuffer(1600, 900, "#445566");
  const buffers = new Map([
    ["https://cdn.example/a.png", pngA],
    ["https://cdn.example/b.png", pngB],
  ]);
  const originalFetch = global.fetch;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async (url) => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(buffers.get(url)),
  });
  let savedUpdate = null;
  UserBackground.findOneAndUpdate = async (_filter, update) => {
    savedUpdate = update;
    return { _id: "doc-1", ...update.$set };
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en", ["Roster A", "Roster B", "Roster C"]),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-multi" },
    options: makeSetOptions([
      makeAttachment(pngA, { url: "https://cdn.example/a.png", name: "a.png" }),
      makeAttachment(pngB, { url: "https://cdn.example/b.png", name: "b.png" }),
    ], "even"),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.equal(savedUpdate.$set.images.length, 2);
  assert.deepEqual(savedUpdate.$set.assignments.map((entry) => entry.imageIndex), [0, 1, 0]);
  assert.deepEqual(savedUpdate.$set.assignments.map((entry) => entry.accountKey), [
    "roster a",
    "roster b",
    "roster c",
  ]);
  assert.match(edits[0].embeds[0].data.fields[0].value, /2/);
});

test("raid-bg set counts shared rosters in the viewer's own image pool", async (t) => {
  const pngA = makePngBuffer(1600, 900, "#112233");
  const pngB = makePngBuffer(1600, 900, "#445566");
  const buffers = new Map([
    ["https://cdn.example/a.png", pngA],
    ["https://cdn.example/b.png", pngB],
  ]);
  const originalFetch = global.fetch;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async (url) => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(buffers.get(url)),
  });
  let savedUpdate = null;
  UserBackground.findOneAndUpdate = async (_filter, update) => {
    savedUpdate = update;
    return { _id: "doc-1", ...update.$set };
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en", ["Own Roster"]),
    getAccessibleAccounts: async () => [
      { accountName: "Own Roster", ownerDiscordId: "viewer", isOwn: true },
      { accountName: "Shared Roster", ownerDiscordId: "owner-a", isOwn: false },
    ],
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "viewer" },
    options: makeSetOptions([
      makeAttachment(pngA, { url: "https://cdn.example/a.png", name: "a.png" }),
      makeAttachment(pngB, { url: "https://cdn.example/b.png", name: "b.png" }),
    ]),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.equal(savedUpdate.$set.discordId, "viewer");
  assert.equal(savedUpdate.$set.images.length, 2);
  assert.deepEqual(savedUpdate.$set.assignments.map((entry) => entry.accountKey), [
    "own roster",
    "shared roster",
  ]);
  // Count now shows scenes / library cap (6), not / roster count.
  assert.match(edits[0].embeds[0].data.fields[0].value, /2\/6/);
});

test("raid-bg set saves more images than roster count (library decoupled from rosters)", async (t) => {
  const pngA = makePngBuffer(1600, 900, "#112233");
  const pngB = makePngBuffer(1600, 900, "#445566");
  const buffers = new Map([
    ["https://cdn.example/a.png", pngA],
    ["https://cdn.example/b.png", pngB],
  ]);
  const originalFetch = global.fetch;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async (url) => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(buffers.get(url)),
  });
  let savedUpdate = null;
  UserBackground.findOneAndUpdate = async (_filter, update) => {
    savedUpdate = update;
    return { _id: "doc-1", ...update.$set };
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en", ["Only Roster"]),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-decoupled" },
    options: makeSetOptions([
      makeAttachment(pngA, { url: "https://cdn.example/a.png", name: "a.png" }),
      makeAttachment(pngB, { url: "https://cdn.example/b.png", name: "b.png" }),
    ]),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  // Library no longer caps by roster count: 2 scenes save even with 1 roster.
  assert.equal(savedUpdate.$set.images.length, 2);
  // The single roster maps to scene #1; scene #2 is a spare.
  assert.deepEqual(savedUpdate.$set.assignments.map((entry) => entry.imageIndex), [0]);
});

test("raid-bg set action:extend appends the upload to the existing library", async (t) => {
  const existingPng = makePngBuffer(1600, 900, "#111111");
  const newPng = makePngBuffer(1600, 900, "#222222");
  const originalFetch = global.fetch;
  const originalFindOne = UserBackground.findOne;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => arrayBufferFromBuffer(newPng) });
  UserBackground.findOne = () => ({
    lean: async () => ({
      mode: "even",
      images: [
        { imageData: existingPng, width: 1600, height: 900, originalFilename: "old.png", mime: "image/jpeg", sizeBytes: existingPng.length },
      ],
      assignments: [{ accountName: "Roster A", accountKey: "roster a", imageIndex: 0 }],
    }),
  });
  let savedUpdate = null;
  UserBackground.findOneAndUpdate = async (_filter, update) => {
    savedUpdate = update;
    return { _id: "doc-1", ...update.$set };
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOne = originalFindOne;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en", ["Roster A", "Roster B"]),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-extend" },
    options: makeSetOptions(
      [makeAttachment(newPng, { url: "https://cdn.example/new.png", name: "new.png" })],
      null,
      "extend",
    ),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  // existing 1 + new 1 = 2 scenes, old kept first.
  assert.equal(savedUpdate.$set.images.length, 2);
  assert.deepEqual(savedUpdate.$set.images.map((image) => image.originalFilename), ["old.png", "new.png"]);
});

test("raid-bg set rejects under-min-dim uploads without writing to the database", async (t) => {
  const tinyPng = makePngBuffer(400, 300);
  const originalFetch = global.fetch;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(tinyPng),
  });
  let persisted = false;
  UserBackground.findOneAndUpdate = async () => {
    persisted = true;
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-2" },
    options: makeSetOptions([
      makeAttachment(tinyPng, {
        url: "https://cdn.example/tiny.png",
        name: "tiny.png",
      }),
    ]),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.equal(persisted, false);
  assert.match(edits[0].embeds[0].data.description, /too tiny|400x300/i);
});

test("raid-bg set rejects oversized downloaded bytes even when attachment.size lies", async (t) => {
  const hugeBuffer = Buffer.alloc(8 * 1024 * 1024 + 1, 0xff);
  const originalFetch = global.fetch;
  const originalUpsert = UserBackground.findOneAndUpdate;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(hugeBuffer),
  });
  let persisted = false;
  UserBackground.findOneAndUpdate = async () => {
    persisted = true;
  };
  t.after(() => {
    global.fetch = originalFetch;
    UserBackground.findOneAndUpdate = originalUpsert;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-oversize" },
    options: makeSetOptions([
      makeAttachment(hugeBuffer, {
        url: "https://cdn.example/oversize.png",
        name: "oversize.png",
        size: 1,
      }),
    ]),
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.equal(persisted, false);
  assert.match(edits[0].embeds[0].data.description, /chunky|8\.0 MB/i);
});

test("raid-bg view returns 'no background yet' when the collection is empty", async (t) => {
  const originalFindOne = UserBackground.findOne;
  UserBackground.findOne = () => ({
    lean: async () => null,
  });
  t.after(() => {
    UserBackground.findOne = originalFindOne;
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-3" },
    options: { getSubcommand: () => "view" },
    deferReply: async () => {},
    editReply: async (payload) => edits.push(payload),
  });

  assert.match(edits[0].embeds[0].data.title, /no background/i);
  assert.equal(edits[0].files, undefined);
});

test("raid-bg view renders a single-scene browser (image + scene dropdown + pager)", async (t) => {
  const pngA = makePngBuffer(1200, 720, "#112233");
  const pngB = makePngBuffer(1200, 720, "#445566");
  const originalFindOne = UserBackground.findOne;
  UserBackground.findOne = () => ({
    lean: async () => ({
      mode: "even",
      images: [
        { imageData: pngA, width: 1200, height: 720, originalFilename: "stored-a.png" },
        { imageData: pngB, width: 1200, height: 720, originalFilename: "stored-b.png" },
      ],
      assignments: [
        { accountName: "Roster A", accountKey: "roster a", imageIndex: 0 },
        { accountName: "Roster B", accountKey: "roster b", imageIndex: 1 },
      ],
      updatedAt: new Date(),
    }),
  });
  t.after(() => {
    UserBackground.findOne = originalFindOne;
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
    ...COMPONENT_DEPS,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-4" },
    options: { getSubcommand: () => "view" },
    deferReply: async () => {},
    // No createMessageComponentCollector on the return -> handler renders the
    // first frame and returns (no live collector needed for this assertion).
    editReply: async (payload) => { edits.push(payload); return payload; },
  });

  const payload = edits[0];
  // One scene shown as the embed image (not N stacked preview embeds).
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].data.image.url, "attachment://raid-bg-scene.jpg");
  assert.equal(payload.files.length, 1);
  const customIds = payload.components.flatMap((row) => row.components.map((c) => c.data.custom_id));
  assert.ok(customIds.includes("raidbg:scene"), "scene dropdown present");
  assert.ok(customIds.includes("raidbg:prev") && customIds.includes("raidbg:next"), "pager present");
});

test("raid-bg view clears stale attachments when paging scenes", async (t) => {
  const pngA = makePngBuffer(1200, 720, "#112233");
  const pngB = makePngBuffer(1200, 720, "#445566");
  const originalFindOne = UserBackground.findOne;
  UserBackground.findOne = () => ({
    lean: async () => ({
      mode: "even",
      images: [
        { imageData: pngA, width: 1200, height: 720, originalFilename: "stored-a.png" },
        { imageData: pngB, width: 1200, height: 720, originalFilename: "stored-b.png" },
      ],
      assignments: [],
      updatedAt: new Date(),
    }),
  });
  t.after(() => {
    UserBackground.findOne = originalFindOne;
  });

  const harness = makeCollectorHarness();
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
    ...COMPONENT_DEPS,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-view-page" },
    options: { getSubcommand: () => "view" },
    deferReply: async () => {},
    editReply: async () => harness.message,
  });

  assert.equal(typeof harness.handlers.collect, "function");
  let updatePayload = null;
  await harness.handlers.collect({
    customId: "raidbg:next",
    update: async (payload) => { updatePayload = payload; },
  });

  assert.deepEqual(updatePayload.attachments, []);
  assert.equal(updatePayload.files.length, 1);
  assert.equal(updatePayload.files[0].name, "raid-bg-scene.jpg");
});

test("raid-bg edit (no image) opens the delete picker", async (t) => {
  const pngA = makePngBuffer(1200, 720, "#112233");
  const pngB = makePngBuffer(1200, 720, "#445566");
  const originalFindOne = UserBackground.findOne;
  UserBackground.findOne = () => ({
    lean: async () => ({
      _id: "doc-existing",
      mode: "even",
      images: [
        { imageData: pngA, width: 1200, height: 720, originalFilename: "a.png" },
        { imageData: pngB, width: 1200, height: 720, originalFilename: "b.png" },
      ],
      assignments: [
        { accountName: "Roster A", accountKey: "roster a", imageIndex: 0 },
        { accountName: "Roster B", accountKey: "roster b", imageIndex: 1 },
      ],
      updatedAt: new Date(),
    }),
  });
  t.after(() => {
    UserBackground.findOne = originalFindOne;
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
    ...COMPONENT_DEPS,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-edit-del" },
    options: { getSubcommand: () => "edit", getAttachment: () => null },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); return payload; },
  });

  const customIds = edits[0].components.flatMap((row) => row.components.map((c) => c.data.custom_id));
  assert.ok(customIds.includes("raidbg:scene"), "scene picker present");
  assert.ok(customIds.includes("raidbg:dodelete"), "delete-this button present");
  assert.ok(customIds.includes("raidbg:deleteall"), "delete-all button present");
  assert.ok(!customIds.includes("raidbg:doreplace"), "no replace button in delete mode");
});

test("raid-bg edit delete-all clears stale scene attachments", async (t) => {
  const pngA = makePngBuffer(1200, 720, "#112233");
  const pngB = makePngBuffer(1200, 720, "#445566");
  const originalFindOne = UserBackground.findOne;
  const originalDeleteOne = UserBackground.deleteOne;
  let deleteFilter = null;
  UserBackground.findOne = () => ({
    lean: async () => ({
      _id: "doc-existing",
      mode: "even",
      images: [
        { imageData: pngA, width: 1200, height: 720, originalFilename: "a.png" },
        { imageData: pngB, width: 1200, height: 720, originalFilename: "b.png" },
      ],
      assignments: [],
      updatedAt: new Date(),
    }),
  });
  UserBackground.deleteOne = async (filter) => {
    deleteFilter = filter;
    return { deletedCount: 1 };
  };
  t.after(() => {
    UserBackground.findOne = originalFindOne;
    UserBackground.deleteOne = originalDeleteOne;
    bgLoader.clearBackgroundCache();
  });

  const harness = makeCollectorHarness();
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
    ...COMPONENT_DEPS,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-edit-delete-all" },
    options: { getSubcommand: () => "edit", getAttachment: () => null },
    deferReply: async () => {},
    editReply: async () => harness.message,
  });

  assert.equal(typeof harness.handlers.collect, "function");
  let updatePayload = null;
  await harness.handlers.collect({
    customId: "raidbg:deleteall",
    update: async (payload) => { updatePayload = payload; },
  });

  assert.deepEqual(deleteFilter, { discordId: "user-edit-delete-all" });
  assert.deepEqual(updatePayload.files, []);
  assert.deepEqual(updatePayload.attachments, []);
  assert.deepEqual(updatePayload.components, []);
});

test("compactAssignmentsAfterRemove reindexes assignments after a slot is removed", () => {
  const { compactAssignmentsAfterRemove } = raidBgModule.__test;
  const assignments = [
    { accountName: "A", accountKey: "a", imageIndex: 0 },
    { accountName: "B", accountKey: "b", imageIndex: 1 },
    { accountName: "C", accountKey: "c", imageIndex: 2 },
  ];
  // Drop image index 1 (2 scenes remain): the >1 index shifts down, the ==1
  // index clamps into range.
  const out = compactAssignmentsAfterRemove(assignments, 1, 2);
  assert.deepEqual(out.map((entry) => entry.imageIndex), [0, 1, 1]);
});

test("raid-bg edit (with image) validates the new upload then opens the replace picker", async (t) => {
  const stored = makePngBuffer(1200, 720, "#112233");
  const incoming = makePngBuffer(1600, 900, "#445566");
  const originalFindOne = UserBackground.findOne;
  const originalFetch = global.fetch;
  UserBackground.findOne = () => ({
    lean: async () => ({
      _id: "doc-existing",
      mode: "even",
      images: [{ imageData: stored, width: 1200, height: 720, originalFilename: "old.png" }],
      assignments: [{ accountName: "Roster A", accountKey: "roster a", imageIndex: 0 }],
      updatedAt: new Date(),
    }),
  });
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => arrayBufferFromBuffer(incoming),
  });
  t.after(() => {
    UserBackground.findOne = originalFindOne;
    global.fetch = originalFetch;
    bgLoader.clearBackgroundCache();
  });

  const edits = [];
  const command = createRaidBgCommand({
    User: makeUserModel("en"),
    AttachmentBuilder,
    EmbedBuilder,
    MessageFlags,
    ...COMPONENT_DEPS,
  });

  await command.handleRaidBgCommand({
    guild: { id: "guild-1" },
    user: { id: "user-edit-rep" },
    options: {
      getSubcommand: () => "edit",
      getAttachment: () => makeAttachment(incoming, { url: "https://cdn.example/new.png", name: "new.png" }),
    },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); return payload; },
  });

  const customIds = edits[0].components.flatMap((row) => row.components.map((c) => c.data.custom_id));
  assert.ok(customIds.includes("raidbg:doreplace"), "replace button present");
  assert.ok(!customIds.includes("raidbg:deleteall"), "no delete controls in replace mode");
});

test("bg-loader cache returns the same buffer on subsequent calls", async (t) => {
  const png = makePngBuffer(1600, 900);
  const ts = new Date();
  const originalFindOne = UserBackground.findOne;
  let metaCalls = 0;
  let dataCalls = 0;
  UserBackground.findOne = (_filter) => ({
    select: (proj) => ({
      lean: async () => {
        if (String(proj).includes("imageData")) {
          dataCalls += 1;
          return {
            images: [
              { imageData: png },
            ],
            assignments: [
              { accountName: "Roster A", accountKey: "roster a", imageIndex: 0 },
            ],
            mode: "even",
            updatedAt: ts,
          };
        }
        metaCalls += 1;
        return { updatedAt: ts };
      },
    }),
  });
  bgLoader.clearBackgroundCache();
  t.after(() => {
    UserBackground.findOne = originalFindOne;
    bgLoader.clearBackgroundCache();
  });

  const first = await bgLoader.loadBackgroundBuffer("cache-user", { accountName: "Roster A" });
  const second = await bgLoader.loadBackgroundBuffer("cache-user", { accountName: "Roster A" });

  assert.ok(Buffer.isBuffer(first));
  assert.equal(first, second);
  assert.equal(dataCalls, 1);
  assert.equal(metaCalls, 2);
});

test("bg-loader selects the assigned image for the requested roster", async (t) => {
  const pngA = makePngBuffer(1600, 900, "#112233");
  const pngB = makePngBuffer(1600, 900, "#445566");
  const ts = new Date();
  const originalFindOne = UserBackground.findOne;
  UserBackground.findOne = () => ({
    select: (proj) => ({
      lean: async () => {
        if (String(proj).includes("imageData")) {
          return {
            images: [
              { imageData: pngA },
              { imageData: pngB },
            ],
            assignments: [
              { accountName: "Roster A", accountKey: "roster a", imageIndex: 0 },
              { accountName: "Roster B", accountKey: "roster b", imageIndex: 1 },
            ],
            mode: "even",
            updatedAt: ts,
          };
        }
        return { updatedAt: ts };
      },
    }),
  });
  bgLoader.clearBackgroundCache();
  t.after(() => {
    UserBackground.findOne = originalFindOne;
    bgLoader.clearBackgroundCache();
  });

  const selected = await bgLoader.loadBackgroundBuffer("owner-user", { accountName: "Roster B" });

  assert.equal(selected, pngB);
});
