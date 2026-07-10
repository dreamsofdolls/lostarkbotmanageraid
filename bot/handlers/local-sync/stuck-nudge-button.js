"use strict";

const {
  deferEphemeralReply,
  editNotice,
  followUpNotice,
} = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  setLocalSyncEnabled,
  rotateLocalSyncToken,
  extractIdentityFromUser,
} = require("../../services/local-sync");

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
 *   3. Mint a 1-hour companion-link token + build the URL.
 *   4. Update the channel embed to "switched" state + DM the user the
 *      personalized link.
 */
function createStuckNudgeButtonHandler({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  getUserLanguageFn = getUserLanguage,
  setLocalSyncEnabledFn = setLocalSyncEnabled,
  rotateLocalSyncTokenFn = rotateLocalSyncToken,
}) {
  async function handleStuckNudgeButton(interaction) {
    const customId = interaction.customId || "";
    const m = /^stuck-nudge:switch-to-local:(\d+)$/.exec(customId);
    if (!m) {
      // The router should not dispatch unknown shapes, but acknowledge
      // defensively so a stale/malformed component never spins forever.
      await interaction.deferUpdate().catch(() => {});
      return;
    }
    const targetDiscordId = m[1];
    const clickerId = interaction.user.id;

    if (clickerId !== targetDiscordId) {
      // Wrong audience. Quiet ephemeral reply - don't escalate channel
      // noise on a button that's already mention-targeted.
      await deferEphemeralReply(interaction);
      const clickerLang = await getUserLanguageFn(clickerId, { UserModel: User });
      await editNotice(interaction, EmbedBuilder, {
        type: "lock",
        title: t("stuck-nudge.notForYouTitle", clickerLang),
        description: t("stuck-nudge.notForYouDescription", clickerLang, { target: targetDiscordId }),
      }).catch(() => {});
      return;
    }

    await interaction.deferUpdate();
    const clickerLang = await getUserLanguageFn(clickerId, { UserModel: User });

    // Force-flip mutex: bible auto-sync OFF + local-sync ON in one
    // atomic Mongo write. The stuck-nudge embed message stays in
    // channel but the bible auto-manage flag is now off, so the next
    // scheduler tick won't re-nudge.
    let flipResult;
    try {
      flipResult = await setLocalSyncEnabledFn(
        targetDiscordId,
        true,
        { force: true },
        { UserModel: User }
      );
    } catch (err) {
      console.error(`[stuck-nudge] flip failed user=${targetDiscordId}:`, err?.message || err);
      await followUpNotice(interaction, EmbedBuilder, {
        type: "error",
        title: t("stuck-nudge.flipFailTitle", clickerLang),
        description: t("stuck-nudge.flipFailDescription", clickerLang, { error: err?.message || String(err) }),
      }).catch(() => {});
      return;
    }
    if (!flipResult.ok) {
      await followUpNotice(interaction, EmbedBuilder, {
        type: "error",
        title: t("stuck-nudge.flipFailTitle", clickerLang),
        description: t("stuck-nudge.flipFailDescription", clickerLang, { error: flipResult.reason || "unknown" }),
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
        const identity = extractIdentityFromUser(interaction.user);
        const token = await rotateLocalSyncTokenFn(targetDiscordId, clickerLang, { UserModel: User, identity });
        companionUrl = `${baseUrl}/sync?token=${encodeURIComponent(token)}`;
      } catch (err) {
        console.warn("[stuck-nudge] token mint failed:", err?.message || err);
      }
    }

    // Update the original channel embed to "switched" state - removes
    // the now-irrelevant button and reframes the nudge as success.
    // The component was already deferred above; editReply resolves the
    // public message and removes the stale button for later viewers.
    const switchedEmbed = new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} ${t("stuck-nudge.switchedTitle", clickerLang)}`)
      .setDescription(t("stuck-nudge.switchedDescription", clickerLang, { target: targetDiscordId }))
      .setTimestamp();
    const updatePayload = { content: "", embeds: [switchedEmbed], components: [] };
    try {
      await interaction.editReply(updatePayload);
    } catch (err) {
      console.warn("[stuck-nudge] interaction.editReply failed:", err?.message || err);
      // Best-effort: the interaction is already acknowledged, so surface
      // confirmation as a private follow-up instead of attempting reply().
      await interaction.followUp({
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
