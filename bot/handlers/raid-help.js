// /raid-help - drill-down help dropdown.
//
// Architecture: this file holds only language-neutral metadata - section
// order, icons, option key+required structure. All user-facing strings
// (labels, shorts, notes, option descriptions) live in bot/locales/<lang>.js
// under the `raid-help` namespace. raid-help.js reads them via the i18n
// service so adding a new language doesn't require touching this handler.
//
// Three locales available here:
//   - vi (default)      - first-class, exposed via /raid-language
//   - jp                - first-class, exposed via /raid-language
//   - en                - partial, exposed only via the slash option
//                         `/raid-help language:en` as a one-off override
//
// Language resolution at command time:
//   1. explicit `language:` slash option (per-call override) wins
//   2. otherwise, the viewer's persistent /raid-language preference
//   3. otherwise, "vi"
const User = require("../models/user");
const { t, getUserLanguage, resolveLocale } = require("../services/i18n");

// Section order is the only place command listing order is configured -
// drives both the overview embed and the dropdown options.
const SECTION_ORDER = [
  "getting-started",
  "raid-add-roster",
  "raid-edit-roster",
  "raid-status",
  "raid-gold-earner",
  "raid-task",
  "raid-set",
  "raid-check",
  "raid-remove-roster",
  "raid-channel",
  "raid-auto-manage",
  "raid-announce",
  "raid-language",
];

// Per-section language-neutral metadata. Anything translatable lives in
// the locale packs under `raid-help.sections.<key>.*`. Adding an option
// here means also adding its description under
// `raid-help.sections.<key>.optionDescriptions.<name>` in every locale.
const SECTION_META = {
  "getting-started": { icon: "🚀", options: [] },
  "raid-add-roster": {
    icon: "📥",
    options: [
      { name: "name", required: true },
      { name: "target", required: false },
    ],
  },
  "raid-edit-roster": {
    icon: "📁",
    options: [{ name: "roster", required: true }],
  },
  "raid-status": { icon: "📊", options: [] },
  "raid-gold-earner": {
    icon: "💰",
    options: [{ name: "roster", required: true }],
  },
  "raid-task": {
    icon: "📝",
    options: [
      { name: "subcommand", required: true },
      { name: "action", required: false },
      { name: "roster", required: true },
      { name: "character", required: false },
      { name: "name", required: false },
      { name: "reset", required: false },
      { name: "preset", required: false },
      { name: "expires_at", required: false },
      { name: "all_rosters", required: false },
      { name: "task", required: false },
    ],
  },
  "raid-set": {
    icon: "✏️",
    options: [
      { name: "roster", required: true },
      { name: "character", required: true },
      { name: "raid", required: true },
      { name: "status", required: true },
      { name: "gate", required: false },
    ],
  },
  "raid-check": { icon: "🔍", options: [] },
  "raid-remove-roster": {
    icon: "🗑️",
    options: [
      { name: "roster", required: true },
      { name: "action", required: true },
      { name: "character", required: false },
    ],
  },
  "raid-channel": {
    icon: "📢",
    options: [
      { name: "config action:<x>", required: true },
      { name: "channel", required: false },
    ],
  },
  "raid-auto-manage": {
    icon: "🤖",
    options: [
      { name: "action:on", required: false },
      { name: "action:off", required: false },
      { name: "action:sync", required: false },
      { name: "action:status", required: false },
    ],
  },
  "raid-announce": {
    icon: "📣",
    options: [
      { name: "type", required: true },
      { name: "action", required: true },
      { name: "channel", required: false },
    ],
  },
  "raid-language": { icon: "🌐", options: [] },
};

function createRaidHelpCommand(deps) {
  const {
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    MessageFlags,
    UI,
    // Optional DI for tests: skip the Mongo round-trip in
    // getUserLanguage by passing a stub `(discordId) => "vi"`. Production
    // callers omit this and the default reaches into i18n + User model.
    resolveStoredLanguage = (discordId) =>
      getUserLanguage(discordId, { UserModel: User }),
  } = deps;

  // Vars passed into t() for sections whose notes reference UI tokens
  // (raid-status's icon legend, etc). Centralised so locale files use
  // {iconDone} / {iconPartial} / {iconPending} / {iconLock} placeholders
  // instead of hard-coding emoji that would drift if UI.icons changed.
  const ICON_VARS = {
    iconDone: UI.icons.done,
    iconPartial: UI.icons.partial,
    iconPending: UI.icons.pending,
    iconLock: UI.icons.lock,
  };

  function sectionLabel(key, lang) {
    return t(`raid-help.sections.${key}.label`, lang);
  }
  function sectionShort(key, lang) {
    return t(`raid-help.sections.${key}.short`, lang);
  }
  function sectionExample(key, lang) {
    return t(`raid-help.sections.${key}.example`, lang);
  }
  function sectionNotes(key, lang) {
    const value = t(`raid-help.sections.${key}.notes`, lang, ICON_VARS);
    return Array.isArray(value) ? value : [];
  }
  function optionDescription(key, optName, lang) {
    return t(
      `raid-help.sections.${key}.optionDescriptions.${optName}`,
      lang,
    );
  }

  function buildHelpOverviewEmbed(lang) {
    const titleSuffix = t("raid-help.overview.titleSuffix", lang);
    const desc = t("raid-help.overview.description", lang);
    const footer = t("raid-help.overview.footer", lang);
    const embed = new EmbedBuilder()
      .setTitle(`🎯 Raid Management Bot - Help (${titleSuffix})`)
      .setDescription(desc)
      .setColor(UI.colors.neutral)
      .setFooter({ text: footer })
      .setTimestamp();
    for (const key of SECTION_ORDER) {
      const meta = SECTION_META[key];
      embed.addFields({
        name: `${meta.icon} ${sectionLabel(key, lang)}`,
        value: sectionShort(key, lang),
        inline: false,
      });
    }
    return embed;
  }

  const HELP_FIELD_VALUE_LIMIT = 1024; // Discord rejects embed field values above this.
  function splitHelpFieldValue(value, limit = HELP_FIELD_VALUE_LIMIT) {
    const chunks = [];
    let current = "";
    for (const rawLine of String(value || "").split("\n")) {
      const lineParts = [];
      let remaining = rawLine;
      while (remaining.length > limit) {
        let cutAt = remaining.lastIndexOf(" ", limit);
        if (cutAt < Math.floor(limit * 0.6)) cutAt = limit;
        lineParts.push(remaining.slice(0, cutAt).trimEnd());
        remaining = remaining.slice(cutAt).trimStart();
      }
      lineParts.push(remaining);
      for (const part of lineParts) {
        const next = current ? `${current}\n${part}` : part;
        if (next.length > limit && current) {
          chunks.push(current);
          current = part;
        } else {
          current = next;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : ["_No details_"];
  }
  function addChunkedHelpField(embed, name, value) {
    const chunks = splitHelpFieldValue(value);
    chunks.forEach((chunk, index) => {
      embed.addFields({
        name: index === 0 ? name : `${name} (${index + 1})`,
        value: chunk,
        inline: false,
      });
    });
  }

  function buildHelpDetailEmbed(sectionKey, lang) {
    const meta = SECTION_META[sectionKey];
    if (!meta) return buildHelpOverviewEmbed(lang);
    const noOptionsLabel = t("raid-help.noOptions", lang);
    const embed = new EmbedBuilder()
      .setTitle(`${meta.icon} ${sectionLabel(sectionKey, lang)}`)
      .setDescription(sectionShort(sectionKey, lang))
      .setColor(UI.colors.neutral);
    if (meta.options.length > 0) {
      const optionLines = meta.options.map((opt) => {
        const req = opt.required ? "✅" : "⚪";
        const desc = optionDescription(sectionKey, opt.name, lang);
        return `${req} \`${opt.name}\` - ${desc}`;
      });
      addChunkedHelpField(embed, "Options", optionLines.join("\n"));
    } else {
      embed.addFields({ name: "Options", value: noOptionsLabel, inline: false });
    }
    embed.addFields({
      name: "Example",
      value: `\`${sectionExample(sectionKey, lang)}\``,
      inline: false,
    });
    addChunkedHelpField(embed, "Notes", sectionNotes(sectionKey, lang).join("\n"));
    return embed;
  }

  function buildHelpDropdown(lang) {
    const placeholder = t("raid-help.placeholder", lang);
    // Lang baked into the customId so dropdown selections after a
    // language switch render the detail in the user's chosen language
    // without re-running the slash command. selectRoutes prefix-match
    // in bot.js dispatches `raid-help:select:<lang>` to the same
    // handler.
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`raid-help:select:${lang}`)
      .setPlaceholder(placeholder)
      .addOptions(
        SECTION_ORDER.map((key) => ({
          label: sectionLabel(key, lang),
          value: key,
          description: sectionShort(key, lang).slice(0, 100),
          emoji: SECTION_META[key].icon,
        })),
      );
    return new ActionRowBuilder().addComponents(menu);
  }

  async function resolveHelpLanguage(interaction) {
    // Slash option wins as a per-call override; otherwise fall back to
    // the viewer's persistent /raid-language preference. resolveLocale
    // (not normalizeLanguage) so an `en` override is honored even
    // though it isn't in the /raid-language picker.
    const explicit = interaction.options.getString("language");
    if (explicit) return resolveLocale(explicit);
    const stored = await resolveStoredLanguage(interaction.user.id);
    return resolveLocale(stored);
  }

  async function handleRaidHelpCommand(interaction) {
    const lang = await resolveHelpLanguage(interaction);
    await interaction.reply({
      embeds: [buildHelpOverviewEmbed(lang)],
      components: [buildHelpDropdown(lang)],
      flags: MessageFlags.Ephemeral,
    });
  }
  async function handleRaidHelpSelect(interaction) {
    // CustomId shape: `raid-help:select:<lang>` - lang baked in by the
    // dropdown builder so the detail embed stays monolingual.
    const lang = resolveLocale(interaction.customId.split(":")[2]);
    const sectionKey = interaction.values?.[0];
    await interaction.update({
      embeds: [buildHelpDetailEmbed(sectionKey, lang)],
      components: [buildHelpDropdown(lang)],
    });
  }
  return {
    handleRaidHelpCommand,
    handleRaidHelpSelect,
  };
}

module.exports = {
  createRaidHelpCommand,
  // Exported for tests that want to assert on the section roster
  // without duplicating it.
  SECTION_ORDER,
  SECTION_META,
};
