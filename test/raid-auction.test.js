process.env.RAID_MANAGER_ID = "test-manager";

const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder, MessageFlags } = require("discord.js");
const {
  createRaidAuctionCommand,
  computeAuctionBid,
  PARTY_SIZES,
} = require("../bot/handlers/raid/auction");
const { UI } = require("../bot/utils/raid/common/shared");

// User stub: getUserLanguage falls back to default "vi" when findOne
// resolves null. No live Mongo needed.
const UserStub = { findOne: () => ({ lean: async () => null }) };

function makeFactory() {
  return createRaidAuctionCommand({ EmbedBuilder, MessageFlags, UI, User: UserStub });
}

function makeInteraction({ marketValue, profit = null }) {
  const calls = [];
  return {
    user: { id: "auction-user" },
    options: {
      getInteger: (name) => ({ market_value: marketValue }[name]),
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

test("PARTY_SIZES is exactly [4, 8] (LA raid sizes only)", () => {
  assert.deepEqual(PARTY_SIZES, [4, 8]);
});

test("handler renders BOTH 4- and 8-player bids in one public reply", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ marketValue: 309000 });
  await factory.handleRaidAuctionCommand(interaction);

  assert.equal(interaction._calls.length, 1);
  const reply = interaction._calls[0];
  // Public (not ephemeral) so the whole raid party sees the suggested bids.
  assert.notEqual(reply.flags, MessageFlags.Ephemeral);

  const embed = reply.embeds[0].toJSON();
  // Exactly two party-size fields, in the order 4 then 8.
  assert.equal(embed.fields.length, 2);
  assert.match(embed.fields[0].name, /4/);
  assert.match(embed.fields[1].name, /8/);
  // Both bid amounts appear (profit-on values for 309000).
  const serialized = JSON.stringify(embed);
  assert.match(serialized, /202549/, "4-player bid should appear");
  assert.match(serialized, /236307/, "8-player bid should appear");
});

test("handler defaults profit ON when the option is omitted", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ marketValue: 309000, profit: null });
  await factory.handleRaidAuctionCommand(interaction);

  const serialized = JSON.stringify(interaction._calls[0].embeds[0].toJSON());
  assert.match(serialized, /202549/, "should use the profit-on bid for 4");
  assert.match(serialized, /236307/, "should use the profit-on bid for 8");
  // Base (profit-off) bids should NOT appear when profit defaults on.
  assert.doesNotMatch(serialized, /220162/);
  assert.doesNotMatch(serialized, /256856/);
});

test("handler honors profit:false (break-even bid for both sizes)", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ marketValue: 309000, profit: false });
  await factory.handleRaidAuctionCommand(interaction);

  const serialized = JSON.stringify(interaction._calls[0].embeds[0].toJSON());
  assert.match(serialized, /220162/, "should use the break-even bid for 4");
  assert.match(serialized, /256856/, "should use the break-even bid for 8");
});

test("winner net subtracts the 5% sell fee from the listing (uses 0.95V, not V)", async () => {
  // Regression guard for the user-spotted bug: the original implementation
  // rendered V - bid (gross savings if you keep the item), but the bid
  // formula's 0.95 factor assumes the winner resells the item on the AH
  // and so the displayed net MUST also apply the 5% fee. Otherwise the
  // break-even semantics break (everyone should walk away with 0.95V/N
  // apiece at profit-off).
  const factory = makeFactory();
  // V=300000, N=4, profit on. By hand:
  //   bid          = floor(0.92 * floor(0.95*300000/4*3)) = 196650
  //   netRealizable= floor(0.95*300000) = 285000
  //   winnerNet    = 285000 - 196650 = 88350
  //   gross V-bid  = 300000 - 196650 = 103350 (the previous incorrect result)
  const interaction = makeInteraction({ marketValue: 300000, profit: true });
  await factory.handleRaidAuctionCommand(interaction);
  const serialized = JSON.stringify(interaction._calls[0].embeds[0].toJSON());
  assert.match(serialized, /88,350/, "winner net should reflect 0.95V - bid");
  assert.doesNotMatch(serialized, /103,350/, "must not show the gross V - bid");
});

test("handler embeds the market value + mode in the description", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ marketValue: 293000, profit: true });
  await factory.handleRaidAuctionCommand(interaction);

  const embed = interaction._calls[0].embeds[0].toJSON();
  // Listing price appears with thousands separator for readability.
  assert.match(embed.description, /293,000/);
});

test("handler rejects a non-positive market value with a danger embed", async () => {
  const factory = makeFactory();
  const interaction = makeInteraction({ marketValue: 0 });
  await factory.handleRaidAuctionCommand(interaction);

  const reply = interaction._calls[0];
  // Invalid-input notices remain ephemeral and are not posted publicly.
  assert.equal(reply.flags, MessageFlags.Ephemeral);
  assert.equal(reply.embeds[0].toJSON().color, UI.colors.danger);
});
