"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { frameCaptureImage } = require("../bot/services/raid-log/image-frame");

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
