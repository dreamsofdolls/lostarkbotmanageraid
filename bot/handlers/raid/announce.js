"use strict";

const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");

function createRaidAnnounceCommand(deps) {
  const {
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    UI,
    User,
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
    // Slash invoker is the only viewer of every ephemeral reply on this
    // command, so resolve once and thread through every notice + success
    // embed. Scheduled announcement bodies (the actual public broadcasts
    // that fire on a cron) are localized separately in the scheduler and
    // are out of scope for this handler migration.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!guildId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-announce.auth.serverOnlyTitle", lang),
            description: t("raid-announce.auth.serverOnlyDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Defense-in-depth ManageGuild check. Same rationale as /raid-channel:
    // setDefaultMemberPermissions is a client-side render hint Discord
    // applies BEFORE routing, but a stale or failed schema registration
    // would let any member trigger the handler. Backstop with a real
    // runtime permission check.
    if (
      !interaction.memberPermissions ||
      !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
    ) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: t("raid-announce.auth.manageGuildTitle", lang),
            description: t("raid-announce.auth.manageGuildDescription", lang),
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
            title: t("raid-announce.invalid.actionTitle", lang),
            description: t("raid-announce.invalid.actionDescription", lang, { action }),
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
            title: t("raid-announce.invalid.typeTitle", lang),
            description: t("raid-announce.invalid.typeDescription", lang, { type }),
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
          ? t("raid-announce.show.destinationOverridable", lang)
          : t("raid-announce.show.destinationChannelBound", lang);
      const overrideState = current.channelId
        ? t("raid-announce.show.channelConfigOverride", lang, { channelId: current.channelId })
        : overridable
          ? t("raid-announce.show.channelConfigNoOverride", lang)
          : t("raid-announce.show.channelConfigBound", lang);
      // hourly-cleanup notice picks a random variant per fire out of a pool
      // of 12, so a single hardcoded preview would misrepresent what Artist
      // actually posts. Build the preview from the live variant pool so
      // every variant shows up - adding a new variant to the pool auto-
      // updates this preview. Other types have a single deterministic
      // message, so they keep the static `previewContent` from the registry.
      // The previews themselves are scheduled-announcement bodies (out of
      // scope for this i18n migration), so they render in their original
      // VN voice.
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
          : t("raid-announce.show.previewMissing", lang);
      }
      // Keep timing text honest: show disabled/waiting states explicitly,
      // and for polled schedulers show both the next eligible wall-clock
      // boundary and the next REAL scheduler check based on boot phase.
      // buildAnnouncementWhenItFiresText is upstream scheduler text and
      // stays in its source-of-truth voice (out of scope here).
      const scheduleText = truncateText(
        buildAnnouncementWhenItFiresText(type, entry, current, existing),
        1024
      );
      const enabledValue = current.enabled
        ? `${UI.icons.done} ${t("raid-announce.show.enabledOn", lang)}`
        : `${UI.icons.reset} ${t("raid-announce.show.enabledOff", lang)}`;
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`${UI.icons.info} ${t("raid-announce.show.title", lang, { typeLabel })}`)
        .addFields(
          { name: t("raid-announce.show.enabledLabel", lang), value: enabledValue, inline: true },
          { name: t("raid-announce.show.destinationLabel", lang), value: resolvedChannel, inline: true },
          { name: t("raid-announce.show.channelConfigLabel", lang), value: overrideState, inline: false },
          { name: t("raid-announce.show.whenLabel", lang), value: scheduleText, inline: false },
          { name: t("raid-announce.show.previewLabel", lang), value: previewText, inline: false },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "on" || action === "off") {
      const enabled = action === "on";
      const stateText = enabled
        ? t("raid-announce.show.enabledOn", lang)
        : t("raid-announce.show.enabledOff", lang);
      if (current.enabled === enabled) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-announce.toggle.noopTitle", lang),
              description: t("raid-announce.toggle.noopDescription", lang, {
                type,
                state: stateText,
              }),
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
            title: t("raid-announce.toggle.successTitle", lang),
            description: [
              t("raid-announce.toggle.successLineType", lang, { type, typeLabel }),
              t("raid-announce.toggle.successLineState", lang, { state: stateText }),
              t(
                enabled
                  ? "raid-announce.toggle.successLineImpactOn"
                  : "raid-announce.toggle.successLineImpactOff",
                lang
              ),
              "",
              t("raid-announce.toggle.successLineCheck", lang),
            ].join("\n"),
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
              title: t("raid-announce.setChannel.notOverridableTitle", lang),
              description: t("raid-announce.setChannel.notOverridableDescription", lang, {
                type,
                typeLabel,
                overridableList,
              }),
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
              title: t("raid-announce.setChannel.missingChannelTitle", lang),
              description: t("raid-announce.setChannel.missingChannelDescription", lang),
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
              title: t("raid-announce.setChannel.missingPermsTitle", lang),
              description: t("raid-announce.setChannel.missingPermsDescription", lang, {
                channelId: channel.id,
                missing: missing.join(", "),
              }),
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
            title: t("raid-announce.setChannel.successTitle", lang),
            description: [
              t("raid-announce.setChannel.successLineIntro", lang),
              "",
              t("raid-announce.setChannel.successLineType", lang, { type, typeLabel }),
              t("raid-announce.setChannel.successLineChannel", lang, { channelId: channel.id }),
              t("raid-announce.setChannel.successLineImpact", lang),
              "",
              t("raid-announce.setChannel.successLineRevert", lang, { type }),
            ].join("\n"),
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
              title: t("raid-announce.clearChannel.notOverridableTitle", lang),
              description: t("raid-announce.clearChannel.notOverridableDescription", lang, { type }),
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
              title: t("raid-announce.clearChannel.noOverrideTitle", lang),
              description: t("raid-announce.clearChannel.noOverrideDescription", lang, { type }),
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
            title: t("raid-announce.clearChannel.successTitle", lang),
            description: [
              t("raid-announce.clearChannel.successLineIntro", lang),
              "",
              t("raid-announce.clearChannel.successLineType", lang, { type, typeLabel }),
              t("raid-announce.clearChannel.successLineChannel", lang),
              t("raid-announce.clearChannel.successLineImpact", lang),
              "",
              t("raid-announce.clearChannel.successLineRevert", lang),
            ].join("\n"),
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
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
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
      options.push({ name: t("raid-announce.autocomplete.show", lang), value: "show" });
      if (current) {
        // Enabled-toggle pair: expose only the action that would actually
        // change state. Annotate with current state so admin sees impact.
        if (current.enabled) {
          options.push({ name: t("raid-announce.autocomplete.turnOffWithState", lang), value: "off" });
        } else {
          options.push({ name: t("raid-announce.autocomplete.turnOnWithState", lang), value: "on" });
        }
      } else {
        // No type picked or config load failed - expose both so user still
        // has a path forward. Generic labels, no state annotation.
        options.push({ name: t("raid-announce.autocomplete.turnOnGeneric", lang), value: "on" });
        options.push({ name: t("raid-announce.autocomplete.turnOffGeneric", lang), value: "off" });
      }
      if (overridable) {
        options.push({ name: t("raid-announce.autocomplete.setChannel", lang), value: "set-channel" });
        if (current && current.channelId) {
          options.push({ name: t("raid-announce.autocomplete.clearChannel", lang), value: "clear-channel" });
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
