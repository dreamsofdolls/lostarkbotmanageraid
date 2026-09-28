"use strict";

const {
  buildNoticeEmbed,
  deferEphemeralReply,
  editEmbed,
  editNotice,
  normalizeName,
  replyNotice,
} = require("../../utils/raid/common/shared");
const {
  authorizePickerSession,
  buildTogglePickerComponents,
  clearPickerSession,
  handlePickerSessionTimeout,
  newPickerSessionId,
} = require("../../utils/raid/roster-picker");
const {
  createAutocompleteDispatcher,
  getRosterMatches,
  truncateChoice,
} = require("../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../services/i18n");
const {
  ROSTER_PICKER_ACTION,
  getRosterPickerRoute,
} = require("./picker/picker-routes");
const {
  SESSION_TTL_MS,
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
} = require("./gold-earner/constants");
const {
  pickInitialSelection,
  buildPickerCharacters,
} = require("./gold-earner/selection");
const { findAccountByName } = require("../../utils/user-doc");
const { createGoldEarnerRenderers } = require("./gold-earner/render");
const { countedGoldEarners } = require("../../utils/raid/common/character");

function createRaidGoldEarnerCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  loadUserForAutocomplete,
}) {
  const sessions = new Map();
  const {
    buildSelectionEmbed,
    buildSelectionComponents,
    buildExpiredEmbed,
    buildCancelledEmbed,
    buildSavedEmbed,
  } = createGoldEarnerRenderers({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    t,
    buildTogglePickerComponents,
  });

  function editPickerNotice(interaction, notice, extras = {}) {
    return editNotice(interaction, EmbedBuilder, notice, extras);
  }

  const handleRaidGoldEarnerAutocomplete = createAutocompleteDispatcher("raid-gold-earner", {
    async roster(interaction, focused) {
      const userDoc = await loadUserForAutocomplete(interaction.user.id);
      const choices = getRosterMatches(userDoc, focused.value || "").map((account) => {
        const charCount = Array.isArray(account.characters)
          ? account.characters.length
          : 0;
        const earnerCount = countedGoldEarners(account.characters).size;
        const label = `\uD83D\uDCC1 ${account.accountName} \u00B7 ${earnerCount}/${charCount} earner`;
        return truncateChoice(label, account.accountName);
      });
      await interaction.respond(choices).catch(() => {});
    },
  });

  async function handleRaidGoldEarnerCommand(interaction) {
    const discordId = interaction.user.id;
    const rosterInput = interaction.options.getString("roster", true).trim();
    await deferEphemeralReply(interaction);
    const langPromise = getUserLanguage(discordId, { UserModel: User });

    if (!rosterInput) {
      const lang = await langPromise;
      await editPickerNotice(interaction, {
        type: "warn",
        title: t("raid-gold-earner.notice.missingRosterTitle", lang),
        description: t("raid-gold-earner.notice.missingRosterDescription", lang),
      });
      return;
    }

    const [lang, userDoc] = await Promise.all([
      langPromise,
      User.findOne({ discordId }),
    ]);
    const target = findAccountByName(userDoc, rosterInput, normalizeName);

    if (!target) {
      await editPickerNotice(interaction, {
        type: "warn",
        title: t("raid-gold-earner.notice.notFoundTitle", lang),
        description: t("raid-gold-earner.notice.notFoundDescription", lang, {
          rosterName: rosterInput,
        }),
      });
      return;
    }

    const allChars = Array.isArray(target.characters) ? target.characters : [];
    if (allChars.length === 0) {
      await editPickerNotice(interaction, {
        type: "info",
        title: t("raid-gold-earner.notice.emptyTitle", lang),
        description: t("raid-gold-earner.notice.emptyDescription", lang, {
          accountName: target.accountName,
        }),
      });
      return;
    }

    const { chars: pickerChars, overflowCount } = buildPickerCharacters(allChars);
    const sessionId = newPickerSessionId();
    const session = {
      sessionId,
      callerId: discordId,
      lang,
      accountName: target.accountName,
      chars: pickerChars,
      selectedIndices: pickInitialSelection(pickerChars),
      overflowCount,
      timer: null,
    };
    sessions.set(sessionId, session);

    await editEmbed(interaction, buildSelectionEmbed(session), {
      components: buildSelectionComponents(session),
    });

    session.timer = setTimeout(
      () => handlePickerSessionTimeout({
        sessions,
        sessionId,
        interaction,
        buildExpiredEmbed,
        logTag: "raid-gold-earner",
        timerField: "timer",
      }),
      SESSION_TTL_MS
    );
  }

  async function renderStaleSession(interaction) {
    await interaction.deferUpdate();
    const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await editPickerNotice(interaction, {
      type: "warn",
      title: t("raid-gold-earner.expired.staleSessionTitle", clickerLang),
      description: t("raid-gold-earner.expired.staleSessionDescription", clickerLang),
    }, {
      components: [],
    }).catch(() => {});
  }

  async function enforceSessionOwner(interaction, session) {
    return authorizePickerSession({
      interaction,
      session,
      User,
      getUserLanguage,
      buildNoticeEmbed,
      EmbedBuilder,
      MessageFlags,
      t,
      titleKey: "raid-gold-earner.auth.notYourSessionTitle",
      descriptionKey: "raid-gold-earner.auth.notYourSessionDescription",
    }).catch(() => true);
  }

  async function handleToggleAction(interaction, route, session) {
    const idx = route.index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= session.chars.length) {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (session.selectedIndices.has(idx)) {
      session.selectedIndices.delete(idx);
    } else {
      if (session.selectedIndices.size >= GOLD_EARNER_CAP_PER_ACCOUNT) {
        await replyNotice(interaction, EmbedBuilder, {
          type: "warn",
          title: t("raid-gold-earner.capWarn.title", session.lang, {
            cap: GOLD_EARNER_CAP_PER_ACCOUNT,
          }),
          description: t("raid-gold-earner.capWarn.description", session.lang, {
            cap: GOLD_EARNER_CAP_PER_ACCOUNT,
          }),
        }).catch(() => {});
        return;
      }
      session.selectedIndices.add(idx);
    }

    await interaction.update({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    }).catch(() => {});
  }

  async function persistGoldEarnerSelection(session) {
    const selectedIds = new Set(
      Array.from(session.selectedIndices)
        .map((index) => session.chars[index]?.id)
        .filter(Boolean)
    );
    const pickerCharIds = new Set(session.chars.map((character) => character.id));
    let savedNames = [];
    let rosterMissing = false;

    await saveWithRetry(async () => {
      const doc = await User.findOne({ discordId: session.callerId });
      // The roster can be removed, or renamed by a background refresh, while
      // the picker is open; saving nothing must not read as a success.
      const account = findAccountByName(doc, session.accountName, normalizeName);
      rosterMissing = !account;
      if (!account) return;

      const itemLevelByName = new Map();
      const out = [];
      for (const character of account.characters || []) {
        itemLevelByName.set(character.name, Number(character.itemLevel) || 0);
        if (!pickerCharIds.has(character.id)) continue;
        character.isGoldEarner = selectedIds.has(character.id);
        if (character.isGoldEarner) out.push(character.name);
      }

      out.sort((a, b) => (itemLevelByName.get(b) || 0) - (itemLevelByName.get(a) || 0));
      savedNames = out;
      await doc.save();
    });

    return rosterMissing ? null : savedNames;
  }

  async function handleConfirmAction(interaction, session, sessionId) {
    await interaction.deferUpdate();
    clearPickerSession(sessions, sessionId, { timerField: "timer" });
    let savedNames;
    try {
      savedNames = await persistGoldEarnerSelection(session);
    } catch (err) {
      console.error("[raid-gold-earner confirm] save failed:", err?.message || err);
      await editPickerNotice(interaction, {
        type: "warn",
        title: t("raid-gold-earner.saveFail.title", session.lang),
        description: t("raid-gold-earner.saveFail.description", session.lang),
      }, {
        components: [],
      }).catch(() => {});
      return;
    }
    if (savedNames === null) {
      await editPickerNotice(interaction, {
        type: "warn",
        title: t("raid-gold-earner.notice.notFoundTitle", session.lang),
        description: t("raid-gold-earner.notice.notFoundDescription", session.lang, {
          rosterName: session.accountName,
        }),
      }, {
        components: [],
      }).catch(() => {});
      return;
    }

    await editEmbed(interaction, buildSavedEmbed(session, savedNames), {
      components: [],
    }).catch(() => {});
  }

  async function handleRaidGoldEarnerButton(interaction) {
    const route = getRosterPickerRoute(interaction.customId, { prefix: "gold-earner" });
    const sessionId = route?.sessionId || "";
    const session = sessions.get(sessionId);

    if (!session) {
      await renderStaleSession(interaction);
      return;
    }

    if (await enforceSessionOwner(interaction, session)) {
      return;
    }

    const pickerActionHandlers = {
      [ROSTER_PICKER_ACTION.toggle]: () => handleToggleAction(interaction, route, session),
      [ROSTER_PICKER_ACTION.cancel]: async () => {
        clearPickerSession(sessions, sessionId, { timerField: "timer" });
        await interaction.update({
          embeds: [buildCancelledEmbed(session)],
          components: [],
        }).catch(() => {});
      },
      [ROSTER_PICKER_ACTION.confirm]: () => handleConfirmAction(interaction, session, sessionId),
    };

    const handler = route ? pickerActionHandlers[route.action] : null;
    if (!handler) {
      await interaction.deferUpdate().catch(() => {});
      return;
    }
    await handler();
  }

  return {
    handleRaidGoldEarnerCommand,
    handleRaidGoldEarnerAutocomplete,
    handleRaidGoldEarnerButton,
    __test: {
      sessions,
      pickInitialSelection,
    },
  };
}

module.exports = {
  createRaidGoldEarnerCommand,
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
};
