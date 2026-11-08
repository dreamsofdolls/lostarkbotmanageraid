"use strict";

const {
  NoticeKind,
  buildDetailField,
  buildKeyedNotice,
  buildNoRosterNotice,
  buildNoticeEmbed,
} = require("../../utils/raid/common/shared");
const { findAccountByName } = require("../../utils/user-doc");
const {
  handlePickerSessionTimeout,
  newPickerSessionId,
  resolveAdminMention,
} = require("../../utils/raid/roster-picker");
const {
  buildRosterAutocompleteChoices,
  createAutocompleteDispatcher,
  getRosterMatches,
} = require("../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  guardPickerConfirm,
  handleRosterPickerNavigationAction,
  loadRosterPickerButtonContext,
} = require("./picker/button-flow");
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
  sessionTitleVars,
} = require("./edit/edit-render");
const { ROSTER_ICON_UNKNOWN } = require("./picker/render");
const {
  SESSION_TTL_MS,
  PICKER_MAX_OPTIONS,
} = require("./picker/constants");

// A roster the user does not have, or one with no characters left, has no
// class to show, so its notices carry the unknown icon.
function unknownRosterVars(rosterName) {
  return { rosterIcon: ROSTER_ICON_UNKNOWN, rosterName };
}

// A C+ roster notice whose copy lives at `raid-edit-roster.notice.<stem>{Title,Description,Tip}`.
function rosterNotice(kind, stem, rosterName, lang) {
  return buildKeyedNotice({ kind, keyBase: `raid-edit-roster.notice.${stem}`, lang, vars: unknownRosterVars(rosterName) });
}

function createEditRosterCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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
    StringSelectMenuBuilder,
    UI,
    pickerMaxOptions: PICKER_MAX_OPTIONS,
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
    saveWithRetry,
  });

  const handleEditRosterAutocomplete = createAutocompleteDispatcher("edit-roster", {
    async roster(interaction, focused) {
      const userDoc = await loadUserForAutocomplete(interaction.user.id);
      const lang = await getUserLanguage(interaction.user.id, {
        UserModel: User,
        userDoc,
      });
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
    },
  });

  async function handleEditRosterCommand(interaction) {
    const callerId = interaction.user.id;
    const rosterArg = interaction.options.getString("roster", true).trim();

    // Every edit-roster result is private, so acknowledge before Mongo and
    // reuse that same user document for both locale and roster state.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userDoc = await User.findOne({ discordId: callerId }).lean();
    const lang = await getUserLanguage(callerId, {
      UserModel: User,
      userDoc,
    });
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await interaction.editReply({
        embeds: [buildNoticeEmbed(EmbedBuilder, buildNoRosterNotice(lang))],
      });
      return;
    }

    const targetAccount = findAccountByName(userDoc, rosterArg, normalizeName);
    if (!targetAccount) {
      await interaction.editReply({
        embeds: [buildNoticeEmbed(EmbedBuilder, rosterNotice(NoticeKind.EMPTY, "notFound", rosterArg, lang))],
      });
      return;
    }

    const savedChars = (targetAccount.characters || []).map((character) => ({
      name: getCharacterName(character),
      class: getCharacterClass(character),
      itemLevel: Number(character.itemLevel) || 0,
      combatScore: character.combatScore || "",
      // Pairs a character renamed in game with its new name on Bible.
      bibleCid: character.bibleCid || null,
    }));
    const { bibleChars, bibleError } = await fetchBibleRosterWithFallback(
      savedChars,
      targetAccount.accountName,
      lang
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
          buildNoticeEmbed(EmbedBuilder, rosterNotice(NoticeKind.EMPTY, "emptyMerged", targetAccount.accountName, lang)),
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
      // Classes of the saved characters beyond the cap, which Save keeps:
      // the card's 🛡️/⚔️ split counts them.
      preservedSavedClasses: savedChars
        .filter((character) => excludedSavedKeys.has(normalizeName(character.name)))
        .map((character) => character.class),
      chars: displayChars.map((character) => ({
        charName: character.charName,
        className: character.className,
        itemLevel: character.itemLevel,
        combatScore: character.combatScore,
        savedKey: character.savedKey,
        inBible: character.inBible,
        renamedFrom: character.renamedFrom,
      })),
      selectedIndices,
      expiresAt: Date.now() + SESSION_TTL_MS,
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
      staleTipKey: "raid-edit-roster.expired.staleSessionTip",
      authTitleKey: "raid-edit-roster.auth.notYourPickerTitle",
      authDescriptionKey: "raid-edit-roster.auth.notYourPickerDescription",
      authTipKey: "raid-edit-roster.auth.notYourPickerTip",
    });
    if (context.handled) return;

    const navigationHandled = await handleRosterPickerNavigationAction({
      interaction,
      context,
      sessions,
      buildSelectionEmbed,
      buildSelectionComponents,
      buildCancelledEmbed,
    });
    if (navigationHandled) return;

    const { action, sessionId, session } = context;

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
      // A roster removed or renamed while the picker was open is not a save
      // failure: the card itself went stale.
      const notice = err?.code === "ROSTER_NOT_FOUND"
        ? rosterNotice(NoticeKind.EXPIRED, "gone", session.accountName, session.lang)
        : {
          kind: NoticeKind.FAILURE,
          title: t("raid-edit-roster.persistFail.title", session.lang, sessionTitleVars(session)),
          description: t("raid-edit-roster.persistFail.description", session.lang, { adminMention }),
          fields: [buildDetailField(err?.message || String(err), session.lang)],
          tip: t("raid-edit-roster.persistFail.tip", session.lang),
        };
      await interaction.editReply({
        content: null,
        components: [],
        embeds: [buildNoticeEmbed(EmbedBuilder, notice)],
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
