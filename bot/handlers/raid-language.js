// /raid-language - per-user locale switcher.
//
// Two-step ephemeral flow:
//   1. Slash command renders an embed showing the user's current locale
//      + a select dropdown listing every SUPPORTED_LANGUAGES entry.
//   2. Selection (customId `raid-language:select`) persists the new
//      code to the User doc, invalidates the in-process cache, and
//      replies with confirmation in the NEW language so the user
//      visually confirms the switch took effect.
//
// All replies are ephemeral - the language picker is purely personal
// state, no value to the rest of the channel.
"use strict";

const User = require("../models/user");
const {
  t,
  getUserLanguage,
  setUserLanguage,
  getSupportedLanguages,
} = require("../services/i18n");

const SELECT_CUSTOM_ID = "raid-language:select";

function buildLanguageEmbed({ EmbedBuilder, UI, lang }) {
  const supported = getSupportedLanguages();
  const current = supported.find((l) => l.code === lang) || supported[0];
  return new EmbedBuilder()
    .setColor(UI.colors.neutral)
    .setTitle(t("raid-language.title", lang))
    .setDescription(
      `${t("raid-language.description", lang)}\n\n` +
        t("raid-language.currentLine", lang, {
          flag: current.flag,
          label: current.label,
        }),
    )
    .setFooter({ text: t("raid-language.footer", lang) });
}

function buildLanguageDropdown({ StringSelectMenuBuilder, ActionRowBuilder, lang }) {
  const supported = getSupportedLanguages();
  // Each option's label lives at `raid-language.options.<code>` in the
  // viewer's CURRENT-language pack so the picker reads in their native
  // tongue (e.g. JP user sees "Tiếng Việt (デフォルト)" / "English
  // (国際向け)" — option labels narrate what picking that code DOES,
  // from the current viewer's perspective). The flag emoji rides the
  // structured `emoji` field; locale strings stay flag-free so a
  // future entry only needs the descriptor text.
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_CUSTOM_ID)
    .setPlaceholder(t("raid-language.placeholder", lang))
    .addOptions(
      supported.map((entry) => ({
        label: t(`raid-language.options.${entry.code}`, lang),
        value: entry.code,
        emoji: entry.flag,
        default: entry.code === lang,
      })),
    );
  return new ActionRowBuilder().addComponents(menu);
}

function createRaidLanguageCommand(deps) {
  const {
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    MessageFlags,
    UI,
  } = deps;

  async function handleRaidLanguageCommand(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await interaction.reply({
      embeds: [buildLanguageEmbed({ EmbedBuilder, UI, lang })],
      components: [buildLanguageDropdown({ StringSelectMenuBuilder, ActionRowBuilder, lang })],
      flags: MessageFlags.Ephemeral,
    });
  }

  async function handleRaidLanguageSelect(interaction) {
    const requested = interaction.values?.[0];
    const previous = await getUserLanguage(interaction.user.id, { UserModel: User });
    const next = await setUserLanguage(interaction.user.id, requested, {
      UserModel: User,
    });

    const supported = getSupportedLanguages();
    const target = supported.find((l) => l.code === next) || supported[0];
    const unchanged = next === previous;

    const embed = new EmbedBuilder()
      .setColor(unchanged ? UI.colors.neutral : UI.colors.success)
      .setTitle(
        t(
          unchanged ? "raid-language.unchangedTitle" : "raid-language.successTitle",
          next,
        ),
      )
      .setDescription(
        t(
          unchanged ? "raid-language.unchangedDescription" : "raid-language.successDescription",
          next,
          { flag: target.flag, label: target.label },
        ),
      )
      .setFooter({ text: t("raid-language.footer", next) });

    // Refresh the dropdown so the new selection persists as the
    // `default: true` option if the user re-opens it without rerunning
    // the slash command.
    await interaction.update({
      embeds: [embed],
      components: [buildLanguageDropdown({ StringSelectMenuBuilder, ActionRowBuilder, lang: next })],
    });
  }

  return {
    handleRaidLanguageCommand,
    handleRaidLanguageSelect,
    SELECT_CUSTOM_ID,
  };
}

module.exports = {
  createRaidLanguageCommand,
  RAID_LANGUAGE_SELECT_CUSTOM_ID: SELECT_CUSTOM_ID,
};
