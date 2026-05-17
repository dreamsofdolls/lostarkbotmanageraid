"use strict";

const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const {
  t,
  getUserLanguage,
  getGuildLanguage,
  setGuildLanguage,
  SUPPORTED_LANGUAGES,
} = require("../../services/i18n");

const RAID_CHANNEL_GREETING_TTL_MS = 2 * 60 * 1000; // set greeting sits 2 min before self-delete

// Full action catalog for /raid-channel config. Autocomplete handler
// filters out whichever of schedule-on/schedule-off is redundant given
// the guild's current autoCleanupEnabled state - admin sees only the
// toggle that actually changes something. Labels resolve via i18n at
// autocomplete time so the dropdown text matches the invoker's locale.
const RAID_CHANNEL_ACTION_CHOICES = [
  { value: "show", labelKey: "show" },
  { value: "set", labelKey: "set" },
  { value: "clear", labelKey: "clear" },
  { value: "cleanup", labelKey: "cleanup" },
  { value: "repin", labelKey: "repin" },
  { value: "schedule-on", labelKey: "scheduleOn" },
  { value: "schedule-off", labelKey: "scheduleOff" },
  // Per-guild broadcast language switch. Persists on GuildConfig.language and
  // is read at every public-broadcast firing site via getGuildLanguage().
  // Lives under the same `action:` autocomplete so admins discover it next to
  // the existing channel config knobs.
  { value: "set-language", labelKey: "setLanguage", external: true },
  // Per-guild background-image rehost channel for /raid-bg uploads.
  // Persists on GuildConfig.raidBgChannelId and is read by /raid-bg set
  // at upload time. Sits next to `set` so the admin who configured the
  // raid monitor channel discovers the bg channel knob too.
  { value: "set-bg-channel", labelKey: "setBgChannel" },
];

function createRaidChannelCommand({
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  UI,
  User,
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
      const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
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
          return true;
        })
        .map((c) => ({
          // set-language pulls its label from the dedicated namespace; the
          // pre-existing actions stay under raid-channel.autocomplete.*.
          name: c.external
            ? t(`raid-channel-language.${c.labelKey === "setLanguage" ? "autocompleteLabel" : c.labelKey}`, lang)
            : t(`raid-channel.autocomplete.${c.labelKey}`, lang),
          value: c.value,
        }))
        .filter((c) => {
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
    // Slash invoker is the only viewer of every ephemeral reply on this
    // command. Resolve once and thread through every notice + success
    // embed. The public greeting also uses the invoker's lang as a stand-in
    // for guild lang (no per-guild language config exists yet).
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    if (!guildId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-channel.auth.serverOnlyTitle", lang),
            description: t("raid-channel.auth.serverOnlyDescription", lang),
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
            title: t("raid-channel.auth.manageGuildTitle", lang),
            description: t("raid-channel.auth.manageGuildDescription", lang),
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
              title: t("raid-channel.set.missingChannelTitle", lang),
              description: t("raid-channel.set.missingChannelDescription", lang),
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
              title: t("raid-channel.set.monitorDisabledTitle", lang),
              description: t("raid-channel.set.monitorDisabledDescription", lang),
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
              title: t("raid-channel.set.missingPermsTitle", lang),
              description: t("raid-channel.set.missingPermsDescription", lang, {
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
        { guildId, raidChannelId: channel.id },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      setCachedMonitorChannelId(guildId, channel.id);
      // Post + pin a fresh welcome via the shared helper. It unpins the
      // previously-stored welcome (if any) using GuildConfig.welcomeMessageId
      // and persists the new pin's ID there so repeated `set` or `repin`
      // invocations target the exact bot welcome instead of all bot pins.
      const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
      // Ceremonial "Artist arrive" greeting posted in the monitor channel
      // right after the welcome pin lands. Separate from the pinned welcome
      // (long-lived documentation) - the greeting is an ephemeral
      // announcement (TTL 2 min) so channel members actively online see
      // Artist take up residence. Only post when the welcome itself
      // succeeded - if welcome.posted is false, the channel is in a broken
      // state and a greeting would be misleading. Greeting is a public
      // broadcast - render in the guild's broadcast language so the voice
      // matches every other public announcement going forward.
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
          const guildLang = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
          await postChannelAnnouncement(
            channel,
            t("raid-channel.set.greetingMessage", guildLang),
            RAID_CHANNEL_GREETING_TTL_MS,
            "raid-channel set greeting"
          );
        }
      }
      const welcomeIcon = welcome.posted ? UI.icons.done : UI.icons.warn;
      const welcomeKey = welcome.posted
        ? welcome.pinned
          ? "welcomeValuePostedPinned"
          : "welcomeValuePostedNoPin"
        : "welcomeValueNotPosted";
      const embed = new EmbedBuilder()
        .setColor(UI.colors.success)
        .setTitle(`${UI.icons.done} ${t("raid-channel.set.successTitle", lang)}`)
        .setDescription(
          t("raid-channel.set.successDescription", lang, { channelId: channel.id })
        )
        .addFields(
          {
            name: t("raid-channel.set.examplesField", lang),
            value: t("raid-channel.set.examplesValue", lang),
          },
          {
            name: t("raid-channel.set.welcomeField", lang),
            value: t(`raid-channel.set.${welcomeKey}`, lang, {
              icon: welcomeIcon,
              channelId: channel.id,
            }),
          },
          {
            name: t("raid-channel.set.changeChannelField", lang),
            value: t("raid-channel.set.changeChannelValue", lang),
          },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "show") {
      const channelId = getCachedMonitorChannelId(guildId);
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`${UI.icons.info} ${t("raid-channel.show.title", lang)}`);
      // Deploy-level state warnings regardless of config state.
      const deployNotes = [];
      if (!isTextMonitorEnabled()) {
        deployNotes.push(
          t("raid-channel.show.monitorDisabledNote", lang, { icon: UI.icons.warn })
        );
      }
      const { healthy, error } = getMonitorCacheHealth();
      if (!healthy) {
        const errorSuffix = error
          ? t("raid-channel.show.cacheUnhealthyErrorSuffix", lang, { error })
          : "";
        deployNotes.push(
          t("raid-channel.show.cacheUnhealthyNote", lang, {
            icon: UI.icons.warn,
            errorSuffix,
          })
        );
      }
      // Resolve the broadcast language line up front so it can be appended
      // to either the no-config or configured branches consistently. Admin
      // always wants to know what voice the public broadcasts will use,
      // independent of whether the monitor channel is set yet.
      let broadcastLangLine = null;
      try {
        const guildLangCode = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
        const langEntry =
          SUPPORTED_LANGUAGES.find((l) => l.code === guildLangCode) ||
          SUPPORTED_LANGUAGES.find((l) => l.code === "vi");
        if (langEntry) {
          broadcastLangLine = t("raid-channel-language.showCurrentLine", lang, {
            flag: langEntry.flag,
            label: langEntry.label,
          });
        }
      } catch (err) {
        console.warn("[raid-channel] guild language read failed:", err?.message || err);
      }
      if (!channelId) {
        const lines = [t("raid-channel.show.noConfigLine", lang)];
        if (broadcastLangLine) lines.push("", broadcastLangLine);
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
        const lines = [t("raid-channel.show.monitoringLine", lang, { channelId })];
        if (!channel) {
          lines.push(t("raid-channel.show.channelInaccessibleLine", lang, { icon: UI.icons.warn }));
        } else if (missing && missing.length > 0) {
          lines.push(
            t("raid-channel.show.channelMissingPermsLine", lang, {
              icon: UI.icons.warn,
              missing: missing.join(", "),
            })
          );
        } else {
          lines.push(t("raid-channel.show.channelOkLine", lang, { icon: UI.icons.done }));
        }
        if (broadcastLangLine) lines.push("", broadcastLangLine);
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
        .setTitle(`${UI.icons.reset} ${t("raid-channel.clear.title", lang)}`)
        .setDescription(t("raid-channel.clear.description", lang));
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
              title: t("raid-channel.cleanup.noConfigTitle", lang),
              description: t("raid-channel.cleanup.noConfigDescription", lang),
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
              title: t("raid-channel.cleanup.channelGoneTitle", lang),
              description: t("raid-channel.cleanup.channelGoneDescription", lang, { channelId }),
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
          .setTitle(`${UI.icons.done} ${t("raid-channel.cleanup.successTitle", lang)}`)
          .setDescription(
            t("raid-channel.cleanup.successDescription", lang, { channelId: channel.id })
          )
          .addFields({
            name: t("raid-channel.cleanup.deletedField", lang),
            value: t("raid-channel.cleanup.deletedValue", lang, { count: deleted }),
            inline: true,
          })
          .setTimestamp();
        if (skippedOld > 0) {
          embed.addFields({
            name: t("raid-channel.cleanup.skippedField", lang),
            value: `${skippedOld}`,
            inline: true,
          });
        }
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error("[raid-channel] manual cleanup failed:", err?.message || err);
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: t("raid-channel.cleanup.failTitle", lang),
              description: t("raid-channel.cleanup.failDescription", lang, {
                error: err?.message || err,
              }),
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
              title: t("raid-channel.cleanup.noConfigTitle", lang),
              description: t("raid-channel.cleanup.noConfigDescription", lang),
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
              title: t("raid-channel.cleanup.channelGoneTitle", lang),
              description: t("raid-channel.cleanup.channelGoneDescription", lang, { channelId }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const welcome = await postRaidChannelWelcome(channel, interaction.client.user.id, guildId);
      const newKey = welcome.posted
        ? welcome.pinned
          ? "newPostedPinned"
          : "newPostedNoPin"
        : "newNotPosted";
      const embed = new EmbedBuilder()
        .setColor(welcome.posted && welcome.pinned ? UI.colors.success : UI.colors.progress)
        .setTitle(`${UI.icons.roster} ${t("raid-channel.repin.title", lang)}`)
        .setDescription(`<#${channel.id}>`)
        .addFields(
          {
            name: t("raid-channel.repin.removedField", lang),
            value: `${welcome.removedOldCount}`,
            inline: true,
          },
          {
            name: t("raid-channel.repin.newField", lang),
            value: t(`raid-channel.repin.${newKey}`, lang),
            inline: true,
          },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    if (action === "set-language") {
      const requested = interaction.options.getString("language", false);
      if (!requested) {
        // No language picked = "view current" affordance. Admin can run
        // `/raid-channel config action:set-language` as a read-only probe to
        // see the active broadcast language + how to change it, without
        // needing to remember `action:show`. Resolve current guild language
        // and render a neutral info embed; fall back to the default locale
        // entry if the read fails so admin still gets useful copy.
        let currentEntry = SUPPORTED_LANGUAGES.find((l) => l.code === "vi");
        try {
          const guildLangCode = await getGuildLanguage(guildId, { GuildConfigModel: GuildConfig });
          const found = SUPPORTED_LANGUAGES.find((l) => l.code === guildLangCode);
          if (found) currentEntry = found;
        } catch (err) {
          console.warn("[raid-channel] guild language read failed:", err?.message || err);
        }
        const embed = new EmbedBuilder()
          .setColor(UI.colors.neutral)
          .setTitle(`${UI.icons.info} ${t("raid-channel-language.currentTitle", lang)}`)
          .setDescription(
            t("raid-channel-language.currentDescription", lang, {
              flag: currentEntry.flag,
              label: currentEntry.label,
            })
          );
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }
      // Validate against the first-class locale list. Slash choices already
      // restrict the dropdown but treat free-text as untrusted - normalize
      // and reject anything outside vi/jp/en. We must avoid the
      // setGuildLanguage's silent "fall back to vi" path on invalid input
      // because that would stamp `vi` AND show a success embed for the
      // wrong language.
      const normalizedRequested = String(requested).toLowerCase();
      const langEntry = SUPPORTED_LANGUAGES.find((l) => l.code === normalizedRequested);
      if (!langEntry) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-channel-language.invalidTitle", lang),
              description: t("raid-channel-language.invalidDescription", lang, { lang: requested }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Persist + invalidate cache. Render the success embed in the NEW
      // guild language so admin sees how the broadcasts will read going
      // forward (gives a quick visual sanity check of the chosen voice).
      await setGuildLanguage(guildId, langEntry.code, { GuildConfigModel: GuildConfig });
      const newLang = langEntry.code;
      const embed = new EmbedBuilder()
        .setColor(UI.colors.success)
        .setTitle(`${UI.icons.done} ${t("raid-channel-language.successTitle", newLang)}`)
        .setDescription(
          t("raid-channel-language.successDescription", newLang, {
            flag: langEntry.flag,
            label: langEntry.label,
          })
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "set-bg-channel") {
      const channel = interaction.options.getChannel("channel");
      if (!channel) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-channel.setBgChannel.missingChannelTitle", lang),
              description: t("raid-channel.setBgChannel.missingChannelDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Verify bot can post + attach files in the channel BEFORE persisting,
      // mirroring the `set` (monitor channel) flow · admins shouldn't get a
      // success embed for a channel where /raid-bg set will silently fail
      // because the bot can't actually upload the rehost.
      const botMember = interaction.guild?.members?.me;
      const missing = getMissingBotChannelPermissions(channel, botMember, {
        // bg channel only needs upload + history (no Read MessageContent
        // since we never parse user-typed messages here). Pass an
        // override if the shared helper supports it; otherwise fall back
        // to the default set + filter to ours.
      });
      if (missing.length > 0) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: t("raid-channel.setBgChannel.missingPermsTitle", lang),
              description: t("raid-channel.setBgChannel.missingPermsDescription", lang, {
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
        { guildId, raidBgChannelId: channel.id },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      const embed = new EmbedBuilder()
        .setColor(UI.colors.success)
        .setTitle(`${UI.icons.done} ${t("raid-channel.setBgChannel.successTitle", lang)}`)
        .setDescription(
          t("raid-channel.setBgChannel.successDescription", lang, { channelId: channel.id })
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
                title: t("raid-channel.schedule.noopTitle", lang),
                description: t(
                  enabled
                    ? "raid-channel.schedule.noopDescriptionOn"
                    : "raid-channel.schedule.noopDescriptionOff",
                  lang
                ),
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
              title: t("raid-channel.schedule.noChannelTitle", lang),
              description: t("raid-channel.schedule.noChannelDescription", lang),
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
        .setTitle(
          `${enabled ? UI.icons.done : UI.icons.reset} ${t(
            enabled
              ? "raid-channel.schedule.enabledTitle"
              : "raid-channel.schedule.disabledTitle",
            lang
          )}`
        )
        .setDescription(
          t(
            enabled
              ? "raid-channel.schedule.enabledDescription"
              : "raid-channel.schedule.disabledDescription",
            lang
          )
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
