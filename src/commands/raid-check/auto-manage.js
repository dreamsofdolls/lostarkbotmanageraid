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
 * factory.
 */
function buildEnableAutoDmEmbed(EmbedBuilder, { managerId, userDoc }) {
  const accounts = Array.isArray(userDoc?.accounts) ? userDoc.accounts : [];
  const lastSyncAt = Number(userDoc?.lastAutoManageSyncAt) || 0;
  const hasEverSynced = lastSyncAt > 0;

  const description = [
    `Heya~ Raid Manager <@${managerId}> vừa bật \`/raid-auto-manage\` hộ cậu rồi nha. Từ giờ Artist sẽ tự sync raid progress cho cậu mỗi 24h.`,
    "",
    "**Trạng thái mới:** ON",
    "**Khi nào sync lần đầu:** Sớm trong các tick scheduler tới (chạy mỗi ~30 phút, mỗi tick batch 3 user)",
    "**Tắt nhanh:** Bấm button bên dưới hoặc gõ `/raid-auto-manage action:off`",
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x5865F2) // info blue, matches buildNoticeEmbed type:info
    .setTitle("ℹ️ Manager đã bật auto-sync hộ cậu")
    .setDescription(description);

  // One field per roster (account). Each line: status icon + char name +
  // iLvl. Discord field value cap is 1024 chars; a worst-case 18-char
  // roster fits comfortably (~30 chars/line × 18 ≈ 540).
  for (const account of accounts) {
    const characters = Array.isArray(account?.characters) ? account.characters : [];
    if (characters.length === 0) continue;
    const lines = characters.map((ch) => {
      const name = ch?.name || "(no name)";
      const iLvl = Number(ch?.itemLevel) || 0;
      let icon;
      let statusText;
      if (ch?.publicLogDisabled === true) {
        icon = "🔒";
        statusText = "Private (cần bật Public Log)";
      } else if (hasEverSynced) {
        icon = "🔓";
        statusText = "Public OK";
      } else {
        icon = "❓";
        statusText = "Chưa kiểm tra";
      }
      return `${icon} ${name} · ${iLvl} · ${statusText}`;
    });
    embed.addFields({
      name: `📁 ${account.accountName || "(no name)"} (${characters.length} char)`,
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
      text: "Char nào báo 🔒 Private (hoặc ❓ rồi sau Private), vào lostark.bible/me/logs bật Show on Profile giúp Artist nha.",
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
function buildDisableAutoDmEmbed(EmbedBuilder, { managerId }) {
  const description = [
    `Heya~ Raid Manager <@${managerId}> vừa tắt \`/raid-auto-manage\` hộ cậu rồi nha. Từ giờ Artist không tự sync raid progress cho cậu nữa.`,
    "",
    "**Trạng thái mới:** OFF",
    "**Sync thủ công:** Gõ `/raid-set` hoặc post clear vào monitor channel của server",
    "**Bật lại nhanh:** Bấm button bên dưới hoặc gõ `/raid-auto-manage action:on`",
  ].join("\n");

  return new EmbedBuilder()
    .setColor(0x99AAB5) // muted gray, matches buildNoticeEmbed type:muted
    .setTitle("⚪ Manager đã tắt auto-sync hộ cậu")
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
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Button đã hết hạn",
            description: "Button không có target user (có thể session cũ hoặc bot vừa restart). Gõ `/raid-check` lại để refresh nha.",
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
            title: "Flip flag fail",
            description: `Artist gặp lỗi khi flip flag: \`${result.error?.message || result.error}\`. Thử lại sau nha.`,
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
            title: "User không tồn tại",
            description: `Artist không thấy user \`${targetDiscordId}\` trong DB nữa (có thể họ đã \`/remove-roster\`). Refresh lại \`/raid-check\` để page sync state mới nha.`,
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
            title: "User đã opt-in rồi",
            description: `<@${targetDiscordId}> đã bật \`/raid-auto-manage\` rồi nha (có thể họ tự bật giữa lúc cậu mở page và bấm button, hoặc Manager khác bấm trước cậu). Refresh \`/raid-check\` để page sync state mới.`,
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
        const dmEmbed = buildEnableAutoDmEmbed(EmbedBuilder, {
          managerId: interaction.user.id,
          userDoc: result.doc,
        });
        // Quick-disable button so the affected user has a 1-click path
        // back to opted-out without remembering the slash command. Self-
        // only enforcement happens in the click handler (verifies clicker
        // == target). customId encodes the target so the handler runs
        // without needing session state.
        const disableRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:disable-auto-self:${targetDiscordId}`)
            .setLabel("Tắt auto-sync ngay")
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
      title: "Artist đã bật auto-sync hộ rồi nha",
      description: [
        "Flag flip thành công. User này nằm trong batch ưu tiên (`lastAutoManageAttemptAt = null`), scheduler sẽ pick sớm trong các tick tới (mỗi ~30 phút, batch 3 user).",
        "",
        `**Đã bật cho:** <@${targetDiscordId}>`,
        `**Trạng thái mới:** ON`,
        dmSent
          ? "**DM thông báo:** Đã gửi"
          : "**DM thông báo:** Không gửi được (user tắt DM riêng), flag vẫn được flip OK",
        "",
        "Nếu user muốn tắt thì họ gõ `/raid-auto-manage action:off` bất cứ lúc nào nha.",
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
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Button đã hết hạn",
            description: "Button không có target user (DM bị stale hoặc bot vừa redeploy). Gõ `/raid-auto-manage action:off` thay nha.",
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
            title: "Button này chỉ chủ DM bấm được",
            description: "Button `Tắt auto-sync ngay` chỉ user nhận DM mới có thể bấm nha. Nếu cậu muốn opt-out auto-sync của riêng mình, gõ `/raid-auto-manage action:off` từ trong server bất cứ lúc nào.",
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
            title: "Tắt auto-sync fail",
            description: `Artist gặp lỗi khi tắt: \`${result.error?.message || result.error}\`. Thử gõ \`/raid-auto-manage action:off\` thay nha.`,
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
            title: "Account không tồn tại",
            description: "Artist không tìm thấy roster của cậu trong DB nữa (có thể đã `/remove-roster` toàn bộ). Không có gì để tắt.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let title;
    let description;
    if (result.outcome === "disabled") {
      title = "Đã tắt auto-sync rồi nha~";
      description = "Artist đã tắt `/raid-auto-manage` cho cậu. Từ giờ Artist không tự sync nữa - cậu update progress thủ công bằng `/raid-set` hoặc post clear vào monitor channel của server. Muốn bật lại thì gõ `/raid-auto-manage action:on`.";
    } else {
      // already-off
      title = "Auto-sync đã tắt sẵn rồi";
      description = "Cậu đã tắt `/raid-auto-manage` trước đó (qua slash command hoặc đã bấm button này lần trước). Không có gì để đổi.";
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
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Button đã hết hạn",
            description: "Button không có target user (có thể session cũ hoặc bot vừa restart). Gõ `/raid-check` lại để refresh nha.",
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
            title: "Tắt flag fail",
            description: `Artist gặp lỗi khi tắt: \`${result.error?.message || result.error}\`. Thử lại sau nha.`,
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
            title: "User không tồn tại",
            description: `Artist không thấy user \`${targetDiscordId}\` trong DB nữa (có thể họ đã \`/remove-roster\`). Refresh lại \`/raid-check\` để page sync state mới nha.`,
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
            title: "User đã off rồi",
            description: `<@${targetDiscordId}> đã tắt \`/raid-auto-manage\` rồi nha (có thể họ tự tắt giữa lúc cậu mở page và bấm button, hoặc Manager khác bấm trước cậu). Refresh \`/raid-check\` để page sync state mới.`,
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
        const dmEmbed = buildDisableAutoDmEmbed(EmbedBuilder, {
          managerId: interaction.user.id,
        });
        const reEnableRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`raid-check:enable-auto-self:${targetDiscordId}`)
            .setLabel("Bật lại auto-sync ngay")
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
      title: "Artist đã tắt auto-sync hộ rồi nha",
      description: [
        "Flag flip thành công. Scheduler sẽ không pull bible logs cho user này nữa cho đến khi họ (hoặc Manager) bật lại.",
        "",
        `**Đã tắt cho:** <@${targetDiscordId}>`,
        `**Trạng thái mới:** OFF`,
        dmSent
          ? "**DM thông báo:** Đã gửi (kèm button bật lại)"
          : "**DM thông báo:** Không gửi được (user tắt DM riêng), flag vẫn được flip OK",
        "",
        "Nếu user muốn bật lại thì họ gõ `/raid-auto-manage action:on` hoặc bấm button trong DM nha.",
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
    if (!targetDiscordId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Button đã hết hạn",
            description: "Button không có target user (DM bị stale hoặc bot vừa redeploy). Gõ `/raid-auto-manage action:on` thay nha.",
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
            title: "Button này chỉ chủ DM bấm được",
            description: "Button `Bật lại auto-sync ngay` chỉ user nhận DM mới có thể bấm nha. Nếu cậu muốn bật auto-sync của riêng mình, gõ `/raid-auto-manage action:on` từ trong server bất cứ lúc nào.",
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
            title: "Bật auto-sync fail",
            description: `Artist gặp lỗi khi bật: \`${result.error?.message || result.error}\`. Thử gõ \`/raid-auto-manage action:on\` thay nha.`,
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
            title: "Account không tồn tại",
            description: "Artist không tìm thấy roster của cậu trong DB nữa (có thể đã `/remove-roster` toàn bộ). Bật `/add-roster` trước rồi mới opt-in được nha.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let title;
    let description;
    if (result.outcome === "flipped") {
      title = "Đã bật lại auto-sync rồi nha~";
      description = "Artist đã bật `/raid-auto-manage` cho cậu. Từ giờ Artist sẽ tự sync raid progress mỗi 24h. Muốn tắt thì gõ `/raid-auto-manage action:off`.";
    } else {
      // already-on
      title = "Auto-sync đã bật sẵn rồi";
      description = "Cậu đã bật `/raid-auto-manage` trước đó (qua slash command hoặc đã bấm button này lần trước). Không có gì để đổi.";
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
