"use strict";

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require("discord.js");

function createRaidCommandDefinitions({
  RAID_CHOICES,
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

  const raidCheckCommand = new SlashCommandBuilder()
    .setName("raid-check")
    .setDescription("(Raid Leader) Scan all uncompleted eligible characters for a raid")
    .addStringOption((option) => {
      option
        .setName("raid")
        .setDescription("Raid to scan")
        .setRequired(true);

      for (const choice of RAID_CHOICES) {
        option.addChoices(choice);
      }
      return option;
    });

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
        .setDescription("Add a daily or weekly side task to one of your characters")
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
            .setDescription("Character to attach this task to")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Task name (max 60 chars)")
            .setRequired(true)
            .setMaxLength(60)
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
