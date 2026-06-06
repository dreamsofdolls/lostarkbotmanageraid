"use strict";

const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const {
  handlePickerSessionTimeout,
  newPickerSessionId,
  resolveAdminMention,
} = require("../../utils/raid/roster-picker");
const {
  buildRosterAutocompleteChoices,
  getRosterMatches,
  truncateChoice,
} = require("../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  guardPickerConfirm,
  handleRosterPickerCancel,
  handleRosterPickerToggle,
  loadRosterPickerButtonContext,
} = require("./picker/button-flow");
const {
  preserveRosterCharacterState,
} = require("./picker/character-state");
const {
  buildEditRosterPickerChars: buildEditRosterPickerCharsCore,
} = require("./edit/edit-picker-chars");
const {
  createFetchBibleRosterWithFallback,
} = require("./edit/edit-bible-fetch");
const {
  createPersistEditedRoster,
} = require("./edit/edit-persistence");
const {
  createEditRosterRenderers,
} = require("./edit/edit-render");

const SESSION_TTL_MS = 5 * 60 * 1000;
const PICKER_MAX_OPTIONS = 20;
const BUTTONS_PER_ROW = 5;

function createEditRosterCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  ensureFreshWeek,
  MAX_CHARACTERS_PER_ACCOUNT,
  fetchRosterCharacters,
  parseCombatScore,
  normalizeName,
  getCharacterName,
  getCharacterClass,
  buildCharacterRecord,
  createCharacterId,
  loadUserForAutocomplete,
  getPrimaryManagerId,
}) {
  const adminMention = resolveAdminMention(getPrimaryManagerId);
  const sessions = new Map();
  const {
    buildSelectionEmbed,
    buildSelectionComponents,
    buildExpiredEmbed,
    buildCancelledEmbed,
    buildSavedEmbed,
  } = createEditRosterRenderers({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    pickerMaxOptions: PICKER_MAX_OPTIONS,
    buttonsPerRow: BUTTONS_PER_ROW,
  });

  const buildEditRosterPickerChars = (savedChars, bibleChars, cap) =>
    buildEditRosterPickerCharsCore({
      savedChars,
      bibleChars,
      cap,
      normalizeName,
      parseCombatScore,
    });
  const fetchBibleRosterWithFallback = createFetchBibleRosterWithFallback({
    fetchRosterCharacters,
    normalizeName,
    parseCombatScore,
  });
  const persistEditedRoster = createPersistEditedRoster({
    User,
    buildCharacterRecord,
    createCharacterId,
    ensureFreshWeek,
    getCharacterClass,
    getCharacterName,
    normalizeName,
    preserveRosterCharacterState,
    saveWithRetry,
  });

  async function handleEditRosterAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "roster") {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const charsWord = (count) =>
      t(
        count === 1
          ? "raid-edit-roster.autocomplete.charsSingular"
          : "raid-edit-roster.autocomplete.charsPlural",
        lang,
      );
    const choices = buildRosterAutocompleteChoices(matches, {
      lang,
      t,
      choiceKey: "raid-edit-roster.autocomplete.choice",
      charsWord,
    });

    await interaction.respond(choices).catch(() => {});
  }

  async function handleEditRosterCommand(interaction) {
    const callerId = interaction.user.id;
    const lang = await getUserLanguage(callerId, { UserModel: User });
    const rosterArg = interaction.options.getString("roster", true).trim();

    const userDoc = await User.findOne({ discordId: callerId }).lean();
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: t("raid-edit-roster.notice.noRostersTitle", lang),
            description: t("raid-edit-roster.notice.noRostersDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetAccount = userDoc.accounts.find(
      (account) => normalizeName(account.accountName) === normalizeName(rosterArg)
    );
    if (!targetAccount) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-edit-roster.notice.notFoundTitle", lang),
            description: t("raid-edit-roster.notice.notFoundDescription", lang, {
              rosterName: rosterArg,
            }),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const savedChars = (targetAccount.characters || []).map((character) => ({
      name: getCharacterName(character),
      class: getCharacterClass(character),
      itemLevel: Number(character.itemLevel) || 0,
      combatScore: character.combatScore || "",
    }));
    const { bibleChars, bibleError } = await fetchBibleRosterWithFallback(
      savedChars,
      targetAccount.accountName
    );
    const {
      merged,
      displayChars,
      excludedBibleOnlyCount,
      excludedSavedCount,
      excludedSavedKeys,
    } = buildEditRosterPickerChars(savedChars, bibleChars, PICKER_MAX_OPTIONS);

    if (merged.length === 0) {
      await interaction.editReply({
        content: null,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-edit-roster.notice.emptyMergedTitle", lang),
            description: t("raid-edit-roster.notice.emptyMergedDescription", lang, {
              accountName: targetAccount.accountName,
            }),
          }),
        ],
      });
      return;
    }

    if (excludedBibleOnlyCount > 0 || excludedSavedCount > 0) {
      console.warn(
        `[edit-roster] roster ${targetAccount.accountName} merged ${merged.length} chars; excluded from picker (cap ${PICKER_MAX_OPTIONS}): ${excludedSavedCount} saved + ${excludedBibleOnlyCount} bible-only.`
      );
    }

    const selectedIndices = new Set();
    displayChars.forEach((character, index) => {
      if (character.savedKey) selectedIndices.add(index);
    });

    const sessionId = newPickerSessionId();
    const session = {
      sessionId,
      callerId,
      lang,
      discordId: callerId,
      accountName: targetAccount.accountName,
      bibleError,
      excludedBibleOnlyCount,
      excludedSavedCount,
      preservedSavedKeys: excludedSavedKeys,
      chars: displayChars.map((character) => ({
        charName: character.charName,
        className: character.className,
        itemLevel: character.itemLevel,
        combatScore: character.combatScore,
        savedKey: character.savedKey,
        inBible: character.inBible,
      })),
      selectedIndices,
      expireTimer: null,
    };
    sessions.set(sessionId, session);

    await interaction.editReply({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    });

    session.expireTimer = setTimeout(
      () => handlePickerSessionTimeout({
        sessions,
        sessionId,
        interaction,
        buildExpiredEmbed,
        logTag: "edit-roster",
      }),
      SESSION_TTL_MS
    );
  }

  async function handleEditRosterButton(interaction) {
    const context = await loadRosterPickerButtonContext({
      interaction,
      prefix: "edit-roster",
      sessions,
      User,
      getUserLanguage,
      buildNoticeEmbed,
      EmbedBuilder,
      MessageFlags,
      t,
      staleTitleKey: "raid-edit-roster.expired.staleSessionTitle",
      staleDescriptionKey: "raid-edit-roster.expired.staleSessionDescription",
      authTitleKey: "raid-edit-roster.auth.notYourPickerTitle",
      authDescriptionKey: "raid-edit-roster.auth.notYourPickerDescription",
    });
    if (context.handled) return;

    const { action, route, sessionId, session } = context;
    if (action === "toggle") {
      await handleRosterPickerToggle({
        interaction,
        session,
        charIndex: route?.index,
        buildSelectionEmbed,
        buildSelectionComponents,
      });
      return;
    }

    if (action === "cancel") {
      await handleRosterPickerCancel({
        interaction,
        sessions,
        sessionId,
        session,
        buildCancelledEmbed,
      });
      return;
    }

    if (action !== "confirm") return;

    const guard = await guardPickerConfirm({
      interaction,
      session,
      sessions,
      sessionId,
      EmbedBuilder,
      MessageFlags,
      t,
      buildNoticeEmbed,
      maxChars: MAX_CHARACTERS_PER_ACCOUNT,
      keyPrefix: "raid-edit-roster",
      noSelectionVars: { accountName: session.accountName },
    });
    if (guard.handled) return;
    const selectedChars = guard.selectedChars;

    let summary;
    try {
      summary = await persistEditedRoster(session, selectedChars);
    } catch (err) {
      console.error("[edit-roster] persist failed:", err);
      await interaction.editReply({
        content: null,
        components: [],
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "error",
            title: t("raid-edit-roster.persistFail.title", session.lang),
            description: t("raid-edit-roster.persistFail.description", session.lang, {
              error: err?.message || err,
              adminMention,
            }),
          }),
        ],
      });
      return;
    }

    await interaction.editReply({
      embeds: [buildSavedEmbed(session, summary)],
      components: [],
      allowedMentions: { parse: [] },
    });
  }

  return {
    handleEditRosterAutocomplete,
    handleEditRosterCommand,
    handleEditRosterButton,
    __test: {
      persistEditedRoster,
      fetchBibleRosterWithFallback,
      buildEditRosterPickerChars,
      sessions,
    },
  };
}

module.exports = {
  createEditRosterCommand,
};
