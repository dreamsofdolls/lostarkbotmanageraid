"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertSafeSvg, renderSvgInChild } = require("../bot/handlers/raid/bg/svg-render");
const { validateBgAttachment } = require("../bot/handlers/raid/bg/image-pipeline");

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svg = (body, size = 'width="900" height="700"') => `<svg ${NS} ${size}>${body}</svg>`;
const PLAIN = svg(
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#123"/></linearGradient></defs>'
  + '<rect width="900" height="700" fill="url(#g)"/>',
);
const TURBULENCE = svg(
  '<filter id="f"><feTurbulence baseFrequency="0.01" numOctaves="1000000"/></filter>'
  + '<rect width="900" height="700" filter="url(#f)"/>',
  'width="1600" height="1600"',
);

for (const [label, text] of [
  ["a filter", svg('<filter id="f"/>')],
  ["a prefixed filter", `<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:filter id="f"/></svg:svg>`],
  ["a filter under a non-ASCII prefix", svg('<é:filter xmlns:é="http://www.w3.org/2000/svg" id="f"><é:feTurbulence numOctaves="1000"/></é:filter>')],
  ["a use element under a non-ASCII prefix", svg('<名:use xmlns:名="http://www.w3.org/2000/svg" href="#g"/>')],
  ["a filter primitive", svg("<feTurbulence/>")],
  ["an embedded local image", svg('<image xlink:href="/etc/x.png" width="10" height="10"/>')],
  ["a data link", svg('<a href="data:text/html,x"><rect width="1" height="1"/></a>')],
  ["a use element", svg('<use href="#g"/>')],
  ["a pattern", svg('<pattern id="p"/>')],
  ["foreignObject", svg("<foreignObject/>")],
  ["an entity declaration", `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "b">]>${svg("")}`],
]) {
  test(`assertSafeSvg refuses ${label}`, () => {
    assert.throws(() => assertSafeSvg(text));
  });
}

test("assertSafeSvg accepts shapes, gradients and #id references", () => {
  assert.doesNotThrow(() => assertSafeSvg(PLAIN));
  assert.doesNotThrow(() => assertSafeSvg(svg('<rect fill="url(#g)" width="1" height="1"/>')));
  assert.doesNotThrow(() => assertSafeSvg(svg('<linearGradient id="b" xlink:href="#a"/><linearGradient id="c" href="#b"/>')));
});

test("renderSvgInChild renders a plain SVG to a PNG at its source size", async () => {
  const rendered = await renderSvgInChild(PLAIN);
  assert.equal(rendered.width, 900);
  assert.equal(rendered.height, 700);
  assert.equal(rendered.buffer.subarray(0, 4).toString("hex"), "89504e47");
});

test("renderSvgInChild gives up when the child runs past its deadline", async () => {
  await assert.rejects(renderSvgInChild(PLAIN, { timeoutMs: 1 }), /timed out/);
});

test("raid-bg refuses a filter bomb quickly instead of rendering it", async () => {
  const buffer = Buffer.from(TURBULENCE);
  const started = Date.now();
  await assert.rejects(
    validateBgAttachment({ size: buffer.length, contentType: "image/svg+xml" }, buffer),
    (err) => err.key === "raidBg.errors.decodeFailed",
  );
  assert.ok(Date.now() - started < 1000, "refused within a second");
});
