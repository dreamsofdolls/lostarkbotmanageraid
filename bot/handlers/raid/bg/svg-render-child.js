"use strict";

/**
 * bot/handlers/raid/bg/svg-render-child.js
 * Child process of svg-render.js: renders one SVG to a PNG, replies once over
 * IPC and exits. Rendering here keeps a slow or crashing render out of the bot
 * process, which kills this child at its deadline.
 */

const { Resvg } = require("@resvg/resvg-js");

function renderSvg(svgText, maxSide) {
  const probe = new Resvg(svgText);
  const width = Math.round(probe.width || 0);
  const height = Math.round(probe.height || 0);
  if (width <= 0 || height <= 0) throw new Error("SVG has no readable width/height");
  // Native SVG decoding allocates at the source size, so a large SVG is fitted
  // to the stored frame on its long side before it is rasterised.
  const fitTo = Math.max(width, height) > maxSide
    ? { mode: width >= height ? "width" : "height", value: maxSide }
    : null;
  const renderer = fitTo ? new Resvg(svgText, { fitTo }) : probe;
  return { buffer: renderer.render().asPng(), width, height };
}

process.once("message", ({ svgText, maxSide }) => {
  let reply;
  try {
    reply = { ok: true, ...renderSvg(svgText, maxSide) };
  } catch (err) {
    reply = { ok: false, message: err.message };
  }
  process.send(reply, () => process.exit(0));
});
