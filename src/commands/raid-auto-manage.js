"use strict";

const { buildNoticeEmbed } = require("../raid/shared");

function createRaidAutoManageCommand(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    acquireAutoManageSyncSlot,
    releaseAutoManageSyncSlot,
    formatAutoManageCooldownRemaining,
    getAutoManageCooldownMs,
    weekResetStartMs,
    gatherAutoManageLogsForUserDoc,
    applyAutoManageCollected,
    isPublicLogDisabledError,
    commitAutoManageOn,
    buildAutoManageSyncReportEmbed,
    buildAutoManageHiddenCharsWarningEmbed,
    stampAutoManageAttempt,
  } = deps;

async function handleRaidAutoManageCommand(interaction) {
    const discordId = interaction.user.id;
    const action = interaction.options.getString("action", true);
    // Autocomplete only offers on/off/sync/status, but users can paste
    // arbitrary strings into slash command args. Reject early with a
    // specific hint - otherwise a typo falls through every branch and
    // Discord times out the interaction with no reply.
    if (!["on", "off", "sync", "status"].includes(action)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Action không hợp lệ",
            description: `Action \`${action}\` Artist không nhận được. Cho phép: \`on\` · \`off\` · \`sync\` · \`status\`. Autocomplete sẽ gợi ý đúng nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Redundant-state reject for manually-typed `on`/`off` (autocomplete
    // already hides the redundant option, but users can paste the full
    // option value). Cheap lean read gates both branches with one query.
    if (action === "on" || action === "off") {
      const stateUser = await User.findOne(
        { discordId },
        { autoManageEnabled: 1 }
      ).lean();
      const enabled = !!stateUser?.autoManageEnabled;
      if (action === "on" && enabled) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: "Auto-manage đang bật rồi",
              description: "Cậu đã opt-in từ trước nha. Muốn sync ngay thì action `sync`, hoặc `status` để xem trạng thái cooldown + lần sync gần nhất.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "off" && !enabled) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: "Auto-manage đang tắt sẵn",
              description: "Cậu chưa opt-in nha, không có flag để disable. Muốn bật thì action `on`.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    if (action === "off") {
      await User.findOneAndUpdate(
        { discordId },
        { $set: { autoManageEnabled: false } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      const embed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`${UI.icons.reset} Auto-manage disabled`)
        .setDescription(
          "Auto-manage đã tắt. Cậu vẫn có thể trigger sync thủ công qua `/raid-auto-manage action:sync` bất cứ lúc nào."
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "on") {
      // Two-phase enable flow:
      //   Phase A (probe): fetch user, run sync in-memory WITHOUT saving.
      //     Tell us which chars return "403 / logs not enabled" before we
      //     flip anything.
      //   Phase B (commit): re-run sync on a fresh doc inside saveWithRetry
      //     and persist. Runs either immediately (no hidden chars) or after
      //     the user clicks "Vẫn bật" on the warning.
      //
      // If phase A finds any hidden-log chars → show a warning with confirm
      // / cancel buttons. 60s collector, invoker-scoped. Cancel or timeout →
      // flag stays OFF, nothing saved.
      //
      // Guard semantics for `on` (preserved from earlier rounds):
      //   - in-flight  → reject hard.
      //   - cooldown   → flip flag only, skip both probe and sync.
      const guard = await acquireAutoManageSyncSlot(discordId);
      if (!guard.acquired && guard.reason === "in-flight") {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: "Sync khác đang chạy",
              description: "Cậu có 1 sync khác đang fetch bible cho roster rồi nha, Artist không bật song song được. Đợi nó xong khoảng 5-10 giây rồi gõ lại nhé.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const cooldownSkip = !guard.acquired && guard.reason === "cooldown";
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        // --- Cooldown path: flip flag only, skip sync ---
        if (cooldownSkip) {
          await saveWithRetry(async () => {
            const userDoc = await User.findOne({ discordId });
            if (!userDoc) {
              await User.findOneAndUpdate(
                { discordId },
                { $set: { autoManageEnabled: true } },
                { upsert: true, setDefaultsOnInsert: true }
              );
              return;
            }
            userDoc.autoManageEnabled = true;
            await userDoc.save();
          });
          const embed = new EmbedBuilder()
            .setColor(UI.colors.success)
            .setTitle(`${UI.icons.done} Auto-manage enabled (sync skipped)`)
            .setDescription(
              `Flag đã bật. Sync vừa chạy gần đây nên tớ bỏ qua initial sync lần này - đợi **${formatAutoManageCooldownRemaining(
                guard.remainingMs
              )}** rồi gõ \`/raid-auto-manage action:sync\` để pull log mới nhất.`
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        // --- Phase A: probe (no save) ---
        const weekResetStart = weekResetStartMs();
        const probeDoc = await User.findOne({ discordId });
        // No user doc at all - flag flip only, show no-roster embed.
        if (!probeDoc) {
          await User.findOneAndUpdate(
            { discordId },
            { $set: { autoManageEnabled: true } },
            { upsert: true, setDefaultsOnInsert: true }
          );
          const embed = new EmbedBuilder()
            .setColor(UI.colors.success)
            .setTitle(`${UI.icons.done} Auto-manage enabled`)
            .setDescription(
              "Đã bật auto-manage. Chưa có roster nên tớ chưa sync được gì - chạy `/add-roster` trước rồi gọi `/raid-auto-manage action:sync` để pull logs."
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        // Roster empty - flag flip only.
        if (!Array.isArray(probeDoc.accounts) || probeDoc.accounts.length === 0) {
          probeDoc.autoManageEnabled = true;
          await probeDoc.save();
          const embed = new EmbedBuilder()
            .setColor(UI.colors.success)
            .setTitle(`${UI.icons.done} Auto-manage enabled`)
            .setDescription(
              "Đã bật auto-manage. Chưa có roster nên tớ chưa sync được gì - chạy `/add-roster` trước rồi gọi `/raid-auto-manage action:sync` để pull logs."
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [embed] });
          return;
        }
        // Run gather + in-memory apply - DO NOT save probeDoc. Keep the
        // `collected` array so commit can reuse it without a second bible
        // run (previously probe + commit = 2× HTTP cost; now it's 1×).
        ensureFreshWeek(probeDoc);
        const probeCollected = await gatherAutoManageLogsForUserDoc(probeDoc, weekResetStart);
        const probeReport = applyAutoManageCollected(probeDoc, weekResetStart, probeCollected);
        const hiddenChars = (probeReport?.perChar || []).filter((c) =>
          isPublicLogDisabledError(c?.error)
        );
        // --- Direct commit path: no hidden chars found ---
        if (hiddenChars.length === 0) {
          const finalReport = await commitAutoManageOn(
            discordId,
            weekResetStart,
            probeCollected
          );
          const syncEmbed = buildAutoManageSyncReportEmbed(finalReport);
          syncEmbed.setTitle(
            `${UI.icons.done} Auto-manage enabled · initial sync ${
              (finalReport?.appliedTotal || 0) > 0 ? "complete" : "nothing to apply"
            }`
          );
          await interaction.editReply({ embeds: [syncEmbed] });
          return;
        }
        // --- Warn + confirm path: hidden chars detected ---
        const warnEmbed = buildAutoManageHiddenCharsWarningEmbed(
          hiddenChars,
          probeReport
        );
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("auto-manage:confirm-on")
            .setLabel("Vẫn bật")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("auto-manage:cancel-on")
            .setLabel("Huỷ")
            .setStyle(ButtonStyle.Secondary)
        );
        await interaction.editReply({ embeds: [warnEmbed], components: [row] });
        const replyMsg = await interaction.fetchReply();
        let decision = null;
        try {
          const btn = await replyMsg.awaitMessageComponent({
            filter: (i) =>
              i.user.id === discordId && i.customId.startsWith("auto-manage:"),
            componentType: ComponentType.Button,
            time: 60_000,
          });
          decision = btn.customId === "auto-manage:confirm-on" ? "confirm" : "cancel";
          await btn.deferUpdate().catch(() => {});
        } catch {
          decision = "timeout";
        }
        if (decision === "confirm") {
          // Reuse probeCollected so confirm doesn't re-hit bible. Data is at
          // most 60s old (collector timeout ceiling) - acceptable staleness
          // for a one-shot initial sync; next /raid-auto-manage action:sync
          // will pull fresher data under the normal cooldown.
          const finalReport = await commitAutoManageOn(
            discordId,
            weekResetStart,
            probeCollected
          );
          const syncEmbed = buildAutoManageSyncReportEmbed(finalReport);
          syncEmbed.setTitle(
            `${UI.icons.done} Auto-manage enabled · initial sync ${
              (finalReport?.appliedTotal || 0) > 0 ? "complete" : "nothing to apply"
            }`
          );
          await interaction.editReply({ embeds: [syncEmbed], components: [] });
        } else {
          // Probe HTTP already ran - stamp attempt so the cooldown reflects
          // the bible quota we consumed, even though we're not committing the
          // flag flip. Without this, spamming `action:on` + Huỷ would bypass
          // the per-user sync cooldown.
          await stampAutoManageAttempt(discordId);
          const title =
            decision === "timeout"
              ? "Auto-manage giữ OFF (timeout)"
              : "Auto-manage giữ OFF";
          const cancelEmbed = new EmbedBuilder()
            .setColor(UI.colors.muted)
            .setTitle(`${UI.icons.reset} ${title}`)
            .setDescription(
              "Không có gì thay đổi. Bật **Public Log** cho char trên <https://lostark.bible/me/logs> rồi gõ `/raid-auto-manage action:on` lại nhé."
            )
            .setTimestamp();
          await interaction.editReply({ embeds: [cancelEmbed], components: [] });
        }
      } catch (err) {
        // Same reasoning as the cancel/timeout branch: probe may have already
        // sent bible requests before the throw. Stamp so cooldown still kicks
        // in for the next attempt.
        await stampAutoManageAttempt(discordId);
        console.error("[auto-manage] enable-with-sync failed:", err?.message || err);
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: "Probe/sync fail",
              description: `Artist gặp lỗi khi probe bible: \`${err?.message || err}\`. Auto-manage **giữ OFF** nha, không bật vì sync đầu chưa thành công. Thử lại sau khoảng 1-2 phút.`,
            }),
          ],
          components: [],
        }).catch(() => {});
      } finally {
        if (!cooldownSkip) releaseAutoManageSyncSlot(discordId);
      }
      return;
    }
    if (action === "status") {
      const user = await User.findOne({ discordId }).lean();
      const enabled = !!user?.autoManageEnabled;
      const lastSync = user?.lastAutoManageSyncAt || 0;
      const lastAttempt = user?.lastAutoManageAttemptAt || 0;
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`${UI.icons.info} Auto-manage Status`)
        .addFields(
          { name: "Opt-in", value: enabled ? `${UI.icons.done} ON` : `${UI.icons.reset} OFF`, inline: true },
          {
            name: "Last success",
            value: lastSync ? `<t:${Math.floor(lastSync / 1000)}:R>` : "Chưa có lần nào thành công",
            inline: true,
          },
          {
            name: "Last attempt",
            value: lastAttempt
              ? (lastAttempt === lastSync
                  ? "(= last success)"
                  : `<t:${Math.floor(lastAttempt / 1000)}:R> - fail`)
              : "Chưa chạy bao giờ",
            inline: true,
          }
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "sync") {
      // Acquire slot BEFORE deferReply so reply-reject is a normal reply (not editReply).
      // acquireAutoManageSyncSlot reserves the slot synchronously → no TOCTOU race between check and set.
      const guard = await acquireAutoManageSyncSlot(discordId);
      if (!guard.acquired) {
        if (guard.reason === "in-flight") {
          await interaction.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: "Sync khác đang chạy",
                description: "Cậu có 1 sync khác của mình đang fetch bible rồi nha, đợi kết quả trước đừng gõ spam~ Artist sẽ DM khi xong.",
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
        } else {
          const totalCooldownText =
            typeof getAutoManageCooldownMs === "function"
              ? formatAutoManageCooldownRemaining(getAutoManageCooldownMs(discordId))
              : null;
          const cooldownDescription = [
            `Sync vừa chạy gần đây nha cậu, Artist đang giữ cooldown.`,
            "",
            `**Đợi thêm:** ${formatAutoManageCooldownRemaining(guard.remainingMs)}`,
            totalCooldownText ? `**Cooldown của cậu:** ${totalCooldownText}` : null,
            "",
            "Cooldown để tránh gõ bible liên tục, qua ngưỡng đó cậu sync tiếp được nha.",
          ].filter((line) => line !== null).join("\n");
          await interaction.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: "Đang trong cooldown",
                description: cooldownDescription,
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
        }
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const weekResetStart = weekResetStartMs();
        // Phase A: gather bible data OUTSIDE saveWithRetry so a VersionError
        // retry doesn't re-fire HTTP calls. The acquire guard already
        // prevents concurrent syncs for the same user, so the seedDoc we read
        // here is normally also the doc we save into - but /raid-set or
        // /add-roster-char could race between read and save, triggering a
        // VersionError that the retry path can handle in-memory.
        const seedDoc = await User.findOne({ discordId });
        if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
          await interaction.editReply({
            content: null,
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: "Cậu chưa có roster nào",
                description: "Artist không thấy roster nào của cậu trong DB. Dùng `/add-roster` để add roster đầu tiên rồi mới opt-in auto-manage được nha.",
              }),
            ],
          });
          return;
        }
        ensureFreshWeek(seedDoc);
        const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart);
        // Phase B: apply to fresh doc inside saveWithRetry - pure in-memory.
        let report;
        await saveWithRetry(async () => {
          const userDoc = await User.findOne({ discordId });
          if (!userDoc) {
            report = { noRoster: true };
            return;
          }
          if (!Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
            report = { noRoster: true };
            return;
          }
          ensureFreshWeek(userDoc);
          report = applyAutoManageCollected(userDoc, weekResetStart, collected);
          const now = Date.now();
          userDoc.lastAutoManageAttemptAt = now;
          if (report.perChar.some((c) => !c.error)) {
            userDoc.lastAutoManageSyncAt = now;
          }
          await userDoc.save();
        });
        if (report?.noRoster) {
          await interaction.editReply({
            content: null,
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: "Cậu chưa có roster nào",
                description: "Artist không thấy roster nào của cậu trong DB. Dùng `/add-roster` để add roster đầu tiên rồi mới opt-in auto-manage được nha.",
              }),
            ],
          });
          return;
        }
        const embed = buildAutoManageSyncReportEmbed(report);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error("[auto-manage] sync failed:", err?.message || err);
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: "Sync fail",
              description: `Artist sync không xong vì: \`${err?.message || err}\`. Có thể lostark.bible đang block (Cloudflare 403) hoặc char names có gì sai. Thử lại sau vài phút nha, nếu vẫn fail thì check char ở https://lostark.bible/me/logs.`,
            }),
          ],
        });
      } finally {
        releaseAutoManageSyncSlot(discordId);
      }
    }
  }
  /**
   * Stamp `lastAutoManageAttemptAt` without flipping any flag. Called after the
   * probe HTTP burst in cancel/timeout/error paths so the cooldown reflects
   * bible quota actually consumed - otherwise users can spam
   * `/raid-auto-manage action:on` + cancel to bypass the per-user sync cooldown.
   * Best-effort: logs and swallows DB errors so cooldown drift never masks the
   * real UX (the cancel/error message itself).
   */

  // /raid-auto-manage `action` autocomplete - filters the four actions by the
  // user's current autoManageEnabled state so the dropdown never shows the
  // redundant option (e.g. `on` while already ON).
  const AUTO_MANAGE_ACTION_CHOICES = [
    { name: "on - enable auto-sync + run an initial sync now", value: "on", showWhenOn: false, showWhenOff: true },
    { name: "off - disable auto-sync", value: "off", showWhenOn: true, showWhenOff: false },
    { name: "sync - pull bible logs now and reconcile raid progress", value: "sync", showWhenOn: true, showWhenOff: true },
    { name: "status - show current opt-in + last sync time", value: "status", showWhenOn: true, showWhenOff: true },
  ];
  async function handleRaidAutoManageAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }
      let enabled = false;
      try {
        const user = await User.findOne(
          { discordId: interaction.user.id },
          { autoManageEnabled: 1 }
        ).lean();
        enabled = !!user?.autoManageEnabled;
      } catch (err) {
        console.warn("[autocomplete] auto-manage state load failed:", err?.message || err);
      }
      const needle = normalizeName(focused.value || "");
      const choices = AUTO_MANAGE_ACTION_CHOICES
        .filter((c) => (enabled ? c.showWhenOn : c.showWhenOff))
        .filter((c) => {
          if (!needle) return true;
          return normalizeName(c.name).includes(needle) || normalizeName(c.value).includes(needle);
        })
        .map(({ name, value }) => ({ name, value }))
        .slice(0, 25);
      await interaction.respond(choices).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-auto-manage error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  }
  /**
   * Autocomplete for /raid-announce action option. Labels annotate the
   * current per-guild state so admin knows what flipping the action will
   * actually do (e.g. "Turn on · currently OFF"), and redundant actions
   * are hidden entirely (on while on, off while off, set-channel on
   * channel-bound types, clear-channel when no override set).
   *
   * When `type` hasn't been picked yet (user focuses action first), fall
   * back to generic labels without state - Discord's choice order in the
   * command schema still ensures type is pre-required, but the autocomplete
   * runs with whatever partial values the user has entered so far.
   */
  return {
    handleRaidAutoManageCommand,
    handleRaidAutoManageAutocomplete,
  };
}

module.exports = {
  createRaidAutoManageCommand,
};
