"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createRequire } = require("node:module");
const { REST } = require("discord.js");

const { createDiscordRestAgent } = require("../bot/app/discord-rest-agent");

// On Node 24, loading jsdom lets its undici 8 take the process-wide dispatcher,
// since Node's bundled undici 7 never fills the slot undici 8 checks. The test
// sets that state directly so it holds on any Node version.
function giveJsdomUndiciTheGlobalDispatcher() {
  const jsdomUndici = createRequire(require.resolve("jsdom"))("undici");
  jsdomUndici.setGlobalDispatcher(new jsdomUndici.Agent());
}

// A stand-in for the Discord API that answers every request with a message.
async function startFakeDiscordApi(t) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "message-1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api`;
}

test("a file upload goes through while jsdom's undici holds the global dispatcher", async (t) => {
  giveJsdomUndiciTheGlobalDispatcher();
  const api = await startFakeDiscordApi(t);
  const agent = createDiscordRestAgent();
  t.after(() => agent?.close());
  const rest = new REST({ api, retries: 0, agent }).setToken("local-test");

  const sent = await rest.post("/channels/1/messages", {
    body: { content: "raid card" },
    files: [{ name: "raid-status.png", data: Buffer.from([1, 2, 3]) }],
  });

  assert.equal(sent.id, "message-1");
});

test("the bot's Discord client sends REST requests through that agent", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "bot.js"), "utf8");
  assert.match(source, /rest: \{ agent: createDiscordRestAgent\(\) \}/);
});
