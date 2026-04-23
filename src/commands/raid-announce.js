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
    buildAnnouncementWhenItFiresText,
    getMissingAnnouncementChannelPermissions,
  } = deps;

async function handleRaidAnnounceCommand(interaction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: `${UI.icons.warn} Command này phải chạy trong server.`,
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
        content: `${UI.icons.warn} Action không hợp lệ: \`${action}\`. Chọn một trong \`show\` · \`on\` · \`off\` · \`set-channel\` · \`clear-channel\`.`,
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
        content: `${UI.icons.warn} Loại announcement không hợp lệ: \`${type}\`.`,
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
          content: `${UI.icons.info} \`${type}\` đã ${enabled ? "on" : "off"} rồi, không cần đổi.`,
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
        content: `${UI.icons.done} \`${type}\` đã chuyển sang **${enabled ? "ON" : "OFF"}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "set-channel") {
      if (!overridable) {
        await interaction.reply({
          content: `${UI.icons.warn} \`${type}\` là channel-bound (${typeLabel}) - không override channel được. Announcement này luôn post vào monitor channel. Chỉ \`weekly-reset\` và \`stuck-nudge\` chấp nhận override.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!channel) {
        await interaction.reply({
          content: `${UI.icons.warn} action:set-channel cần option \`channel\`. Thử lại với channel mục tiêu nhé.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const botMember = interaction.guild?.members?.me;
      const missing = getMissingAnnouncementChannelPermissions(channel, botMember);
      if (missing.length > 0) {
        await interaction.reply({
          content: `${UI.icons.warn} Bot thiếu permission trong <#${channel.id}>: **${missing.join(", ")}**. Grant cho bot rồi chạy lại \`/raid-announce\` nhé.`,
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
        content: `${UI.icons.done} \`${type}\` override sang <#${channel.id}>. Lần fire kế tiếp Artist sẽ post vào đó.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "clear-channel") {
      if (!overridable) {
        await interaction.reply({
          content: `${UI.icons.warn} \`${type}\` không có override để clear (channel-bound).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (!current.channelId) {
        await interaction.reply({
          content: `${UI.icons.info} \`${type}\` đã dùng monitor channel mặc định sẵn rồi, không có override để clear.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await GuildConfig.findOneAndUpdate(
        { guildId },
        { $set: { [`announcements.${subdocKey}.channelId`]: null } }
      );
      await interaction.reply({
        content: `${UI.icons.done} \`${type}\` override đã clear - revert về monitor channel mặc định.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({
      content: `${UI.icons.warn} Action không hợp lệ: \`${action}\`.`,
      flags: MessageFlags.Ephemeral,
    });
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
