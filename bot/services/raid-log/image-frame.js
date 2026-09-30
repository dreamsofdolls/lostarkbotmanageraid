"use strict";

const { Readable, Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createInflate, createDeflate, crc32 } = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

function paeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const a = Math.abs(prediction - left);
  const b = Math.abs(prediction - up);
  const c = Math.abs(prediction - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

function filterPredictor(filter, left, up, upperLeft) {
  return filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
    : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
}

function unfilter(scanline, previous, channels) {
  const filter = scanline[0];
  if (filter > 4) throw new Error("Invalid PNG scanline filter");
  const pixels = scanline.subarray(1);
  for (let index = 0; index < pixels.length && filter !== 0; index++) {
    const left = index >= channels ? pixels[index - channels] : 0;
    const up = previous[index];
    const upperLeft = index >= channels ? previous[index - channels] : 0;
    pixels[index] += filterPredictor(filter, left, up, upperLeft);
  }
  return pixels;
}

/**
 * A minimum 4:3 frame keeps tall Discord previews readable. PNG scanlines
 * avoid allocating the full decoded image and a much wider output canvas.
 * @param {Buffer} buffer Playwright's non-interlaced 8-bit RGB/RGBA PNG
 * @param {{ width: number, height: number }} dimensions source capture clip
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Buffer>} original pixels with centered transparent side margins
 */
async function frameCaptureImage(buffer, { width, height }, { signal } = {}) {
  const frameWidth = Math.ceil(height * 4 / 3);
  if (width >= frameWidth) return buffer;

  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Invalid PNG screenshot header");
  }
  const header = Buffer.from(buffer.subarray(16, 29));
  if (header.readUInt32BE(0) !== width || header.readUInt32BE(4) !== height) {
    throw new Error("PNG screenshot dimensions do not match the capture clip");
  }
  const colorType = header[9];
  if (header[8] !== 8 || ![2, 6].includes(colorType) || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) {
    throw new Error("Unsupported PNG screenshot format");
  }

  const compressed = [];
  const metadata = [];
  let transparent;
  let ended = false;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > buffer.length || crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) {
      throw new Error("Invalid PNG screenshot chunk");
    }
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, end - 4);
    if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") { ended = true; break; }
    else if (type === "tRNS") {
      if (colorType !== 2 || length !== 6) throw new Error("Invalid PNG transparency chunk");
      transparent = [data.readUInt16BE(0), data.readUInt16BE(2), data.readUInt16BE(4)];
    } else if (type === "sBIT" && colorType === 2) {
      metadata.push(pngChunk(type, Buffer.concat([data, Buffer.from([8])])));
    } else if (type !== "IHDR") metadata.push(buffer.subarray(offset, end));
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error("Incomplete PNG screenshot");

  const channels = colorType === 6 ? 4 : 3;
  const scanline = Buffer.alloc(width * channels + 1);
  const previous = Buffer.alloc(width * channels);
  const leftOffset = Math.floor((frameWidth - width) / 2) * 4 + 1;
  let filled = 0;
  let rows = 0;
  const alpha = (pixels, index) => transparent && pixels[index] === transparent[0]
    && pixels[index + 1] === transparent[1] && pixels[index + 2] === transparent[2] ? 0 : 255;
  const padding = new Transform({
    transform(chunk, encoding, callback) {
      try {
        let offset = 0;
        while (offset < chunk.length) {
          if (rows >= height) throw new Error("PNG screenshot has excess scanlines");
          const copied = chunk.copy(scanline, filled, offset, offset + scanline.length - filled);
          filled += copied;
          offset += copied;
          if (filled !== scanline.length) continue;
          const framed = Buffer.alloc(frameWidth * 4 + 1);
          const filter = scanline[0];
          framed[0] = filter;
          // Filtered color bytes remain valid after inserting zero columns.
          // Only added alpha and the first right-margin pixel need new predictors.
          if (channels === 4) {
            scanline.copy(framed, leftOffset, 1);
          } else {
            for (let source = 1, target = leftOffset; source < scanline.length; source += 3, target += 4) {
              framed[target] = scanline[source];
              framed[target + 1] = scanline[source + 1];
              framed[target + 2] = scanline[source + 2];
            }
          }
          const pixels = unfilter(scanline, previous, channels);
          if (channels === 3) {
            for (let source = 0, target = leftOffset; source < pixels.length; source += 3, target += 4) {
              const left = source ? alpha(pixels, source - 3) : 0;
              const up = rows ? alpha(previous, source) : 0;
              const upperLeft = rows && source ? alpha(previous, source - 3) : 0;
              framed[target + 3] = alpha(pixels, source) - filterPredictor(filter, left, up, upperLeft);
            }
          }
          const last = pixels.length - channels;
          for (let channel = 0; channel < 4; channel++) {
            const left = channel < channels ? pixels[last + channel] : alpha(pixels, last);
            const upperLeft = channel < channels ? previous[last + channel] : rows ? alpha(previous, last) : 0;
            framed[leftOffset + width * 4 + channel] = -filterPredictor(filter, left, 0, upperLeft);
          }
          pixels.copy(previous);
          this.push(framed);
          rows++;
          filled = 0;
        }
        callback();
      } catch (error) { callback(error); }
    },
    flush(callback) {
      callback(rows === height && filled === 0 ? null : new Error("Incomplete PNG screenshot scanlines"));
    },
  });
  header.writeUInt32BE(frameWidth, 0);
  header[9] = 6;
  const output = [PNG_SIGNATURE, pngChunk("IHDR", header), ...metadata];
  await pipeline(Readable.from(compressed), createInflate(), padding, createDeflate(), new Writable({
    write(chunk, encoding, callback) {
      output.push(pngChunk("IDAT", chunk));
      callback();
    },
  }), { signal });
  output.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(output);
}

module.exports = { frameCaptureImage };
