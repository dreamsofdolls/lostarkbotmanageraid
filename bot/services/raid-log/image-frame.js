"use strict";

// Tall images can narrow the entire Discord embed when the preview reaches its
// height limit. A minimum 4:3 frame adds only transparent side margins; the
// captured pixels stay at their original size, including both detail images.
async function frameCaptureImage(buffer, { width, height }) {
  const frameWidth = Math.ceil(height * 4 / 3);
  if (width >= frameWidth) return buffer;

  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const image = await loadImage(buffer);
  const canvas = createCanvas(frameWidth, height);
  canvas.getContext("2d").drawImage(image, Math.floor((frameWidth - width) / 2), 0);
  try {
    return await canvas.encode("png");
  } finally {
    // Release the large output surface before the next queued capture.
    canvas.width = 1;
    canvas.height = 1;
  }
}

module.exports = { frameCaptureImage };
