"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidCommandDefinitions({
  announcementTypeKeys,
  announcementTypeEntry,
}) {
  const addRosterCommand = new SlashCommandBuilder()
    .setName("add-roster")
    .setDescription("Sync a roster from lostark.bible")
    .addStringOption((option) =>
      option
        .setName("name")
        .setDescription("Any character name in the roster")
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName("target")
        .setDescription("(Raid Manager only) Add roster on behalf of another user")
        .setRequired(false)
    );

  // /raid-check has no command-line options. Cross-raid overview is the
  // sole entry point; per-raid focus is achieved via the inline raid-
  // filter dropdown inside the embed. The previous `raid` option (with
  // its 7+1 choice list) was retired in round-32 because the inline
  // filter offered the same UX without doubling the command surface.
  const raidCheckCommand = new SlashCommandBuilder()
    .setName("raid-check")
    .setDescription("(Raid Leader) Cross-raid overview of guild progress");

  const raidSetCommand = new SlashCommandBuilder()
    .setName("raid-set")
    .setDescription("Mark raid progress for a character")
    .addStringOption((option) =>
      option
        .setName("roster")
        .setDescription("Roster (account) chứa character - autocomplete")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("character")
        .setDescription("Character to update")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("raid")
        .setDescription("Raid to update for this character")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("status")
        .setDescription("complete | process | reset (process marks one gate)")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("gate")
        .setDescription("Specific gate (required when status=process)")
        .setRequired(false)
        .setAutocomplete(true)
    );

  const statusCommand = new SlashCommandBuilder()
    .setName("raid-status")
    .setDescription("View your raid progress");

  const raidHelpCommand = new SlashCommandBuilder()
    .setName("raid-help")
    .setDescription("Show help for all raid commands")
    .addStringOption((option) =>
      option
        .setName("language")
        .setDescription("Display language (default: Tiếng Việt)")
        .setRequired(false)
        .addChoices(
          { name: "Tiếng Việt", value: "vi" },
          { name: "English", value: "en" }
        )
    );

  const editRosterCommand = new SlashCommandBuilder()
    .setName("edit-roster")
    .setDescription("Edit an existing roster: add chars from bible or remove saved chars")
    .addStringOption((option) =>
      option
        .setName("roster")
        .setDescription("Which saved roster to edit (autocomplete)")
        .setRequired(true)
        .setAutocomplete(true)
    );

  const removeRosterCommand = new SlashCommandBuilder()
    .setName("remove-roster")
    .setDescription("Remove a roster or a character")
    .addStringOption((option) =>
      option
        .setName("roster")
        .setDescription("Roster to target")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("What to remove")
        .setRequired(true)
        .addChoices(
          { name: "Remove entire roster", value: "remove_roster" },
          { name: "Remove a single character", value: "remove_char" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("character")
        .setDescription("Character to remove (if removing one char)")
        .setRequired(false)
        .setAutocomplete(true)
    );

  const raidChannelCommand = new SlashCommandBuilder()
    .setName("raid-channel")
    .setDescription("Configure the raid monitor channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("Config action to run")
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("Which action to run")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Target text channel (for action=set)")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText)
        )
    );

  const raidAutoManageCommand = new SlashCommandBuilder()
    .setName("raid-auto-manage")
    .setDescription("Auto-sync raid progress from lostark.bible")
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("on · off · sync · status")
        .setRequired(true)
        // Autocomplete (not static choices) so we can hide `on` while already
        // enabled and hide `off` while already disabled - the redundant action
        // in each state shouldn't even appear in the dropdown.
        .setAutocomplete(true)
    );


  const raidAnnounceCommand = new SlashCommandBuilder()
    .setName("raid-announce")
    .setDescription("[Admin] Configure Artist's channel announcements")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((opt) =>
      opt
        .setName("type")
        .setDescription("Announcement type")
        .setRequired(true)
        .addChoices(
          // Display the clean English label only - key is the `value` under
          // the hood so user-facing text isn't a dash soup (key-slug + dash
          // separator + label). Derived from ANNOUNCEMENT_REGISTRY.
          ...announcementTypeKeys().map((key) => ({
            name: announcementTypeEntry(key).label,
            value: key,
          }))
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("What to do with the selected announcement")
        .setRequired(true)
        // Autocomplete (not static choices) so labels can annotate the
        // CURRENT per-guild state (e.g. "Turn on (currently OFF)") and hide
        // redundant actions (on while on, off while off, clear-channel when
        // no override set, set-channel for channel-bound types).
        .setAutocomplete(true)
    )
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Destination channel (required when action = Set channel override)")
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText)
    );

  const raidTaskCommand = new SlashCommandBuilder()
    .setName("raid-task")
    .setDescription("Track daily/weekly side tasks per character (cap 3 daily + 5 weekly)")
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a daily or weekly side task (single char or every char in a roster)")
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("single = một char cụ thể · all = mọi char trong roster")
            .setRequired(true)
            .addChoices(
              { name: "Single character", value: "single" },
              { name: "All characters in roster", value: "all" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) chứa character - autocomplete")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Task name (autocomplete from your past tasks, max 60 chars)")
            .setRequired(true)
            .setMaxLength(60)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("reset")
            .setDescription("How often this task resets")
            .setRequired(true)
            .addChoices(
              { name: "Daily (17:00 VN)", value: "daily" },
              { name: "Weekly (17:00 VN Wed)", value: "weekly" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("character")
            .setDescription("(action=single only) Character to attach this task to - autocomplete by roster")
            .setRequired(false)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove one side task from a character")
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) chứa character - autocomplete")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("character")
            .setDescription("Character to remove a task from")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("task")
            .setDescription("Task to remove (autocomplete by character)")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Remove ALL side tasks from one character (confirm required)")
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) chứa character - autocomplete")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("character")
            .setDescription("Character to clear")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("shared-add")
        .setDescription("Add a roster-level shared task (event shop, Chaos Gate, Field Boss)")
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) to attach the shared task to")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("preset")
            .setDescription("Shared task preset")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Optional display name (default comes from preset, max 60 chars)")
            .setRequired(false)
            .setMaxLength(60)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("reset")
            .setDescription("Manual shared task reset cycle (ignored by scheduled presets)")
            .setRequired(false)
            .addChoices(
              { name: "Daily (17:00 VN)", value: "daily" },
              { name: "Weekly (17:00 VN Wed)", value: "weekly" }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName("expires_at")
            .setDescription("Optional expiry date for event shops, format YYYY-MM-DD")
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("all_rosters")
            .setDescription("Apply this shared task to all of your saved rosters")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("shared-remove")
        .setDescription("Remove one roster-level shared task")
        .addStringOption((opt) =>
          opt
            .setName("roster")
            .setDescription("Roster (account) containing the shared task")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("task")
            .setDescription("Shared task to remove")
            .setRequired(true)
            .setAutocomplete(true)
        )
    );

  const commands = [
    addRosterCommand,
    editRosterCommand,
    raidCheckCommand,
    raidSetCommand,
    statusCommand,
    raidHelpCommand,
    removeRosterCommand,
    raidChannelCommand,
    raidAutoManageCommand,
    raidAnnounceCommand,
    raidTaskCommand,
  ];

  return commands;
}

module.exports = {
  createRaidCommandDefinitions,
};
