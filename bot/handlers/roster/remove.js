const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const {
  getRosterMatches,
  getCharacterMatches,
  truncateChoice,
} = require("../../utils/raid/common/autocomplete");
const { t, getUserLanguage } = require("../../services/i18n");

function createRemoveRosterCommand(deps) {
  const {
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    getCharacterName,
    getCharacterClass,
    createCharacterId,
    loadUserForAutocomplete,
  } = deps;

async function autocompleteRemoveRosterRoster(interaction, focused) {
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const choices = matches.map((a) => {
      const charCount = Array.isArray(a.characters) ? a.characters.length : 0;
      const label = `📁 ${a.accountName} · ${charCount} char${charCount === 1 ? "" : "s"}`;
      return truncateChoice(label, a.accountName);
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
    const choices = entries.map((entry) =>
      truncateChoice(
        `${entry.name} · ${entry.className} · ${entry.itemLevel}`,
        entry.name
      )
    );
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
    const lang = await getUserLanguage(discordId, { UserModel: User });
    const rosterName = interaction.options.getString("roster", true).trim();
    const action = interaction.options.getString("action", true);
    const characterName = (interaction.options.getString("character") || "").trim();
    if (action !== "remove_roster" && action !== "remove_char") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-remove-roster.invalid.actionTitle", lang),
            description: t("raid-remove-roster.invalid.actionDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "remove_char" && !characterName) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: t("raid-remove-roster.invalid.missingCharTitle", lang),
            description: t("raid-remove-roster.invalid.missingCharDescription", lang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
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
        userDoc.accounts.splice(accountIndex, 1);
        await userDoc.save();
        // Description-driven layout (no cold field table). Artist voice
        // states what happened + reminds the user the action is
        // reversible via /raid-add-roster, so the destructive `danger` color
        // is balanced by a recovery hint in the copy.
        const charPart =
          removedCount === 0
            ? t("raid-remove-roster.removedRoster.noChars", lang)
            : t("raid-remove-roster.removedRoster.withChars", lang, {
                count: removedCount,
                plural: removedCount === 1 ? "" : "s",
              });
        replyEmbed = new EmbedBuilder()
          .setColor(UI.colors.danger)
          .setTitle(t("raid-remove-roster.removedRoster.title", lang))
          .setDescription(
            t("raid-remove-roster.removedRoster.description", lang, {
              accountName: account.accountName,
              charPart,
            })
          )
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
      account.characters.splice(charIndex, 1);
      let reseededTo = null;
      if (wasSeed && account.characters.length > 0) {
        // Walk the remaining characters for the first name that does NOT
        // collide with another account's accountName - roster autocomplete
        // and removal key off accountName as a per-user unique identifier,
        // so avoiding collision here preserves that invariant.
        for (const candidate of account.characters) {
          const fallbackName = getCharacterName(candidate);
          if (!fallbackName) continue;
          const normalizedFallback = normalizeName(fallbackName);
          const collides = userDoc.accounts.some(
            (other) => other !== account && normalizeName(other.accountName) === normalizedFallback
          );
          if (collides) continue;
          account.accountName = fallbackName;
          reseededTo = fallbackName;
          break;
        }
      }
      await userDoc.save();
      const remaining = account.characters.length;
      const remainingPart =
        remaining === 0
          ? t("raid-remove-roster.removedChar.empty", lang)
          : t("raid-remove-roster.removedChar.remaining", lang, {
              accountName: account.accountName,
              count: remaining,
              plural: remaining === 1 ? "" : "s",
            });
      const embed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(t("raid-remove-roster.removedChar.title", lang))
        .setDescription(
          t("raid-remove-roster.removedChar.description", lang, {
            characterName,
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
      await interaction.reply({ embeds: [replyEmbed], flags: MessageFlags.Ephemeral });
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
