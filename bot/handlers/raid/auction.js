"use strict";

const { t, getUserLanguage } = require("../../services/i18n");

// Auction bid formula ported verbatim from la-utils.vercel.app
// (bundle chunk 86dcebd97a96c81b.js):
//
//   base   = Math.floor(0.95 * marketValue / N * (N - 1))
//   profit = Math.floor(0.92 * base)
//
// Meaning:
//   - 0.95   = 5% market-sell fee on the item value (item nets 0.95*V).
//   - (N-1)/N = the share owed to the OTHER N-1 party members.
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

function createRaidAuctionCommand({ EmbedBuilder, MessageFlags, UI, User }) {
  async function handleRaidAuctionCommand(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });

    const players = interaction.options.getInteger("players", true);
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

    const bid = computeAuctionBid(marketValue, players, isProfit);
    const others = players - 1;
    // When you win, the bid is split equally among the other N-1 members.
    // (The 0.95 fee is already on the item value, not on this internal
    // distribution, so no second fee is applied here.)
    const eachReceives = others > 0 ? Math.floor(bid / others) : 0;
    // You pay `bid`, keep the item worth ~marketValue.
    const winnerNet = marketValue - bid;

    const embed = new EmbedBuilder()
      .setColor(UI.colors.progress)
      .setTitle(t("raid-auction.result.title", lang))
      .addFields(
        {
          name: t("raid-auction.result.marketValueField", lang),
          value: `\`${formatGold(marketValue)}\``,
          inline: true,
        },
        {
          name: t("raid-auction.result.partyField", lang),
          value: `\`${players}\``,
          inline: true,
        },
        {
          name: t("raid-auction.result.modeField", lang),
          value: isProfit
            ? t("raid-auction.result.modeProfit", lang)
            : t("raid-auction.result.modeBreakeven", lang),
          inline: true,
        },
        {
          // Raw integer (no separators) in a code block so it copy-pastes
          // cleanly into the in-game auction bid box.
          name: t("raid-auction.result.bidField", lang),
          value: `\`\`\`\n${bid}\n\`\`\``,
          inline: false,
        },
        {
          name: t("raid-auction.result.eachReceivesField", lang, { count: others }),
          value: `~\`${formatGold(eachReceives)}\``,
          inline: true,
        },
        {
          name: t("raid-auction.result.winnerNetField", lang),
          value: `~\`${formatGold(winnerNet)}\``,
          inline: true,
        },
      )
      .setFooter({ text: t("raid-auction.result.footer", lang) });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  return {
    handleRaidAuctionCommand,
    // Test seam: pure formula, no Discord lifecycle needed.
    __test: { computeAuctionBid },
  };
}

module.exports = {
  createRaidAuctionCommand,
  computeAuctionBid,
};
