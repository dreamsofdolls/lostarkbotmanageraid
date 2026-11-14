"use strict";

/**
 * bot/handlers/raid/bg/svg-render.js
 * SVG backgrounds: a file that names an element able to run the renderer for
 * minutes or reach outside the file is refused, and the rest render in a child
 * process killed at a deadline, so no upload can stall the bot's event loop.
 */

const path = require("node:path");
const { fork } = require("node:child_process");

const SVG_RENDER_TIMEOUT_MS = 5000;
const CHILD_PATH = path.join(__dirname, "svg-render-child.js");

// Filter primitives can run for minutes (feTurbulence scales with
// numOctaves), image and links load local files, use and pattern repeat
// content, foreignObject and script carry non-SVG content, and DTD entities
// expand text. A namespace prefix (`svg:filter`) is matched too.
const UNSAFE_SVG_RULES = Object.freeze([
  { pattern: /<!(?:DOCTYPE|ENTITY)/i, reason: "a DTD or entity declaration" },
  {
    pattern: /<\s*(?:[\w.-]+:)?(?:filter|fe[a-z]+|image|use|pattern|foreignobject|script)\b/i,
    reason: "a filter, image, use, pattern, foreignObject or script element",
  },
  { pattern: /\bhref\s*=\s*["']\s*(?!#)/i, reason: "a link to something other than an #id in the file" },
]);

/**
 * Refuse SVG text that contains an unsafe construct.
 * @param {string} svgText - the uploaded SVG as text
 * @returns {void}
 * @throws {Error} naming the first unsafe construct found
 */
function assertSafeSvg(svgText) {
  const rule = UNSAFE_SVG_RULES.find(({ pattern }) => pattern.test(svgText));
  if (rule) throw new Error(`SVG contains ${rule.reason}`);
}

/**
 * Render SVG text to a PNG in a child process that is killed at the deadline.
 * @param {string} svgText - SVG that passed assertSafeSvg
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - kill the child after this long
 * @param {number} [options.maxSide] - fit the long side to this many pixels
 * @returns {Promise<{buffer: Buffer, width: number, height: number}>} the PNG
 *   and the SVG's own width and height
 */
function renderSvgInChild(svgText, { timeoutMs = SVG_RENDER_TIMEOUT_MS, maxSide = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(CHILD_PATH, [], { serialization: "advanced", execArgv: [] });
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`SVG render timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    child.once("message", (reply) => {
      if (!reply?.ok) return finish(new Error(reply?.message || "SVG render failed"));
      finish(null, { buffer: Buffer.from(reply.buffer), width: reply.width, height: reply.height });
    });
    child.once("error", (err) => finish(err));
    child.once("exit", (code, signal) => finish(new Error(`SVG renderer exited (${signal || code})`)));
    child.send({ svgText, maxSide });
  });
}

module.exports = { assertSafeSvg, renderSvgInChild, SVG_RENDER_TIMEOUT_MS };
