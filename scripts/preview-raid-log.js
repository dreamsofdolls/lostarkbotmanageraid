"use strict";

// Uses the same capture service as /raid-log, without Discord or Mongo access.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRaidLogCapture } = require("../bot/services/raid-log/capture");
const { createRaidLogCatalog } = require("../bot/services/raid-log/catalog");
const { parseRaidLogSource } = require("../bot/services/raid-log/source");
const { BibleRequestLimiter } = require("../bot/services/auto-manage/bible/rate-limit");

async function main() {
  const args = process.argv.slice(2);
  const byCharacter = args[0] === "--character";
  const [input, view = "full"] = byCharacter ? args.slice(1) : args;
  if (!input) throw new Error("Usage: npm run preview:raid-log -- <public-log-url> [team|full] OR --character <name> [team|full]");
  const source = parseRaidLogSource(byCharacter ? { character: input } : { url: input });
  const startedAt = Date.now();
  const bibleLimiter = new BibleRequestLimiter(2);
  const selected = source.character ? (await createRaidLogCatalog({ bibleLimiter }).open(source.character)).logs[0] : source;
  const { images, ...result } = await createRaidLogCapture({ bibleLimiter })(selected.url, { view });
  const directory = path.resolve(__dirname, "../.agent/raid-log-preview");
  await fs.mkdir(directory, { recursive: true });
  const imagePath = path.join(directory, images[0].filename);
  const evidence = { ...result, selected, imagePath, elapsedMs: Date.now() - startedAt,
    images: images.map(({ buffer, ...image }) => ({ ...image, bytes: buffer.length })) };
  for (const image of images) await fs.writeFile(path.join(directory, image.filename), image.buffer);
  await fs.writeFile(`${imagePath}.json`, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
