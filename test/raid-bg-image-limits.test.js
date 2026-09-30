"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvas } = require("@napi-rs/canvas");

const {
  processBgAttachment,
  validateBgAttachment,
} = require("../bot/handlers/raid/bg/image-pipeline");

// Header-only files: the dimensions are declared, the pixel data is absent,
// so decoding one would fail. A rejection must come from the header.
function pngHeader(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

function jpegHeader(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8xHeader(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(22, 4);
  buffer.write("WEBP", 8, "ascii");
  buffer.write("VP8X", 12, "ascii");
  buffer.writeUInt32LE(10, 16);
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
}

for (const [format, header, contentType] of [
  ["PNG", pngHeader, "image/png"],
  ["JPEG", jpegHeader, "image/jpeg"],
  ["WebP", webpVp8xHeader, "image/webp"],
]) {
  test(`raid-bg rejects a ${format} over the pixel budget before decoding it`, async () => {
    const buffer = header(8192, 8192);
    await assert.rejects(
      validateBgAttachment({ size: buffer.length, contentType }, buffer),
      (err) => {
        assert.equal(err.key, "raidBg.errors.tooLarge");
        assert.equal(err.params.width, 8192);
        assert.equal(err.params.height, 8192);
        return true;
      },
    );
  });
}

for (const [format, contentType] of [["JPEG", "image/jpeg"], ["WebP", "image/webp"]]) {
  test(`raid-bg reads a real ${format} header and accepts it within the budget`, async () => {
    const canvas = createCanvas(1600, 900);
    canvas.getContext("2d").fillRect(0, 0, 1600, 900);
    const buffer = canvas.toBuffer(contentType);
    const validated = await validateBgAttachment({ size: buffer.length, contentType }, buffer);
    assert.equal(validated.width, 1600);
    assert.equal(validated.height, 900);
  });
}

test("raid-bg processes one upload at a time", async (t) => {
  const canvas = createCanvas(1600, 900);
  canvas.getContext("2d").fillRect(0, 0, 1600, 900);
  const png = canvas.toBuffer("image/png");
  let active = 0;
  let peak = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    active += 1;
    peak = Math.max(peak, active);
    return {
      ok: true,
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const attachment = (name) => ({ url: `https://cdn.example/${name}`, name, size: png.length, contentType: "image/png" });
  const results = await Promise.all(["a.png", "b.png", "c.png"].map(async (name) => {
    const processed = await processBgAttachment(attachment(name));
    active -= 1;
    return processed;
  }));

  assert.equal(results.length, 3);
  assert.equal(peak, 1);
});
