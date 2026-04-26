"use strict";

const { buildNoticeEmbed } = require("../raid/shared");

function createRaidAnnounceCommand(deps) {
  const {
    EmbedBuilder,
    MessageFlags,
    UI,
    GuildConfig,
    normalizeName,
    truncateText,
    announcementTypeEntry,
    getAnnouncementsConfig,
    buildCleanupNoticePreview,
    buildMaintenancePreview,
    buildAnnouncementWhenItFiresText,
    getMissingAnnouncementChannelPermissions,
    announcementOverridableTypeKeys,
  } = deps;

async function handleRaidAnnounceCommand(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Server only",
            description: "Cậu phải chạy `/raid-announce` trong server nha, Artist không config được announcement ở DM đâu.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const type = interaction.options.getString("type", true);
    const action = interaction.options.getString("action", true);
    const channel = interaction.options.getChannel("channel", false);
    const validActions = ["show", "on", "off", "set-channel", "clear-channel"];
    // Autocomplete hides invalid values, but slash inputs are still free-text
    // underneath. Reject typos explicitly so the interaction never falls
    // through to Discord's "application did not respond" timeout.
    if (!validActions.includes(action)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Action không hợp lệ",
            description: `Action \`${action}\` Artist không nhận được. Cho phép: \`show\` · \`on\` · \`off\` · \`set-channel\` · \`clear-channel\`.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const entry = announcementTypeEntry(type);
    if (!entry) {
      // Discord's static choices should prevent this, but guard against
      // future drift (e.g. someone renames a registry key and forgets to
      // redeploy slash commands).
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Loại announcement không hợp lệ",
            description: `Type \`${type}\` không có trong registry. Có thể slash schema chưa redeploy sau khi rename, cậu thử \`/raid-announce\` lại với dropdown gợi ý nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const { subdocKey, label: typeLabel, channelOverridable: overridable } = entry;
    // Read current config first so show/on/off paths don't force an upsert
    // just to display state. Missing cfg → treat as legacy (all defaults).
    const existing = await GuildConfig.findOne({ guildId }).lean();
    const announcements = getAnnouncementsConfig(existing);
    const current = announcements[subdocKey];
    if (action === "show") {
      const resolvedChannelId = current.channelId || existing?.raidChannelId || null;
      const resolvedChannel = resolvedChannelId
        ? `<#${resolvedChannelId}>`
        : overridable
          ? "*(no destination set - either set an override here or configure the monitor channel via /raid-channel config action:set)*"
          : "*(no monitor channel set - run /raid-channel config action:set first)*";
      const overrideState = current.channelId
        ? `Override: <#${current.channelId}>`
        : overridable
          ? "No override set (falls back to monitor channel)"
          : "Channel-bound (override not applicable)";
      // hourly-cleanup notice picks a random variant per fire out of a pool
      // of 12, so a single hardcoded preview would misrepresent what Artist
      // actually posts. Build the preview from the live variant pool so
      // every variant shows up - adding a new variant to the pool auto-
      // updates this preview. Other types have a single deterministic
      // message, so they keep the static `previewContent` from the registry.
      let previewText;
      if (type === "hourly-cleanup") {
        previewText = truncateText(buildCleanupNoticePreview(), 1024);
      } else if (type === "maintenance-early") {
        previewText = truncateText(buildMaintenancePreview("early"), 1024);
      } else if (type === "maintenance-countdown") {
        previewText = truncateText(buildMaintenancePreview("countdown"), 1024);
      } else {
        previewText = entry.previewContent
          ? truncateText(entry.previewContent, 1024)
          : "*(no preview defined for this type)*";
      }
      // Keep timing text honest: show disabled/waiting states explicitly,
      // and for polled schedulers show both the next eligible wall-clock
      // boundary and the next REAL scheduler check based on boot phase.
      const scheduleText = truncateText(
        buildAnnouncementWhenItFiresText(type, entry, current, existing),
        1024
      );
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`${UI.icons.info} Announcement · ${typeLabel}`)
        .addFields(
          { name: "Enabled", value: current.enabled ? `${UI.icons.done} ON` : `${UI.icons.reset} OFF`, inline: true },
          { name: "Destination", value: resolvedChannel, inline: true },
          { name: "Channel config", value: overrideState, inline: false },
          { name: "When it fires", value: scheduleText, inline: false },
          { name: "Message preview", value: previewText, inline: false },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "on" || action === "off") {
      const enabled = action === "on";
      if (current.enabled === enabled) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: "Không có gì đổi",
              description: `\`${type}\` đang **${enabled ? "ON" : "OFF"}** rồi, Artist không stamp lại nha. Muốn xem state hiện tại thì chạy action \`show\`.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $set: { [`announcements.${subdocKey}.enabled`]: enabled } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "success",
            title: "Đã chuyển trạng thái",
            description: `\`${type}\` giờ là **${enabled ? "ON" : "OFF"}** nha, lần fire kế tiếp Artist sẽ ${enabled ? "post lại bình thường" : "im lặng skip"}.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "set-channel") {
      if (!overridable) {
        // Build the "accepted overridable types" list from the registry so a
        // newly-added overridable type (e.g. maintenance-* in 2026-04-27)
        // automatically shows up in this reject message. Earlier text was
        // hard-coded "weekly-reset và stuck-nudge" and drifted out of sync
        // when the maintenance types landed.
        const overridableList = announcementOverridableTypeKeys()
          .map((k) => `\`${k}\``)
          .join(", ");
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Loại này không override được",
              description: `\`${type}\` (${typeLabel}) luôn post vào monitor channel theo thiết kế, Artist không cho override được đâu. Chỉ ${overridableList} mới chấp nhận \`set-channel\`.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!channel) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Thiếu option `channel`",
              description: "Action `set-channel` cần kèm option `channel:#abc` để Artist biết override sang đâu. Chạy lại `/raid-announce ... action:set-channel channel:#tên-kênh` nha.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const botMember = interaction.guild?.members?.me;
      const missing = getMissingAnnouncementChannelPermissions(channel, botMember);
      if (missing.length > 0) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: "Bot thiếu permission",
              description: `Artist không post được vào <#${channel.id}> vì thiếu: **${missing.join(", ")}**. Cậu grant cho bot ở channel đó rồi chạy lại \`/raid-announce ... action:set-channel\` nha.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $set: { [`announcements.${subdocKey}.channelId`]: channel.id } },
        { upsert: true, setDefaultsOnInsert: true }
      );
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "success",
            title: "Override channel xong",
            description: `\`${type}\` giờ post vào <#${channel.id}> nha. Lần fire kế tiếp Artist sẽ ghé qua đó. Muốn revert thì action \`clear-channel\`.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "clear-channel") {
      if (!overridable) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Loại này không có override",
              description: `\`${type}\` là channel-bound (luôn post vào monitor channel theo thiết kế), nên không có override để clear. Chỉ overridable types mới có dòng override để xóa.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!current.channelId) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: "Không có gì để clear",
              description: `\`${type}\` đang post thẳng vào monitor channel mặc định, override hiện đã \`null\` rồi. Muốn check thì action \`show\`.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $set: { [`announcements.${subdocKey}.channelId`]: null } }
      );
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "success",
            title: "Override đã clear",
            description: `\`${type}\` revert về monitor channel mặc định nha. Lần fire kế tiếp Artist sẽ post vào đó. Muốn override lại thì action \`set-channel channel:#abc\`.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Action validation at the top of the handler already rejects every
    // string that isn't in `validActions`, so this fallthrough is unreachable.
    // Removed the final reject branch entirely - if a future contributor
    // adds a new valid action they'll see compile-time errors via the action
    // dispatch chain instead of a silently-rendered "invalid action" notice.
  }
  // ---------------------------------------------------------------------------

  async function handleRaidAnnounceAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "action") {
        await interaction.respond([]).catch(() => {});
        return;
      }
      const typeValue = interaction.options.getString("type");
      const entry = typeValue ? announcementTypeEntry(typeValue) : null;
      // Load per-guild state only when type is known. Cheap single-doc
      // projection - autocomplete fires per-keystroke so keep it lean.
      let current = null;
      if (entry && interaction.guildId) {
        try {
          const cfg = await GuildConfig.findOne({ guildId: interaction.guildId })
            .select(`announcements.${entry.subdocKey} raidChannelId`)
            .lean();
          current = getAnnouncementsConfig(cfg)[entry.subdocKey];
        } catch (err) {
          console.warn("[autocomplete] raid-announce state load failed:", err?.message || err);
        }
      }
      const overridable = entry?.channelOverridable === true;
      const options = [];
      // Always available - pure read.
      options.push({ name: "Show current config", value: "show" });
      if (current) {
        // Enabled-toggle pair: expose only the action that would actually
        // change state. Annotate with current state so admin sees impact.
        if (current.enabled) {
          options.push({ name: "Turn off · currently ON", value: "off" });
        } else {
          options.push({ name: "Turn on · currently OFF", value: "on" });
        }
      } else {
        // No type picked or config load failed - expose both so user still
        // has a path forward. Generic labels, no state annotation.
        options.push({ name: "Turn on", value: "on" });
        options.push({ name: "Turn off", value: "off" });
      }
      if (overridable) {
        options.push({ name: "Set channel override", value: "set-channel" });
        if (current && current.channelId) {
          options.push({ name: "Clear channel override", value: "clear-channel" });
        }
      }
      // For channel-bound types we simply OMIT set-channel + clear-channel
      // so the dropdown can't even suggest them. The handler still has a
      // reject path as a belt-and-suspenders guard if someone types the
      // action string directly via API.
      const needle = normalizeName(focused.value || "");
      const filtered = (!needle
        ? options
        : options.filter(
            (c) => normalizeName(c.name).includes(needle) || normalizeName(c.value).includes(needle)
          )
      ).slice(0, 25);
      await interaction.respond(filtered).catch(() => {});
    } catch (err) {
      console.error("[autocomplete] raid-announce error:", err?.message || err);
      await interaction.respond([]).catch(() => {});
    }
  }
  return {
    handleRaidAnnounceCommand,
    handleRaidAnnounceAutocomplete,
  };
}

module.exports = {
  createRaidAnnounceCommand,
};
