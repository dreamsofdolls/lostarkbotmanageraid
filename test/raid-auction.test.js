process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder, MessageFlags } = require("discord.js");
const {
  createRaidAuctionCommand,
  computeAuctionBid,
} = require("../bot/handlers/raid/auction");
const { UI } = require("../bot/utils/raid/common/shared");

// User stub: getUserLanguage falls back to default "vi" when findOne
// resolves null. No live Mongo needed.
const UserStub = { findOne: () => ({ lean: async () => null }) };

function makeFactory() {
  return createRaidAuctionCommand({ EmbedBuilder, MessageFlags, UI, User: UserStub });
}

function makeInteraction({ players, marketValue, profit = null }) {
  const calls = [];
  return {
    user: { id: "auction-user" },
    options: {
      getInteger: (name) => ({ players, market_value: marketValue }[name]),
      getBoolean: () => profit,
    },
    reply: async (arg) => calls.push(arg),
    _calls: calls,
  };
}

test("computeAuctionBid matches la-utils reference values (profit on)", () => {
  // Verified against the live tool at market value 309000.
  assert.equal(computeAuctionBid(309000, 4, true), 202549);
  assert.equal(computeAuctionBid(309000, 8, true), 236307);
  assert.equal(computeAuctionBid(309000, 16, true), 253186);
});

test("computeAuctionBid base (profit off) drops the 0.92 margin", () => {
  assert.equal(computeAuctionBid(309000, 4, false), 220162);
  assert.equal(computeAuctionBid(309000, 8, false), 256856);
});

test("computeAuctionBid scales with party size: bigger party -> higher bid", () => {
  // (N-1)/N grows with N, so a larger party justifies a higher bid.
  const four = computeAuctionBid(500000, 4, true);
  const eight = computeAuctionBid(500000, 8, true);
  assert.ok(eight > four, `expected 8-player bid (${eight}) > 4-player (${four})`);
});

test("handler replies publicly with the bid embedded in the result", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ players: 8, marketValue: 293000 });
  await factory.handleRaidAuctionCommand(interaction);

  assert.equal(interaction._calls.length, 1);
  const reply = interaction._calls[0];
  // Public (not ephemeral) so the whole raid party sees the suggested bid.
  assert.notEqual(reply.flags, MessageFlags.Ephemeral);

  const embed = reply.embeds[0].toJSON();
  const expectedBid = computeAuctionBid(293000, 8, true);
  const serialized = JSON.stringify(embed);
  assert.match(serialized, new RegExp(String(expectedBid)), "bid amount should appear in the embed");
});

test("handler defaults profit ON when the option is omitted", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ players: 4, marketValue: 309000, profit: null });
  await factory.handleRaidAuctionCommand(interaction);

  const embed = interaction._calls[0].embeds[0].toJSON();
  const serialized = JSON.stringify(embed);
  // Profit-on bid for (309000, 4) is 202549; base would be 220162.
  assert.match(serialized, /202549/, "should use the profit-on bid by default");
  assert.doesNotMatch(serialized, /220162/, "should not use the base (profit-off) bid");
});

test("handler honors profit:false (break-even bid)", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ players: 4, marketValue: 309000, profit: false });
  await factory.handleRaidAuctionCommand(interaction);

  const embed = interaction._calls[0].embeds[0].toJSON();
  assert.match(JSON.stringify(embed), /220162/, "should use the break-even bid");
});

test("handler rejects a non-positive market value with a danger embed", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ players: 4, marketValue: 0 });
  await factory.handleRaidAuctionCommand(interaction);

  const embed = interaction._calls[0].embeds[0].toJSON();
  assert.equal(embed.color, UI.colors.danger);
});
