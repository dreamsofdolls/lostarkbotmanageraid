const {
  NoticeKind,
  buildNoRosterNotice,
  buildRosterNotFoundNotice,
  deferEphemeralReply,
  editNotice,
  formatCharacterLabel,
} = require("../../utils/raid/common/shared");
const {
  createAutocompleteDispatcher,
  buildCharacterAutocompleteChoices,
  buildRosterAutocompleteChoices,
  getRosterMatches,
  getCharacterMatches,
} = require("../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../services/i18n");
const { buildKeyedNotice, formatGold } = require("../../utils/raid/common/shared");
const {
  getStatusRaidsForCharacter,
  summarizeAccountGold,
} = require("../../utils/raid/common/character");
const { hasRosterAccounts } = require("../../utils/user-doc");

/** Names beyond this are collapsed into a trailing `+N`. */
const REMAINING_NAME_LIMIT = 8;

/**
 * Compose the roster-removal autocomplete and command handlers.
 * @param {object} deps - injected Discord, persistence, roster, and UI helpers
 * @returns {{
 *   handleRemoveRosterAutocomplete: Function,
 *   handleRemoveRosterCommand: Function,
 * }} command handlers
 */
function createRemoveRosterCommand(deps) {
  const {
    EmbedBuilder,
    User,
    saveWithRetry,
    normalizeName,
    getCharacterName,
    loadUserForAutocomplete,
  } = deps;

  // One character as notices show it: class icon, then the bold name.
  function withClassIcon(character) {
    return formatCharacterLabel(getCharacterName(character), character?.class || character?.className);
  }

  // A notice whose copy lives at `raid-remove-roster.<stem>{Title,Description,Tip}`.
  function removeNotice(kind, stem, lang, vars) {
    return buildKeyedNotice({ kind, keyBase: `raid-remove-roster.${stem}`, lang, vars });
  }

  async function autocompleteRemoveRosterRoster(interaction, focused) {
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User, userDoc });
    const charsWord = (count) =>
      t(
        count === 1
          ? "raid-remove-roster.autocomplete.charsSingular"
          : "raid-remove-roster.autocomplete.charsPlural",
        lang,
      );
    const choices = buildRosterAutocompleteChoices(matches, {
      lang,
      t,
      choiceKey: "raid-remove-roster.autocomplete.choice",
      charsWord,
    });
    await interaction.respond(choices).catch(() => {});
  }
  async function autocompleteRemoveRosterCharacter(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    if (!rosterInput) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    // Scope to one roster (no dedup needed, no iLvl sort - remove flow
    // shows chars in roster's natural order so user can match what they
    // see in /raid-status).
    const entries = getCharacterMatches(userDoc, {
      rosterFilter: rosterInput,
      needle: focused.value || "",
      dedup: false,
      sortByILvl: false,
    });
    const choices = buildCharacterAutocompleteChoices(entries);
    await interaction.respond(choices).catch(() => {});
  }
  const handleRemoveRosterAutocomplete = createAutocompleteDispatcher("remove-roster", {
    roster: autocompleteRemoveRosterRoster,
    character: autocompleteRemoveRosterCharacter,
  });
  // Re-points accountName after its seed character left: the first remaining
  // character no other roster of this user is named after, since roster
  // autocomplete and removal treat accountName as unique per user. Returns the
  // new name, or null when none is free and the old name stays.
  function reseedAccountName(userDoc, account) {
    const otherAccountNames = new Set(userDoc.accounts
      .filter((other) => other !== account)
      .map((other) => normalizeName(other.accountName))
      .filter(Boolean));
    const candidate = account.characters.find((character) => {
      const name = getCharacterName(character);
      return name && !otherAccountNames.has(normalizeName(name));
    });
    if (!candidate) return null;
    account.accountName = getCharacterName(candidate);
    return account.accountName;
  }

  /**
   * Remove the whole roster and describe what went with it.
   * @param {{userDoc: object, account: object, accountIndex: number, lang: string}} input - the fresh document and its matched roster
   * @returns {Promise<object>} the notice to reply with
   */
  async function removeWholeRoster({ userDoc, account, accountIndex, lang }) {
    const removedCount = Array.isArray(account.characters) ? account.characters.length : 0;
    // Summed before the splice, while the characters are still here.
    // "Raid progress is gone" is an abstraction; a gold figure is the
    // one number that makes someone stop if they mistyped the name.
    const lostGold = summarizeAccountGold(account, getStatusRaidsForCharacter);
    userDoc.accounts.splice(accountIndex, 1);
    await userDoc.save();
    // The removal and its cost read in the description; the re-add
    // command is the tip.
    const charPart =
      removedCount === 0
        ? t("raid-remove-roster.removedRoster.noChars", lang)
        : t("raid-remove-roster.removedRoster.withChars", lang, {
            count: removedCount,
            plural: removedCount === 1 ? "" : "s",
          });
    // `earned`, not `earnedUnbound`: the disjoint 💰/🔒 buckets are how
    // /raid-status *displays* gold, but what died here is the whole
    // week's progress, bound gold included. Splitting it would let the
    // card understate the loss.
    const goldPart = lostGold?.earned > 0
      ? t("raid-remove-roster.removedRoster.goldTail", lang, {
          gold: formatGold(lostGold.earned),
        })
      : "";
    return {
      kind: NoticeKind.DONE,
      title: t("raid-remove-roster.removedRoster.title", lang, {
        accountName: account.accountName,
      }),
      description: t("raid-remove-roster.removedRoster.description", lang, {
        accountName: account.accountName,
        charPart,
        goldPart,
      }),
      tip: t("raid-remove-roster.removedRoster.tip", lang, {
        accountName: account.accountName,
      }),
    };
  }

  /**
   * Remove one character, re-pointing the roster name if it was the seed.
   * @param {{userDoc: object, account: object, characterName: string, lang: string}} input - the fresh document, its matched roster and the typed name
   * @returns {Promise<object>} the notice to reply with
   */
  async function removeOneCharacter({ userDoc, account, characterName, lang }) {
    const normalizedChar = normalizeName(characterName);
    const charIndex = (account.characters || []).findIndex(
      (c) => normalizeName(getCharacterName(c)) === normalizedChar
    );
    if (charIndex === -1) {
      // The name was typed and matched nothing, so no class is known.
      return removeNotice(NoticeKind.EMPTY, "notFound.charNotFound", lang, {
        characterLabel: formatCharacterLabel(characterName),
        accountName: account.accountName,
      });
    }
    const wasSeed = normalizeName(account.accountName) === normalizedChar;
    // Captured before the splice · the card names the character with its
    // class icon the way every other surface in the bot does.
    const removedCharacter = account.characters[charIndex];
    account.characters.splice(charIndex, 1);
    const reseededTo = wasSeed && account.characters.length > 0 ? reseedAccountName(userDoc, account) : null;
    await userDoc.save();
    const remaining = account.characters.length;
    // Naming who is left beats counting them · "3 characters left" sends
    // the reader to /raid-status just to find out which three.
    const visibleNames = account.characters.slice(0, REMAINING_NAME_LIMIT).map(withClassIcon);
    const overflow = remaining - visibleNames.length;
    const remainingPart =
      remaining === 0
        ? t("raid-remove-roster.removedChar.empty", lang)
        : t("raid-remove-roster.removedChar.remaining", lang, {
            accountName: account.accountName,
            count: remaining,
            plural: remaining === 1 ? "" : "s",
            // A bare "+3" needs no translation and matches the delta
            // tokens the bot already prints elsewhere.
            names: visibleNames.join(", ") + (overflow > 0 ? ` +${overflow}` : ""),
          });
    const removedLabel = removedCharacter
      ? withClassIcon(removedCharacter)
      : formatCharacterLabel(characterName);
    // An empty roster points to removing or refilling it; a renamed one
    // tells the user its new name. A rename needs a character left, so the
    // two never meet.
    let tip;
    if (remaining === 0) {
      tip = t("raid-remove-roster.removedChar.emptyTip", lang);
    } else if (reseededTo) {
      tip = t("raid-remove-roster.removedChar.reseededTip", lang, { newSeed: reseededTo });
    }
    return {
      kind: NoticeKind.DONE,
      title: t("raid-remove-roster.removedChar.title", lang, {
        characterName: getCharacterName(removedCharacter) || characterName,
      }),
      description: t("raid-remove-roster.removedChar.description", lang, {
        characterLabel: removedLabel,
        accountName: account.accountName,
        remainingPart,
      }),
      tip,
    };
  }

  // The write behind each `action` choice. Each edits the document it is given
  // and returns its notice, holding nothing between calls, because
  // saveWithRetry reruns the whole write on a version conflict.
  const REMOVE_ACTIONS = Object.freeze({
    remove_roster: removeWholeRoster,
    remove_char: removeOneCharacter,
  });

  async function handleRemoveRosterCommand(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true).trim();
    const action = interaction.options.getString("action", true);
    const characterName = (interaction.options.getString("character") || "").trim();
    await deferEphemeralReply(interaction);
    const lang = await getUserLanguage(discordId, { UserModel: User });
    if (!Object.hasOwn(REMOVE_ACTIONS, action)) {
      await editNotice(interaction, EmbedBuilder, removeNotice(NoticeKind.INPUT, "invalid.action", lang));
      return;
    }
    if (action === "remove_char" && !characterName) {
      await editNotice(interaction, EmbedBuilder, removeNotice(NoticeKind.INPUT, "invalid.missingChar", lang));
      return;
    }
    let replyNotice = null;
    await saveWithRetry(async () => {
      const userDoc = await User.findOne({ discordId });
      if (!hasRosterAccounts(userDoc)) {
        replyNotice = buildNoRosterNotice(lang);
        return;
      }
      const normalizedRoster = normalizeName(rosterName);
      const accountIndex = userDoc.accounts.findIndex(
        (a) => normalizeName(a.accountName) === normalizedRoster
      );
      if (accountIndex === -1) {
        replyNotice = buildRosterNotFoundNotice(rosterName, lang);
        return;
      }
      replyNotice = await REMOVE_ACTIONS[action]({
        userDoc,
        account: userDoc.accounts[accountIndex],
        accountIndex,
        characterName,
        lang,
      });
    });
    if (replyNotice) {
      await editNotice(interaction, EmbedBuilder, replyNotice);
    }
  }
  return {
    handleRemoveRosterAutocomplete,
    handleRemoveRosterCommand,
  };
}

module.exports = {
  createRemoveRosterCommand,
};
