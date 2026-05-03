"use strict";

const { buildNoticeEmbed } = require("../utils/raid/shared");

const RAID_CHANNEL_GREETING_TTL_MS = 2 * 60 * 1000; // set greeting sits 2 min before self-delete

// Full action catalog for /raid-channel config. Autocomplete handler
// filters out whichever of schedule-on/schedule-off is redundant given
// the guild's current autoCleanupEnabled state - admin sees only the
// toggle that actually changes something.
const RAID_CHANNEL_ACTION_CHOICES = [
  { name: "show - view current config + health check", value: "show" },
  { name: "set - register the monitor channel (needs `channel` option)", value: "set" },
  { name: "clear - disable monitor + reset schedule", value: "clear" },
  { name: "cleanup - delete all non-pinned messages now", value: "cleanup" },
  { name: "repin - refresh the pinned welcome embed", value: "repin" },
  { name: "schedule-on - enable auto-cleanup every 30 min (VN time)", value: "schedule-on" },
  { name: "schedule-off - disable 30-min auto-cleanup", value: "schedule-off" },
];

function createRaidChannelCommand({
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  UI,
  GuildConfig,
  normalizeName,
  getCachedMonitorChannelId,
  setCachedMonitorChannelId,
  getMonitorCacheHealth,
  isTextMonitorEnabled,
  getMissingBotChannelPermissions,
  postRaidChannelWelcome,
  postChannelAnnouncement,
  getAnnouncementsConfig,
  resolveRaidMonitorChannel,
  cleanupRaidChannelMessages,
  getTargetCleanupSlotKey,
}) {
  /**
   * Autocomplete for `/raid-channel config action:*`. Returns the full action
   * catalog filtered by the user's typed prefix AND by the guild's current
   * `autoCleanupEnabled` state - hides `schedule-on` when already enabled
   * and `schedule-off` when already disabled, so admin never sees an option
   * that would be a no-op. Read-only best-effort; any DB error falls back
   * to showing both schedule options so admin can still try to run them.
   */
  async function handleRaidChannelAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }
      let autoCleanupEnabled = false;
      if (interaction.guildId) {
        try {
          const cfg = await GuildConfig.findOne({ guildId: interaction.guildId }).lean();
          autoCleanupEnabled = !!cfg?.autoCleanupEnabled;
        } catch (err) {
          console.warn("[autocomplete] raid-channel config load failed:", err?.message || err);
        }
      }
      const needle = normalizeName(focused.value || "");
      const choices = RAID_CHANNEL_ACTION_CHOICES
        .filter((c) => {
          if (autoCleanupEnabled && c.value === "schedule-on") return false;
          if (!autoCleanupEnabled && c.value === "schedule-off") return false;
          if (!needle) return true;
          return normalizeName(c.name).includes(needle) || normalizeName(c.value).includes(needle);
        })
        .slice(0, 25);
      await interaction.respond(choices).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-channel error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  }
  async function handleRaidChannelCommand(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Server only",
            description: "Cậu phải chạy `/raid-channel config` trong server nha, Artist không config được monitor channel ở DM đâu.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Defense-in-depth ManageGuild check. The slash command schema sets
    // setDefaultMemberPermissions(ManageGuild) so Discord hides the entry
    // for unprivileged members, but that's a client-side render hint only:
    // if the schema ever fails to register (e.g. deploy-commands.js mid-
    // failure leaves stale registration without the flag), Discord will
    // happily route invocations to the handler. The runtime check
    // guarantees only ManageGuild members can mutate channel/monitor
    // config regardless of registration state.
    if (
      !interaction.memberPermissions ||
      !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
    ) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: "Cần Manage Server",
            description: "Lệnh `/raid-channel config` chỉ dành cho thành viên có quyền **Manage Server** trên Discord. Nhờ admin mở quyền hộ rồi thử lại nha~",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Single subcommand `config` - dispatch by the `action` option value.
    // Merged from six separate subcommands so the autocomplete dropdown at
    // `/raid-channel` shows one entry (discoverable + less visually cluttered)
    // and the admin picks the concrete action from the required `action`
    // choice list.
    const action = interaction.options.getString("action", true);
    if (action === "set") {
      const channel = interaction.options.getChannel("channel");
      if (!channel) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Thiếu option `channel`",
              description: "Action `set` cần kèm option `channel:#<tên-kênh>` để Artist biết monitor kênh nào. Ví dụ: `/raid-channel config action:set channel:#raid-clears`.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Refuse to set if the text monitor is disabled at the deploy layer -
      // saving config + posting a pinned welcome would mislead members into
      // thinking the channel is active when MessageCreate is silently dropped.
      if (!isTextMonitorEnabled()) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: "Text monitor đang tắt ở deploy layer",
              description: "Env var `TEXT_MONITOR_ENABLED=false` đang khoá MessageCreate listener. Bật env var đó (kèm enable Message Content Intent ở Developer Portal nếu chưa) rồi redeploy, xong mới `/raid-channel config action:set` được nha. Không config sẽ không có effect.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Verify the bot has the channel-level permissions this feature needs
      // BEFORE persisting - otherwise admin gets a success embed for a
      // channel where the monitor will silently fail (can't read messages,
      // can't reply to errors, or can't delete on success).
      const botMember = interaction.guild?.members?.me;
      const missing = getMissingBotChannelPermissions(channel, botMember);
      if (missing.length > 0) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: "Bot thiếu permission",
              description: `Artist không monitor được <#${channel.id}> vì thiếu: **${missing.join(", ")}**. Grant cho bot ở channel đó rồi chạy lại \`/raid-channel config action:set\` nha.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { guildId, raidChannelId: channel.id },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      setCachedMonitorChannelId(guildId, channel.id);
      // Post + pin a fresh welcome via the shared helper. It unpins the
      // previously-stored welcome (if any) using GuildConfig.welcomeMessageId
      // and persists the new pin's ID there so repeated `set` or `repin`
      // invocations target the exact bot welcome instead of all bot pins.
      const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
      const welcomeStatus = welcome.posted
        ? welcome.pinned ? "posted & pinned" : "posted (pin failed)"
        : "NOT posted";
      // Ceremonial "Artist arrive" greeting posted in the monitor channel
      // right after the welcome pin lands. Separate from the pinned welcome
      // (long-lived documentation) - the greeting is an ephemeral
      // announcement (TTL 2 min) so channel members actively online see
      // Artist take up residence. Only post when the welcome itself
      // succeeded - if welcome.posted is false, the channel is in a broken
      // state and a greeting would be misleading.
      if (welcome.posted) {
        // Set greeting can be disabled per-guild via /raid-announce.
        let greetingEnabled = true;
        try {
          const existingCfg = await GuildConfig.findOne({ guildId })
            .select("announcements.setGreeting")
            .lean();
          greetingEnabled = getAnnouncementsConfig(existingCfg).setGreeting.enabled;
        } catch {
          // default enabled on read error
        }
        if (greetingEnabled) {
          await postChannelAnnouncement(
            channel,
            "Ồ, chỗ mới này Artist được mời đến trông coi nhỉ~ Xin chào các cậu, từ giờ cứ post clear raid theo format ở welcome pin phía trên là Artist tự cập nhật progress cho nha. Biển báo này Artist cuỗm đi sau 2 phút, welcome thì giữ nguyên.",
            RAID_CHANNEL_GREETING_TTL_MS,
            "raid-channel set greeting"
          );
        }
      }
      const embed = new EmbedBuilder()
        .setColor(UI.colors.success)
        .setTitle(`${UI.icons.done} Raid Channel Set`)
        .setDescription(
          `Bot sẽ monitor <#${channel.id}> và parse message dạng \`<raid> <difficulty> <character> [gate]\`.`
        )
        .addFields(
          { name: "Examples", value: "`Serca Nightmare Clauseduk` → mark raid as DONE\n`Serca Nor Soulrano G1` → mark G1 as done" },
          { name: "Welcome message", value: `${welcome.posted ? UI.icons.done : UI.icons.warn} ${welcomeStatus} in <#${channel.id}>.` },
          { name: "Nếu cậu đổi channel trước đó", value: "Remember to unpin/delete welcome message ở channel cũ để members không nhầm." },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "show") {
      const channelId = getCachedMonitorChannelId(guildId);
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`${UI.icons.info} Raid Channel`);
      // Deploy-level state warnings regardless of config state.
      const deployNotes = [];
      if (!isTextMonitorEnabled()) {
        deployNotes.push(
          `${UI.icons.warn} Text monitor đang bị tắt ở deploy layer (\`TEXT_MONITOR_ENABLED=false\`). Bot bỏ qua mọi message đến.`
        );
      }
      const { healthy, error } = getMonitorCacheHealth();
      if (!healthy) {
        deployNotes.push(
          `${UI.icons.warn} Cache config chưa load được ở boot${error ? ` (\`${error}\`)` : ""}. Monitor inactive cho đến khi load lại. Bot cần redeploy hoặc fix kết nối Mongo.`
        );
      }
      if (!channelId) {
        const lines = ["Chưa config channel nào. Dùng `/raid-channel config action:set channel:#<channel>` để bật."];
        if (deployNotes.length > 0) lines.push("", ...deployNotes);
        embed.setDescription(lines.join("\n"));
      } else {
        // Channel cache can be cold right after bot restart - fall back to
        // an API fetch so we don't false-positive "inaccessible" on a
        // channel the bot actually has access to.
        let channel = interaction.guild?.channels?.cache?.get(channelId) || null;
        if (!channel && interaction.guild?.channels?.fetch) {
          try {
            channel = await interaction.guild.channels.fetch(channelId);
          } catch {
            channel = null;
          }
        }
        const botMember = interaction.guild?.members?.me;
        const missing = channel ? getMissingBotChannelPermissions(channel, botMember) : null;
        const lines = [`Monitoring <#${channelId}>.`];
        if (!channel) {
          lines.push(`${UI.icons.warn} Channel không truy cập được (bị xóa hoặc bot không có access).`);
        } else if (missing && missing.length > 0) {
          lines.push(`${UI.icons.warn} Bot thiếu permission: **${missing.join(", ")}**. Feature có thể fail im lặng.`);
        } else {
          lines.push(`${UI.icons.done} Permissions OK.`);
        }
        if (deployNotes.length > 0) lines.push("", ...deployNotes);
        embed.setDescription(lines.join("\n"));
      }
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "clear") {
      // Always write-through Mongo regardless of cache state. Cache is a
      // mirror, not the source of truth - if loadMonitorChannelCache had
      // failed at boot the cache is empty, but Mongo might still have a
      // non-null raidChannelId that `clear` needs to actually clear.
      // findOneAndUpdate without upsert is a no-op when no doc exists.
      //
      // Also cascade `autoCleanupEnabled` to false so a previously-scheduled
      // auto-cleanup doesn't reactivate the moment admin /sets a fresh
      // channel later - that would silently purge the new channel before
      // admin has a chance to opt back in.
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $set: { raidChannelId: null, autoCleanupEnabled: false } }
      );
      setCachedMonitorChannelId(guildId, null);
      const embed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`${UI.icons.reset} Raid Channel Cleared`)
        .setDescription("Monitor đã được tắt và auto-cleanup schedule cũng bị reset. Bot sẽ không xử lý message text nữa. Dùng `/raid-channel config action:set channel:#<channel>` + `action:schedule-on` để bật lại.");
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "cleanup") {
      const channelId = getCachedMonitorChannelId(guildId);
      if (!channelId) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Chưa config channel",
              description: "Cậu chưa set monitor channel nào cho Artist nha. Chạy `/raid-channel config action:set channel:#<tên-kênh>` trước rồi mới dùng action này được.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channel = await resolveRaidMonitorChannel(interaction, channelId);
      if (!channel) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Channel không truy cập được",
              description: `Artist không vào được <#${channelId}> (channel có thể đã bị xoá hoặc bot không có access). Cậu kiểm tra lại channel + permission nha, rồi \`/raid-channel config action:set\` lại nếu cần.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { deleted, skippedOld } = await cleanupRaidChannelMessages(channel);
        const embed = new EmbedBuilder()
          .setColor(UI.colors.success)
          .setTitle(`${UI.icons.done} Channel Cleaned`)
          .setDescription(`Đã dọn <#${channel.id}>, pinned messages giữ nguyên.`)
          .addFields({ name: "Deleted", value: `${deleted} message(s)`, inline: true })
          .setTimestamp();
        if (skippedOld > 0) {
          embed.addFields({ name: "Skipped (>14 ngày)", value: `${skippedOld}`, inline: true });
        }
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error("[raid-channel] manual cleanup failed:", err?.message || err);
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: "Cleanup fail",
              description: `Artist dọn channel không xong vì \`${err?.message || err}\`. Check bot permission (Manage Messages + Read Message History) rồi thử lại nha.`,
            }),
          ],
        });
      }
      return;
    }
    if (action === "repin") {
      const channelId = getCachedMonitorChannelId(guildId);
      if (!channelId) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Chưa config channel",
              description: "Cậu chưa set monitor channel nào cho Artist nha. Chạy `/raid-channel config action:set channel:#<tên-kênh>` trước rồi mới dùng action này được.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channel = await resolveRaidMonitorChannel(interaction, channelId);
      if (!channel) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Channel không truy cập được",
              description: `Artist không vào được <#${channelId}> (channel có thể đã bị xoá hoặc bot không có access). Cậu kiểm tra lại channel + permission nha, rồi \`/raid-channel config action:set\` lại nếu cần.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
      const embed = new EmbedBuilder()
        .setColor(welcome.posted && welcome.pinned ? UI.colors.success : UI.colors.progress)
        .setTitle(`${UI.icons.roster} Welcome Repinned`)
        .setDescription(`<#${channel.id}>`)
        .addFields(
          { name: "Removed old welcome", value: `${welcome.removedOldCount}`, inline: true },
          { name: "New welcome", value: welcome.posted ? (welcome.pinned ? "posted & pinned" : "posted (pin failed)") : "NOT posted", inline: true },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    if (action === "schedule-on" || action === "schedule-off") {
      const enabled = action === "schedule-on";
      // Defend against autocomplete bypass: autocomplete hides the
      // redundant option, but a user can still type + submit the
      // same-state action. Surface a specific no-op notice instead of
      // running a misleading success embed on an idempotent DB write.
      try {
        const cfg = await GuildConfig.findOne({ guildId }).lean();
        if (cfg && !!cfg.autoCleanupEnabled === enabled) {
          await interaction.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "info",
                title: "Không có gì đổi",
                description: `Schedule auto-cleanup đang ở state \`${enabled ? "on" : "off"}\` rồi nha cậu, Artist không stamp lại.`,
              }),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      } catch (err) {
        // Tolerate DB read error - fall through to the normal toggle path
        // so admin still has a way to flip the flag.
        console.warn("[raid-channel] schedule no-op check failed:", err?.message || err);
      }
      // Refuse to enable schedule without a configured monitor channel -
      // the scheduler filters on `raidChannelId != null`, so enabling now
      // would give admin a success embed for a job that never runs.
      if (enabled && !getCachedMonitorChannelId(guildId)) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Chưa config channel",
              description: "Cậu phải `/raid-channel config action:set channel:#<tên-kênh>` trước rồi mới enable schedule được nha. Không thì scheduler không có channel để dọn, thành ra fire vô ích.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Enable ALWAYS stamps today's VN day key - even on re-enable after
      // days off - so the first tick after flipping the flag never runs a
      // catch-up cleanup. Admin expectation on "turn the schedule on" is
      // "schedule starts fresh", not "immediately purge everything since
      // the last run." Bot-offline catch-up still works when the schedule
      // stays enabled the whole time: the tick after restart sees a stale
      // lastAutoCleanupKey and runs once. Disable leaves the key alone so
      // it's available for debugging, but it's overwritten on the next
      // enable regardless.
      const update = enabled
        ? { $set: { autoCleanupEnabled: true, lastAutoCleanupKey: getTargetCleanupSlotKey() } }
        : { $set: { autoCleanupEnabled: false } };
      await GuildConfig.findOneAndUpdate(
        { guildId },
        update,
        { upsert: true, setDefaultsOnInsert: true }
      );
      const embed = new EmbedBuilder()
        .setColor(enabled ? UI.colors.success : UI.colors.muted)
        .setTitle(`${enabled ? UI.icons.done : UI.icons.reset} Auto-cleanup ${enabled ? "enabled" : "disabled"}`)
        .setDescription(
          enabled
            ? "Mỗi 30 phút (slot :00 và :30 giờ VN), Artist sẽ tự xóa toàn bộ message không được pin trong monitor channel. Welcome pin giữ nguyên. Sau khi dọn, Artist post 1 biển báo 4-bucket (sạch sẵn / 1-5 / 6-20 / 21+ tin) với nhiều variant random pick; biển tự biến mất sau 5 phút. Nếu bot offline qua 1 slot boundary, tick tiếp theo sau khi online sẽ catch-up."
            : "Auto-cleanup đã tắt. Admin vẫn có thể chạy thủ công qua `/raid-channel config action:cleanup` bất cứ lúc nào."
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  }

  return {
    handleRaidChannelAutocomplete,
    handleRaidChannelCommand,
  };
}

module.exports = {
  createRaidChannelCommand,
};
