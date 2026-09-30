"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { crc32, deflateSync } = require("node:zlib");
const { frameCaptureImage } = require("../bot/services/raid-log/image-frame");

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function filteredScreenshot(channels, filter, { height = 11, transparency = false } = {}) {
  const width = 9;
  const rows = [];
  let previous = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y++) {
    const pixels = Buffer.from(Array.from({ length: width * channels }, (_, index) =>
      (index * 47 + y * 91) % 256));
    const row = Buffer.alloc(pixels.length + 1);
    row[0] = filter;
    for (let index = 0; index < pixels.length; index++) {
      const left = index >= channels ? pixels[index - channels] : 0;
      const up = previous[index];
      const corner = index >= channels ? previous[index - channels] : 0;
      const prediction = left + up - corner;
      const nearest = [left, up, corner].reduce((best, value) =>
        Math.abs(prediction - value) < Math.abs(prediction - best) ? value : best);
      const predictors = [0, left, up, Math.floor((left + up) / 2), nearest];
      row[index + 1] = pixels[index] - predictors[filter];
    }
    rows.push(row);
    previous = pixels;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const compressed = deflateSync(Buffer.concat(rows));
  const transparent = Buffer.from([0, 0, 0, 47, 0, 94]);
  return {
    width, height,
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
      pngChunk("sRGB", Buffer.from([0])),
      ...(transparency ? [pngChunk("tRNS", transparent)] : []),
      pngChunk("IDAT", compressed.subarray(0, 7)), pngChunk("IDAT", compressed.subarray(7)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  };
}

for (const channels of [3, 4]) {
  for (const filter of [0, 1, 2, 3, 4]) {
    test(`streamed framing preserves ${channels === 3 ? "RGB" : "RGBA"} pixels with PNG filter ${filter}`, async () => {
      const source = filteredScreenshot(channels, filter, { transparency: channels === 3 });
      const original = await loadImage(source.buffer);
      const image = await loadImage(await frameCaptureImage(source.buffer, source));
      const input = createCanvas(source.width, source.height).getContext("2d");
      input.drawImage(original, 0, 0);
      const output = createCanvas(image.width, image.height).getContext("2d");
      output.drawImage(image, 0, 0);
      const offset = Math.floor((image.width - source.width) / 2);
      assert.deepEqual(output.getImageData(offset, 0, source.width, source.height).data,
        input.getImageData(0, 0, source.width, source.height).data);
      assert.ok(output.getImageData(0, 0, offset, source.height).data.every(byte => byte === 0));
      assert.ok(output.getImageData(offset + source.width, 0, image.width - offset - source.width, source.height).data
        .every(byte => byte === 0));
    });
  }
}

test("PNG stream rejects corrupted chunks, truncation and mismatching clip dimensions", async () => {
  const source = filteredScreenshot(4, 4);
  const corrupted = Buffer.from(source.buffer);
  corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(frameCaptureImage(corrupted, source), /Invalid PNG screenshot chunk/);
  await assert.rejects(frameCaptureImage(source.buffer.subarray(0, -12), source), /Incomplete PNG screenshot/);
  await assert.rejects(frameCaptureImage(source.buffer, { ...source, width: source.width + 1 }), /dimensions/);
});

test("PNG framing aborts its streams while processing a tall capture", async () => {
  const source = filteredScreenshot(4, 4, { height: 1600 });
  const controller = new AbortController();
  const framing = frameCaptureImage(source.buffer, source, { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(framing, { name: "AbortError" });
});

test("tall captures retain every pixel with centered transparent margins", async () => {
  const source = createCanvas(9, 11);
  const original = source.getContext("2d");
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      original.fillStyle = `rgb(${x * 25}, ${y * 23}, 127)`;
      original.fillRect(x, y, 1, 1);
    }
  }
  const buffer = await frameCaptureImage(await source.encode("png"), source);
  const image = await loadImage(buffer);
  assert.equal(image.width, 15);
  assert.equal(image.height, 11);
  const output = createCanvas(image.width, image.height).getContext("2d");
  output.drawImage(image, 0, 0);
  assert.deepEqual(output.getImageData(3, 0, 9, 11).data, original.getImageData(0, 0, 9, 11).data);
  for (const x of [0, 2, 12, 14]) {
    assert.ok(output.getImageData(x, 0, 1, 11).data.every(value => value === 0));
  }
});

test("Mightymyr Damage gets the minimum frame, with at most one pixel of centering difference", async () => {
  const source = createCanvas(1280, 1214);
  const ctx = source.getContext("2d");
  ctx.fillStyle = "#123456";
  ctx.fillRect(0, 0, source.width, source.height);
  const image = await loadImage(await frameCaptureImage(await source.encode("png"), source));
  assert.equal(image.width, 1619);
  assert.equal(image.height, 1214);
  const output = createCanvas(image.width, image.height).getContext("2d");
  output.drawImage(image, 0, 0);
  assert.deepEqual([...output.getImageData(169, 0, 1, 1).data], [18, 52, 86, 255]);
  assert.deepEqual([...output.getImageData(1448, 1213, 1, 1).data], [18, 52, 86, 255]);
  assert.equal(output.getImageData(168, 0, 1, 1).data[3], 0);
  assert.equal(output.getImageData(1449, 1213, 1, 1).data[3], 0);
});

test("wide captures including Party Buffs return the same buffer without encoding again", async () => {
  const buffer = Buffer.from("already captured");
  for (const dimensions of [{ width: 1536, height: 1010 }, { width: 1600, height: 1200 }]) {
    assert.equal(await frameCaptureImage(buffer, dimensions), buffer);
  }
});
