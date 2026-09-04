const {
  buildNoticeEmbed,
  deferEphemeralReply,
  editEmbed,
} = require("../../utils/raid/common/shared");
const {
  buildCharacterAutocompleteChoices,
  buildRosterAutocompleteChoices,
  getRosterMatches,
  getCharacterMatches,
} = require("../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../services/i18n");
const { formatGold } = require("../../utils/raid/common/shared");
const {
  getStatusRaidsForCharacter,
  summarizeAccountGold,
} = require("../../utils/raid/common/character");
const { getClassEmoji } = require("../../models/Class");

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
    UI,
    User,
    saveWithRetry,
    normalizeName,
    getCharacterName,
    loadUserForAutocomplete,
  } = deps;

  /**
   * Render one character as `{class icon} **{name}**`, the shape every
   * other card in the bot uses. Falls back to the bare bold name when the
   * class has no registered emoji.
   * @param {object} character - a character subdocument
   * @returns {string} markdown for one character
   */
  function withClassIcon(character) {
    const name = getCharacterName(character);
    const icon = getClassEmoji(character?.class || character?.className);
    return icon ? `${icon} **${name}**` : `**${name}**`;
  }

  async function autocompleteRemoveRosterRoster(interaction, focused) {
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
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
  async function handleRemoveRosterAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === "roster") {
        await autocompleteRemoveRosterRoster(interaction, focused);
        return;
      }
      if (focused?.name === "character") {
        await autocompleteRemoveRosterCharacter(interaction, focused);
        return;
      }
      await interaction.respond([]).catch(() => {});
    } catch (error) {
      console.error("[autocomplete] remove-roster error:", error?.message || error);
      await interaction.respond([]).catch(() => {});
    }
  }
  async function handleRemoveRosterCommand(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true).trim();
    const action = interaction.options.getString("action", true);
    const characterName = (interaction.options.getString("character") || "").trim();
    await deferEphemeralReply(interaction);
    const lang = await getUserLanguage(discordId, { UserModel: User });
    if (action !== "remove_roster" && action !== "remove_char") {
      await editEmbed(
        interaction,
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: t("raid-remove-roster.invalid.actionTitle", lang),
          description: t("raid-remove-roster.invalid.actionDescription", lang),
        })
      );
      return;
    }
    if (action === "remove_char" && !characterName) {
      await editEmbed(
        interaction,
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: t("raid-remove-roster.invalid.missingCharTitle", lang),
          description: t("raid-remove-roster.invalid.missingCharDescription", lang),
        })
      );
      return;
    }
    let replyEmbed = null;
    await saveWithRetry(async () => {
      const userDoc = await User.findOne({ discordId });
      if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
        replyEmbed = new EmbedBuilder()
          .setColor(UI.colors.muted)
          .setTitle(
            t("raid-remove-roster.notFound.noRosterTitle", lang, {
              iconInfo: UI.icons.info,
            })
          )
          .setDescription(t("raid-remove-roster.notFound.noRosterDescription", lang));
        return;
      }
      const normalizedRoster = normalizeName(rosterName);
      const accountIndex = userDoc.accounts.findIndex(
        (a) => normalizeName(a.accountName) === normalizedRoster
      );
      if (accountIndex === -1) {
        replyEmbed = new EmbedBuilder()
          .setColor(UI.colors.danger)
          .setTitle(
            t("raid-remove-roster.notFound.rosterNotFoundTitle", lang, {
              iconWarn: UI.icons.warn,
            })
          )
          .setDescription(
            t("raid-remove-roster.notFound.rosterNotFoundDescription", lang, {
              rosterName,
            })
          );
        return;
      }
      const account = userDoc.accounts[accountIndex];
      if (action === "remove_roster") {
        const removedCount = Array.isArray(account.characters) ? account.characters.length : 0;
        // Summed before the splice, while the characters are still here.
        // "Raid progress is gone" is an abstraction; a gold figure is the
        // one number that makes someone stop if they mistyped the name.
        const lostGold = summarizeAccountGold(account, getStatusRaidsForCharacter);
        userDoc.accounts.splice(accountIndex, 1);
        await userDoc.save();
        // Description-driven layout: state the removal in one block and put
        // the recovery command in the footer, where RaidManage keeps the
        // next step. The `danger` color provides the destructive-action cue.
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
        replyEmbed = new EmbedBuilder()
          .setColor(UI.colors.danger)
          .setTitle(
            t("raid-remove-roster.removedRoster.title", lang, {
              accountName: account.accountName,
            })
          )
          .setDescription(
            t("raid-remove-roster.removedRoster.description", lang, {
              accountName: account.accountName,
              charPart,
              goldPart,
            })
          )
          .setFooter({
            text: t("raid-remove-roster.removedRoster.footerReadd", lang, {
              accountName: account.accountName,
            }),
          })
          .setTimestamp();
        return;
      }
      // action === "remove_char"
      const normalizedChar = normalizeName(characterName);
      const charIndex = (account.characters || []).findIndex(
        (c) => normalizeName(getCharacterName(c)) === normalizedChar
      );
      if (charIndex === -1) {
        replyEmbed = new EmbedBuilder()
          .setColor(UI.colors.progress)
          .setTitle(
            t("raid-remove-roster.notFound.charNotFoundTitle", lang, {
              iconWarn: UI.icons.warn,
            })
          )
          .setDescription(
            t("raid-remove-roster.notFound.charNotFoundDescription", lang, {
              characterName,
              accountName: account.accountName,
            })
          );
        return;
      }
      const wasSeed = normalizeName(account.accountName) === normalizedChar;
      // Captured before the splice · the card names the character with its
      // class icon the way every other surface in the bot does.
      const removedCharacter = account.characters[charIndex];
      account.characters.splice(charIndex, 1);
      let reseededTo = null;
      if (wasSeed && account.characters.length > 0) {
        // Roster autocomplete and removal treat accountName as unique per user.
        // Index other account names once, then preserve the former natural-order
        // rule by selecting the first remaining non-colliding character.
        const otherAccountNames = new Set();
        for (const other of userDoc.accounts) {
          if (other === account) continue;
          const normalizedAccountName = normalizeName(other.accountName);
          if (normalizedAccountName) otherAccountNames.add(normalizedAccountName);
        }
        for (const candidate of account.characters) {
          const fallbackName = getCharacterName(candidate);
          if (!fallbackName) continue;
          const normalizedFallback = normalizeName(fallbackName);
          if (otherAccountNames.has(normalizedFallback)) continue;
          account.accountName = fallbackName;
          reseededTo = fallbackName;
          break;
        }
      }
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
        : `**${characterName}**`;
      const embed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(
          t("raid-remove-roster.removedChar.title", lang, {
            characterName: getCharacterName(removedCharacter) || characterName,
          })
        )
        .setDescription(
          t("raid-remove-roster.removedChar.description", lang, {
            characterName: removedLabel,
            accountName: account.accountName,
            remainingPart,
          })
        )
        .setTimestamp();
      if (reseededTo) {
        embed.setFooter({
          text: t("raid-remove-roster.removedChar.reseededFooter", lang, {
            newSeed: reseededTo,
          }),
        });
      }
      replyEmbed = embed;
    });
    if (replyEmbed) {
      await editEmbed(interaction, replyEmbed);
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
