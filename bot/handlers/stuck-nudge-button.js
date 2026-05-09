"use strict";

const { buildNoticeEmbed } = require("../utils/raid/shared");
const { t, getUserLanguage } = require("../services/i18n");
const { setLocalSyncEnabled, mintToken: mintLocalSyncToken, RESULT: SYNC_RESULT } = require("../services/local-sync");

/**
 * Click handler for the "🌐 Switch to Local Sync" button on the stuck-
 * private-log nudge embed (raid-schedulers.js posts it when bible
 * auto-manage detects every char as private). customId shape:
 *
 *   stuck-nudge:switch-to-local:<targetDiscordId>
 *
 * Flow:
 *   1. Verify clicker.id === target (encoded in customId).
 *      Anyone else clicking just gets a polite "this isn't your nudge"
 *      reply - prevents random members opting someone else into local.
 *   2. setLocalSyncEnabled(force:true) - atomic mutex flip: bible flag
 *      OFF + local flag ON in one Mongo write. Stuck-nudge IS the user's
 *      explicit consent to swap, so force is appropriate.
 *   3. Mint a 30-min companion-link token + build the URL.
 *   4. Update the channel embed to "switched" state + DM the user the
 *      personalized link.
 */
function createStuckNudgeButtonHandler({ EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, UI, User }) {
  async function handleStuckNudgeButton(interaction) {
    const customId = interaction.customId || "";
    const m = /^stuck-nudge:switch-to-local:(\d+)$/.exec(customId);
    if (!m) {
      // Unknown shape - swallow silently. The router shouldn't dispatch
      // this if it doesn't match, but guard anyway.
      return;
    }
    const targetDiscordId = m[1];
    const clickerId = interaction.user.id;
    const clickerLang = await getUserLanguage(clickerId, { UserModel: User });

    if (clickerId !== targetDiscordId) {
      // Wrong audience. Quiet ephemeral reply - don't escalate channel
      // noise on a button that's already mention-targeted.
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: t("stuck-nudge.notForYouTitle", clickerLang),
            description: t("stuck-nudge.notForYouDescription", clickerLang, { target: targetDiscordId }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    // Force-flip mutex: bible auto-sync OFF + local-sync ON in one
    // atomic Mongo write. The stuck-nudge embed message stays in
    // channel but the bible auto-manage flag is now off, so the next
    // scheduler tick won't re-nudge.
    let flipResult;
    try {
      flipResult = await setLocalSyncEnabled(
        targetDiscordId,
        true,
        { force: true },
        { UserModel: User }
      );
    } catch (err) {
      console.error(`[stuck-nudge] flip failed user=${targetDiscordId}:`, err?.message || err);
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("stuck-nudge.flipFailTitle", clickerLang),
            description: t("stuck-nudge.flipFailDescription", clickerLang, { error: err?.message || String(err) }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }
    if (!flipResult.ok) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("stuck-nudge.flipFailTitle", clickerLang),
            description: t("stuck-nudge.flipFailDescription", clickerLang, { error: flipResult.reason || "unknown" }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    // Mint companion link. Same env-var fallback as the local-on
    // command path: degrade gracefully if PUBLIC_BASE_URL missing.
    const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    let companionUrl = null;
    if (baseUrl) {
      try {
        // clickerLang resolved earlier via getUserLanguage(clickerId);
        // clickerId === targetDiscordId by this point (verified above),
        // so passing clickerLang is correct for the target's preference.
        const token = mintLocalSyncToken(targetDiscordId, undefined, clickerLang);
        companionUrl = `${baseUrl}/sync?token=${encodeURIComponent(token)}`;
      } catch (err) {
        console.warn("[stuck-nudge] token mint failed:", err?.message || err);
      }
    }

    // Update the original channel embed to "switched" state - removes
    // the now-irrelevant button and reframes the nudge as success.
    // Using update() instead of reply() so the public embed reflects
    // the resolution + button disappears for any later viewer.
    const switchedEmbed = new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} ${t("stuck-nudge.switchedTitle", clickerLang)}`)
      .setDescription(t("stuck-nudge.switchedDescription", clickerLang, { target: targetDiscordId }))
      .setTimestamp();
    const updatePayload = { content: "", embeds: [switchedEmbed], components: [] };
    try {
      await interaction.update(updatePayload);
    } catch (err) {
      console.warn("[stuck-nudge] interaction.update failed:", err?.message || err);
      // Best-effort: still try to reply ephemerally so user sees confirmation.
      await interaction.reply({
        embeds: [switchedEmbed],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }

    // DM the personalized companion link separately. Channel embed
    // doesn't expose the URL (other members would see it; URL has the
    // user's signed token). Private DM keeps the token contained.
    if (companionUrl) {
      try {
        const dmEmbed = new EmbedBuilder()
          .setColor(UI.colors.success)
          .setTitle(`${UI.icons.done} ${t("stuck-nudge.dmTitle", clickerLang)}`)
          .setDescription(t("stuck-nudge.dmDescription", clickerLang))
          .setTimestamp();
        const dmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setStyle(ButtonStyle.Link)
            .setLabel(t("raid-auto-manage.localEnable.openButtonLabel", clickerLang))
            .setURL(companionUrl)
        );
        const targetUser = await interaction.client.users.fetch(targetDiscordId).catch(() => null);
        if (targetUser) {
          await targetUser.send({ embeds: [dmEmbed], components: [dmRow] }).catch((err) => {
            console.warn("[stuck-nudge] DM send failed:", err?.message || err);
          });
        }
      } catch (err) {
        console.warn("[stuck-nudge] DM build failed:", err?.message || err);
      }
    }

    console.log(`[stuck-nudge] user=${targetDiscordId} switched to local-sync via nudge button`);
  }

  return { handleStuckNudgeButton };
}

module.exports = { createStuckNudgeButtonHandler };
