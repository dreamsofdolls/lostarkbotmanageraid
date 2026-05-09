/**
 * Atomic enable-auto helper used by the /raid-check "Bật auto-sync hộ"
 * button. Flips autoManageEnabled false→true via a single CAS
 * findOneAndUpdate filter so two managers (or manager + user) racing on
 * the same target can't both produce a success and a duplicate DM.
 *
 * Module-level (not closure-bound) so the unit suite can mock the User
 * model and exercise all 4 outcomes without spinning up the full
 * /raid-check command factory.
 *
 * Outcomes:
 *   - "flipped": filter matched, doc returned with the new state.
 *   - "already-on": doc exists but autoManageEnabled was already true
 *     (someone got here first, or user toggled on between page render
 *     and click).
 *   - "missing": no doc at all (user removed roster after page render).
 *   - "error": findOneAndUpdate threw - surface to caller.
 *
 * Note: we do NOT stamp lastAutoManageAttemptAt here, unlike the
 * /raid-auto-manage action:on path which stamps to defend its
 * probe-before-enable race. Stamping puts the new opt-in at the tail
 * of the daily scheduler's ascending lastAttempt sort, contradicting
 * the "next tick will pick up your roster" copy. Leaving the field as
 * null gives the new user priority in the next scheduler tick.
 */

const { t, getUserLanguage } = require("../../services/i18n");

async function tryEnableAutoManage(UserModel, discordId) {
  if (!discordId) return { outcome: "missing" };
  let updated;
  try {
    updated = await UserModel.findOneAndUpdate(
      { discordId, autoManageEnabled: { $ne: true } },
      { $set: { autoManageEnabled: true } },
      { new: true }
    );
  } catch (err) {
    return { outcome: "error", error: err };
  }
  if (updated) return { outcome: "flipped", doc: updated };
  // Filter rejected. Distinguish already-on (doc exists but flag true
  // when we tried) from missing (doc gone entirely). Operator/UX care
  // about the difference: already-on is benign (refresh hint), missing
  // is an audit signal (someone removed roster mid-session).
  let existing;
  try {
    existing = await UserModel.findOne({ discordId })
      .select("_id autoManageEnabled")
      .lean();
  } catch {
    existing = null;
  }
  if (!existing) return { outcome: "missing" };
  return { outcome: "already-on" };
}

/**
 * Atomic disable-auto helper used by the per-user "🚫 Tắt auto-sync ngay"
 * button that ships in the DM after a Manager flips the flag on their
 * behalf. Same atomic-CAS shape as tryEnableAutoManage but in the
 * opposite direction (true → false). Self-only: the click handler verifies
 * the clicker IS the target before invoking this.
 *
 * Outcomes mirror the enable variant:
 *   - "disabled": filter matched, flag is now false.
 *   - "already-off": doc exists but flag was already false (user hit the
 *     button twice or hit it after a separate /raid-auto-manage action:off).
 *   - "missing": no doc at all.
 *   - "error": DB threw.
 */
async function tryDisableAutoManage(UserModel, discordId) {
  if (!discordId) return { outcome: "missing" };
  let updated;
  try {
    updated = await UserModel.findOneAndUpdate(
      { discordId, autoManageEnabled: true },
      { $set: { autoManageEnabled: false } },
      { new: true }
    );
  } catch (err) {
    return { outcome: "error", error: err };
  }
  if (updated) return { outcome: "disabled", doc: updated };
  let existing;
  try {
    existing = await UserModel.findOne({ discordId })
      .select("_id autoManageEnabled")
      .lean();
  } catch {
    existing = null;
  }
  if (!existing) return { outcome: "missing" };
  return { outcome: "already-off" };
}

/**
 * Build the DM embed sent to a user when a Manager flips auto-sync
 * on their behalf via "Bật auto-sync hộ". Lists every char in their
 * roster with a Public Log status
 * icon so the user knows immediately which chars need their action.
 *
 * Status icon rules (per character):
 *   - publicLogDisabled === true → 🔒 Private (last sync confirmed log off)
 *   - publicLogDisabled === false AND user.lastAutoManageSyncAt > 0
 *     → 🔓 Public OK (last sync fetched logs successfully)
 *   - otherwise → ❓ Chưa kiểm tra (no successful sync yet, true status
 *     unknown - will be confirmed at next scheduler tick)
 *
 * Module-level pure function (takes EmbedBuilder + userDoc + managerId)
 * so the suite can build snapshots without spinning up the full command
 * factory. Final positional `lang` defaults to "vi" so existing tests
 * (which assert on the VN strings) keep passing without churn; live
 * callers thread the recipient's locale.
 */
function buildEnableAutoDmEmbed(EmbedBuilder, { managerId, userDoc }, lang = "vi") {
  const accounts = Array.isArray(userDoc?.accounts) ? userDoc.accounts : [];
  const lastSyncAt = Number(userDoc?.lastAutoManageSyncAt) || 0;
  const hasEverSynced = lastSyncAt > 0;

  const description = [
    t("raid-auto-manage.dm.enable.description", lang, { managerId }),
    "",
    t("raid-auto-manage.dm.enable.statusLine", lang),
    t("raid-auto-manage.dm.enable.firstSyncLine", lang),
    t("raid-auto-manage.dm.enable.quickOffLine", lang),
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x5865F2) // info blue, matches buildNoticeEmbed type:info
    .setTitle(`ℹ️ ${t("raid-auto-manage.dm.enable.title", lang)}`)
    .setDescription(description);

  // One field per roster (account). Each line: status icon + char name +
  // iLvl. Discord field value cap is 1024 chars; a worst-case 18-char
  // roster fits comfortably (~30 chars/line × 18 ≈ 540).
  for (const account of accounts) {
    const characters = Array.isArray(account?.characters) ? account.characters : [];
    if (characters.length === 0) continue;
    const lines = characters.map((ch) => {
      const name = ch?.name || t("raid-auto-manage.dm.enable.charNoName", lang);
      const iLvl = Number(ch?.itemLevel) || 0;
      let icon;
      let statusText;
      if (ch?.publicLogDisabled === true) {
        icon = "🔒";
        statusText = t("raid-auto-manage.dm.enable.charPrivate", lang);
      } else if (hasEverSynced) {
        icon = "🔓";
        statusText = t("raid-auto-manage.dm.enable.charPublicOk", lang);
      } else {
        icon = "❓";
        statusText = t("raid-auto-manage.dm.enable.charUnknown", lang);
      }
      return t("raid-auto-manage.dm.enable.charLine", lang, {
        icon,
        name,
        iLvl,
        statusText,
      });
    });
    embed.addFields({
      name: t("raid-auto-manage.dm.enable.accountFieldName", lang, {
        accountName:
          account.accountName || t("raid-auto-manage.dm.enable.accountNoName", lang),
        count: characters.length,
      }),
      value: lines.join("\n").slice(0, 1024),
      inline: false,
    });
  }

  // Closing hint about Private chars, only useful if at least one char
  // could plausibly be Private (true now or unknown later). Skip the
  // line entirely on a roster that's already 100% confirmed Public to
  // avoid telling the user something they don't need.
  const anyUnknownOrPrivate = accounts.some((a) =>
    (a?.characters || []).some((ch) => ch?.publicLogDisabled === true || !hasEverSynced)
  );
  if (anyUnknownOrPrivate) {
    embed.setFooter({
      text: t("raid-auto-manage.dm.enable.privateFooter", lang),
    });
  }

  return embed;
}

/**
 * Build the DM embed sent to a user when a Manager disables auto-sync
 * on their behalf via the "Tắt auto-sync hộ" button. Mirror of
 * buildEnableAutoDmEmbed but with disable-tone copy + a self-only
 * "🔄 Bật lại auto-sync ngay" button hint (the button itself is added
 * by the caller, this just builds the embed).
 *
 * No roster status section: the disable case doesn't need it - we're
 * stopping data collection, not asking the user to fix anything. The
 * symmetric reduce keeps the disable DM short + tone-appropriate.
 */
function buildDisableAutoDmEmbed(EmbedBuilder, { managerId }, lang = "vi") {
  const description = [
    t("raid-auto-manage.dm.disable.description", lang, { managerId }),
    "",
    t("raid-auto-manage.dm.disable.statusLine", lang),
    t("raid-auto-manage.dm.disable.manualSyncLine", lang),
    t("raid-auto-manage.dm.disable.quickOnLine", lang),
  ].join("\n");

  return new EmbedBuilder()
    .setColor(0x99AAB5) // muted gray, matches buildNoticeEmbed type:muted
    .setTitle(`⚪ ${t("raid-auto-manage.dm.disable.title", lang)}`)
    .setDescription(description);
}

function createRaidCheckAutoManageUi(deps) {
  const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    User,
    buildNoticeEmbed,
  } = deps;

  // Enable-auto-on-behalf flow: button shows up only when the user
  // filter narrows /raid-check to one specific user, AND that user
  // hasn't opted into /raid-auto-manage. Click flips
  // their User.autoManageEnabled to true (atomic CAS via the helper
  // above) and DMs the user with the manager's mention, a Public Log
  // hint, and opt-out instructions.
  //
  // No probe-before-enable (unlike /raid-auto-manage action:on) because
  // the Manager isn't the data owner - they don't know which chars are
  // private. Stuck-private-log nudge flow already handles that case
  // 7-days-once after the next scheduler tick attempts to sync.
  async function handleRaidCheckEnableAutoOneClick(interaction, targetDiscordId) {
    // Manager (clicker) is the only viewer of the ephemeral reply.
    const managerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.enableButton.expiredTitle", managerLang),
            description: t("raid-auto-manage.enableButton.expiredDescription", managerLang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await tryEnableAutoManage(User, targetDiscordId);
    if (result.outcome === "error") {
      console.error(
        `[raid-check enable-auto] flip failed user=${targetDiscordId}:`,
        result.error?.message || result.error
      );
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-auto-manage.enableButton.flipFailTitle", managerLang),
            description: t("raid-auto-manage.enableButton.flipFailDescription", managerLang, {
              error: result.error?.message || result.error,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.outcome === "missing") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.enableButton.userMissingTitle", managerLang),
            description: t("raid-auto-manage.enableButton.userMissingDescription", managerLang, {
              target: targetDiscordId,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.outcome === "already-on") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-auto-manage.enableButton.alreadyOnTitle", managerLang),
            description: t("raid-auto-manage.enableButton.alreadyOnDescription", managerLang, {
              target: targetDiscordId,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // result.outcome === "flipped" - proceed to DM + success embed
    let dmSent = false;
    try {
      const targetUser = await interaction.client.users
        .fetch(targetDiscordId)
        .catch(() => null);
      if (targetUser) {
        // DM is delivered to the target, NOT the manager - render in the
        // recipient's locale per viewer-language rule.
        const targetLang = await getUserLanguage(targetDiscordId, { UserModel: User });
        const dmEmbed = buildEnableAutoDmEmbed(
          EmbedBuilder,
          { managerId: interaction.user.id, userDoc: result.doc },
          targetLang,
        );
        // Quick-disable button so the affected user has a 1-click path
        // back to opted-out without remembering the slash command. Self-
        // only enforcement happens in the click handler (verifies clicker
        // == target). customId encodes the target so the handler runs
        // without needing session state.
        const disableRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:disable-auto-self:${targetDiscordId}`)
            .setLabel(t("raid-auto-manage.dm.enable.disableSelfButton", targetLang))
            .setEmoji("🚫")
            .setStyle(ButtonStyle.Danger)
        );
        await targetUser.send({ embeds: [dmEmbed], components: [disableRow] });
        dmSent = true;
      }
    } catch (err) {
      console.warn(
        `[raid-check enable-auto] DM failed user=${targetDiscordId}:`,
        err?.message || err
      );
    }

    console.log(
      `[raid-check enable-auto] manager=${interaction.user.id} target=${targetDiscordId} flipped=true dmSent=${dmSent}`
    );

    const successEmbed = buildNoticeEmbed(EmbedBuilder, {
      type: "success",
      title: t("raid-auto-manage.enableButton.successTitle", managerLang),
      description: [
        t("raid-auto-manage.enableButton.successLineIntro", managerLang),
        "",
        t("raid-auto-manage.enableButton.successLineTarget", managerLang, {
          target: targetDiscordId,
        }),
        t("raid-auto-manage.enableButton.successLineState", managerLang),
        dmSent
          ? t("raid-auto-manage.enableButton.successLineDmSent", managerLang)
          : t("raid-auto-manage.enableButton.successLineDmFailed", managerLang),
        "",
        t("raid-auto-manage.enableButton.successLineOutro", managerLang),
      ].join("\n"),
    });
    await interaction.reply({
      embeds: [successEmbed],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Self-only quick-disable handler reachable from the button shipped
  // inside the enable-on-behalf DM. Clicker must equal the encoded target. Updates
  // the DM in place (interaction.update) with a muted success or
  // already-off notice and removes the button so a second click can't
  // fire stale outcomes.
  async function handleRaidCheckDisableAutoSelfClick(interaction, targetDiscordId) {
    // Clicker IS the DM recipient (self-only enforcement below); use
    // their lang for every string this handler renders.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.disableSelf.expiredTitle", lang),
            description: t("raid-auto-manage.disableSelf.expiredDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: t("raid-auto-manage.disableSelf.notOwnerTitle", lang),
            description: t("raid-auto-manage.disableSelf.notOwnerDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await tryDisableAutoManage(User, targetDiscordId);
    if (result.outcome === "error") {
      console.error(
        `[raid-check disable-auto-self] flip failed user=${targetDiscordId}:`,
        result.error?.message || result.error
      );
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-auto-manage.disableSelf.failTitle", lang),
            description: t("raid-auto-manage.disableSelf.failDescription", lang, {
              error: result.error?.message || result.error,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.outcome === "missing") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.disableSelf.accountMissingTitle", lang),
            description: t("raid-auto-manage.disableSelf.accountMissingDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let title;
    let description;
    if (result.outcome === "disabled") {
      title = t("raid-auto-manage.disableSelf.disabledTitle", lang);
      description = t("raid-auto-manage.disableSelf.disabledDescription", lang);
    } else {
      // already-off
      title = t("raid-auto-manage.disableSelf.alreadyOffTitle", lang);
      description = t("raid-auto-manage.disableSelf.alreadyOffDescription", lang);
    }
    const updatedEmbed = buildNoticeEmbed(EmbedBuilder, {
      type: "muted",
      title,
      description,
    });
    console.log(
      `[raid-check disable-auto-self] user=${targetDiscordId} outcome=${result.outcome}`
    );
    // Replace the DM in-place + drop the button so it can't be re-clicked.
    await interaction
      .update({
        embeds: [updatedEmbed],
        components: [],
      })
      .catch(() => {});
  }

  // Manager-on-behalf disable flow. Mirror of handleRaidCheckEnableAutoOneClick
  // but flips the flag in the opposite direction. Same atomic CAS shape +
  // 4-outcome dispatch + DM to the affected user (with a "Bật lại"
  // self-button for symmetric one-click revert).
  async function handleRaidCheckDisableAutoOneClick(interaction, targetDiscordId) {
    const managerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.disableButton.expiredTitle", managerLang),
            description: t("raid-auto-manage.disableButton.expiredDescription", managerLang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await tryDisableAutoManage(User, targetDiscordId);
    if (result.outcome === "error") {
      console.error(
        `[raid-check disable-auto-one] flip failed user=${targetDiscordId}:`,
        result.error?.message || result.error
      );
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-auto-manage.disableButton.flipFailTitle", managerLang),
            description: t("raid-auto-manage.disableButton.flipFailDescription", managerLang, {
              error: result.error?.message || result.error,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.outcome === "missing") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.disableButton.userMissingTitle", managerLang),
            description: t("raid-auto-manage.disableButton.userMissingDescription", managerLang, {
              target: targetDiscordId,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.outcome === "already-off") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-auto-manage.disableButton.alreadyOffTitle", managerLang),
            description: t("raid-auto-manage.disableButton.alreadyOffDescription", managerLang, {
              target: targetDiscordId,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // result.outcome === "disabled" - proceed to DM + success embed
    let dmSent = false;
    try {
      const targetUser = await interaction.client.users
        .fetch(targetDiscordId)
        .catch(() => null);
      if (targetUser) {
        // DM rendered in target's locale, not manager's.
        const targetLang = await getUserLanguage(targetDiscordId, { UserModel: User });
        const dmEmbed = buildDisableAutoDmEmbed(
          EmbedBuilder,
          { managerId: interaction.user.id },
          targetLang,
        );
        const reEnableRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:enable-auto-self:${targetDiscordId}`)
            .setLabel(t("raid-auto-manage.dm.disable.enableSelfButton", targetLang))
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Primary)
        );
        await targetUser.send({ embeds: [dmEmbed], components: [reEnableRow] });
        dmSent = true;
      }
    } catch (err) {
      console.warn(
        `[raid-check disable-auto-one] DM failed user=${targetDiscordId}:`,
        err?.message || err
      );
    }

    console.log(
      `[raid-check disable-auto-one] manager=${interaction.user.id} target=${targetDiscordId} outcome=disabled dmSent=${dmSent}`
    );

    const successEmbed = buildNoticeEmbed(EmbedBuilder, {
      type: "muted",
      title: t("raid-auto-manage.disableButton.successTitle", managerLang),
      description: [
        t("raid-auto-manage.disableButton.successLineIntro", managerLang),
        "",
        t("raid-auto-manage.disableButton.successLineTarget", managerLang, {
          target: targetDiscordId,
        }),
        t("raid-auto-manage.disableButton.successLineState", managerLang),
        dmSent
          ? t("raid-auto-manage.disableButton.successLineDmSent", managerLang)
          : t("raid-auto-manage.disableButton.successLineDmFailed", managerLang),
        "",
        t("raid-auto-manage.disableButton.successLineOutro", managerLang),
      ].join("\n"),
    });
    await interaction.reply({
      embeds: [successEmbed],
      flags: MessageFlags.Ephemeral,
    });
  }

  // Self-only re-enable handler reachable from the button shipped inside
  // the disable-on-behalf DM. Mirror of handleRaidCheckDisableAutoSelfClick
  // but flips the flag back to true. Self-only: clicker must equal
  // encoded target.
  async function handleRaidCheckEnableAutoSelfClick(interaction, targetDiscordId) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.enableSelf.expiredTitle", lang),
            description: t("raid-auto-manage.enableSelf.expiredDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: t("raid-auto-manage.enableSelf.notOwnerTitle", lang),
            description: t("raid-auto-manage.enableSelf.notOwnerDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const result = await tryEnableAutoManage(User, targetDiscordId);
    if (result.outcome === "error") {
      console.error(
        `[raid-check enable-auto-self] flip failed user=${targetDiscordId}:`,
        result.error?.message || result.error
      );
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-auto-manage.enableSelf.failTitle", lang),
            description: t("raid-auto-manage.enableSelf.failDescription", lang, {
              error: result.error?.message || result.error,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.outcome === "missing") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-auto-manage.enableSelf.accountMissingTitle", lang),
            description: t("raid-auto-manage.enableSelf.accountMissingDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let title;
    let description;
    if (result.outcome === "flipped") {
      title = t("raid-auto-manage.enableSelf.flippedTitle", lang);
      description = t("raid-auto-manage.enableSelf.flippedDescription", lang);
    } else {
      // already-on
      title = t("raid-auto-manage.enableSelf.alreadyOnTitle", lang);
      description = t("raid-auto-manage.enableSelf.alreadyOnDescription", lang);
    }
    const updatedEmbed = buildNoticeEmbed(EmbedBuilder, {
      type: "success",
      title,
      description,
    });
    console.log(
      `[raid-check enable-auto-self] user=${targetDiscordId} outcome=${result.outcome}`
    );
    await interaction
      .update({
        embeds: [updatedEmbed],
        components: [],
      })
      .catch(() => {});
  }

  return {
    handleRaidCheckEnableAutoOneClick,
    handleRaidCheckDisableAutoSelfClick,
    handleRaidCheckDisableAutoOneClick,
    handleRaidCheckEnableAutoSelfClick,
  };
}

module.exports = {
  createRaidCheckAutoManageUi,
  tryEnableAutoManage,
  tryDisableAutoManage,
  buildEnableAutoDmEmbed,
  buildDisableAutoDmEmbed,
};
