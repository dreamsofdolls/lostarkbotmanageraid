"use strict";

const { t, getUserLanguage } = require("../../services/i18n");

// Auction bid formula ported verbatim from la-utils.vercel.app
// (bundle chunk 86dcebd97a96c81b.js):
//
//   base   = Math.floor(0.95 * marketValue / N * (N - 1))
//   profit = Math.floor(0.92 * base)
//
// Meaning:
//   - 0.95   = 5% market-sell fee on the item value. The user enters the
//              AH LISTING price; the formula automatically deducts the
//              5% so the bid reflects net realizable value.
//   - (N-1)/N = the share owed to the OTHER N-1 party members of that
//              net value.
//   - 0.92   = an 8% margin so winning the item is profitable vs just
//              buying it on the market.
//
// The left-to-right float order ((0.95*V)/N)*(N-1) is preserved exactly
// so results match the reference tool to the gold (verified: V=309000 ->
// N4 202549, N8 236307, N16 253186).
function computeAuctionBid(marketValue, players, isProfit) {
  const base = Math.floor((0.95 * marketValue / players) * (players - 1));
  return isProfit ? Math.floor(0.92 * base) : base;
}

function formatGold(value) {
  return Number(value).toLocaleString("en-US");
}

// Lost Ark raids are 4 or 8 players; the bot computes both at once and
// renders them side-by-side so the caller doesn't have to guess which to
// run for. 16 is intentionally omitted (no LA raid uses it).
const PARTY_SIZES = [4, 8];

function createRaidAuctionCommand({ EmbedBuilder, MessageFlags, UI, User }) {
  async function handleRaidAuctionCommand(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });

    const marketValue = interaction.options.getInteger("market_value", true);
    // Default ON to match the reference tool's `isProfit: true` state.
    const isProfit = interaction.options.getBoolean("profit") ?? true;

    if (!Number.isInteger(marketValue) || marketValue <= 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(UI.colors.danger)
            .setTitle(t("raid-auction.notice.invalidValueTitle", lang, { iconWarn: UI.icons.warn }))
            .setDescription(t("raid-auction.notice.invalidValueDescription", lang)),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Net realizable value after the 5% AH sell fee. The bid formula
    // itself assumes the winner will resell the item on the AH (that's
    // what the 0.95 factor models), so the winner-net display must use
    // the SAME assumption · otherwise the break-even semantics break
    // (at profit-off, everyone should walk away with 0.95V/N apiece,
    // which only holds when winner-net = 0.95V - bid, not V - bid).
    const netRealizable = Math.floor(0.95 * marketValue);
    const fields = PARTY_SIZES.map((players) => {
      const bid = computeAuctionBid(marketValue, players, isProfit);
      const others = players - 1;
      // When you win, the bid is split equally among the other N-1 members.
      // (The 0.95 fee is on the item resale, not on this internal bid
      // distribution, so no second fee is applied here.)
      const eachReceives = Math.floor(bid / others);
      // Winner pays `bid`, receives an item that nets `netRealizable`
      // when resold on the AH. Net profit = netRealizable - bid.
      const winnerNet = netRealizable - bid;
      return {
        name: t("raid-auction.result.partyHeader", lang, { players }),
        value: t("raid-auction.result.partyBlockValue", lang, {
          bid,
          others,
          eachReceives: formatGold(eachReceives),
          winnerNet: formatGold(winnerNet),
        }),
        inline: true,
      };
    });

    const modeText = isProfit
      ? t("raid-auction.result.modeProfit", lang)
      : t("raid-auction.result.modeBreakeven", lang);

    const embed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(t("raid-auction.result.title", lang))
      .setDescription(t("raid-auction.result.descriptionTemplate", lang, {
        marketValue: formatGold(marketValue),
        mode: modeText,
      }))
      .addFields(fields)
      .setFooter({ text: t("raid-auction.result.footer", lang) });

    // Public reply: an auction happens live in the raid party, so the
    // suggested bid + split should be visible to everyone in the channel,
    // not just the caller. (The invalid-value notice above stays
    // ephemeral so input mistakes don't clutter the channel.)
    await interaction.reply({ embeds: [embed] });
  }

  return {
    handleRaidAuctionCommand,
    // Test seam: pure formula, no Discord lifecycle needed.
    __test: { computeAuctionBid, PARTY_SIZES },
  };
}

module.exports = {
  createRaidAuctionCommand,
  computeAuctionBid,
  PARTY_SIZES,
};
