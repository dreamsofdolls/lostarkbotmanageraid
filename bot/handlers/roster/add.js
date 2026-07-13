"use strict";

const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const {
  handlePickerSessionTimeout,
  newPickerSessionId,
  resolveAdminMention,
} = require("../../utils/raid/roster-picker");
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
  createAddRosterViewBuilders,
} = require("./add/view");
const {
  createAddRosterPersistence,
} = require("./add/persistence");
const {
  createTargetDmDelivery,
} = require("./add/dm");
const {
  SESSION_TTL_MS,
  PICKER_MAX_OPTIONS,
} = require("./add/constants");
const { createAddRosterNoticeHelpers } = require("./add/notices");
const { createAddRosterTargetResolver } = require("./add/target");
const {
  buildAddRosterSession,
  buildBibleNameSet,
  findDuplicateByBibleNames,
  findDuplicateBySeed,
} = require("./add/session");
function createAddRosterCommand({
  EmbedBuilder,
  StringSelectMenuBuilder,
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
  isManagerId,
  getPrimaryManagerId,
}) {
  const adminMention = resolveAdminMention(getPrimaryManagerId);
  const { buildNotice, replyNotice } = createAddRosterNoticeHelpers({
    EmbedBuilder,
    MessageFlags,
    buildNoticeEmbed,
  });
  // Module-level cache: sessionId -> session state. Lives in process
  // Sessions are memory-only and are discarded on restart. Users can reopen
  // the picker with /raid-add-roster. Random session IDs allow concurrent
  // pickers for one user until each five-minute timer expires.
  const sessions = new Map();

  const {
    buildCancelledEmbed,
    buildExpiredEmbed,
    buildSavedEmbed,
    buildSelectionComponents,
    buildSelectionEmbed,
    buildTargetDMEmbed,
  } = createAddRosterViewBuilders({
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    UI,
    t,
  });
  const { tryDeliverTargetDM } = createTargetDmDelivery({
    User,
    getUserLanguage,
    buildTargetDMEmbed,
  });
  const { resolveAddRosterTarget } = createAddRosterTargetResolver({
    isManagerId,
    t,
    replyNotice,
  });
  const { persistSelectedRoster } = createAddRosterPersistence({
    User,
    saveWithRetry,
    ensureFreshWeek,
    normalizeName,
    getCharacterName,
    getCharacterClass,
    buildCharacterRecord,
    createCharacterId,
    preserveRosterCharacterState,
  });
  async function handleAddRosterCommand(interaction) {
    const callerId = interaction.user.id;
    // Slash invoker (Manager or self-add user) sees every reply on this
    // command in their own locale — including the Manager-target
    // onboarding ephemeral, which is the Manager's reply that *mentions*
    // the target. Target's separate DM uses their own lang (resolved in
    // tryDeliverTargetDM).
    const lang = await getUserLanguage(callerId, { UserModel: User });
    const seedCharName = interaction.options.getString("name", true).trim();

    // The target option lets a Raid Manager register a roster for another
    // user. Data is saved under the target's Discord ID and the option remains
    // manager-gated to prevent unauthorized cross-user writes.
    const target = await resolveAddRosterTarget({ interaction, callerId, lang });
    if (target.handled) return;
    const { targetUser, discordId, actingForOther } = target;

    // Reject if this roster is already saved under this Discord user.
    // Seed name matches either an existing account name or any stored
    // character name → block the add. Users who want to refresh a saved
    // roster should remove it first, per Traine's explicit preference.
    const existingUser = await User.findOne({ discordId }).lean();
    if (existingUser && Array.isArray(existingUser.accounts)) {
      const matched = findDuplicateBySeed({
        accounts: existingUser.accounts,
        seedCharName,
        normalizeName,
        getCharacterName,
      });
      if (matched) {
        await replyNotice(interaction, {
          type: "warn",
          title: t("raid-add-roster.duplicate.preFetchTitle", lang),
          description: t("raid-add-roster.duplicate.preFetchDescription", lang, {
            accountName: matched.accountName,
          }),
        });
        return;
      }
    }

    await interaction.deferReply();
    let rosterCharacters;
    try {
      rosterCharacters = await fetchRosterCharacters(seedCharName);
    } catch (error) {
      await interaction.editReply(
        t("raid-add-roster.fetch.failed", lang, {
          iconWarn: UI.icons.warn,
          error: error.message,
        })
      );
      return;
    }
    if (rosterCharacters.length === 0) {
      await interaction.editReply(
        t("raid-add-roster.fetch.empty", lang, { iconWarn: UI.icons.warn })
      );
      return;
    }

    // Robust duplicate-roster guard (post-fetch). The pre-fetch guard above
    // only catches seedCharName collisions with accountName / saved char
    // names - it misses the case where the user seeds with a real bible
    // char they haven't saved yet but whose roster already lives under a
    // different accountName. Without this check, persistSelectedRoster
    // would create a SECOND account pointing to the same bible roster
    // (because the account-match logic only inspects the user's selection,
    // not the full bible char list), splitting one bible roster across
    // two accounts and breaking the "1 bible roster = 1 account/user"
    // invariant that /raid-remove-roster + /raid-set rely on. Direct users to
    // /raid-edit-roster instead since that's exactly the right tool here.
    // Build the bible name set once: used both for the command-time
    // overlap guard below AND stashed into session.bibleNames so
    // persistSelectedRoster can re-run the same overlap check inside
    // saveWithRetry against the FRESH userDoc (catches the race where
    // a concurrent /raid-add-roster session committed first between command
    // time and Confirm).
    const bibleNameSet = buildBibleNameSet(rosterCharacters, normalizeName);

    if (existingUser && Array.isArray(existingUser.accounts)) {
      const collidingAccount = findDuplicateByBibleNames({
        accounts: existingUser.accounts,
        bibleNameSet,
        normalizeName,
        getCharacterName,
      });
      if (collidingAccount) {
        await interaction.editReply({
          content: null,
          embeds: [
            buildNotice({
              type: "warn",
              title: t("raid-add-roster.duplicate.postFetchTitle", lang),
              description: t("raid-add-roster.duplicate.postFetchDescription", lang, {
                accountName: collidingAccount.accountName,
              }),
            }),
          ],
        });
        return;
      }
    }

    const sessionId = newPickerSessionId();
    // Default selection: every char shown. Matches Traine's intent
    // ("user này chơi toàn bộ"). Users with alts they don't play
    // toggle them off via the per-char buttons before confirming.
    const { session, truncated, sortedCount } = buildAddRosterSession({
      sessionId,
      callerId,
      lang,
      targetUser,
      discordId,
      actingForOther,
      seedCharName,
      // Snapshot of the FULL bible roster's normalized char names from
      // this fetch — feeds the race-safe overlap guard inside
      // persistSelectedRoster. NOT just the displayed (capped) chars
      // because two sessions on the same bible roster could each truncate
      // to different windows yet still represent the same roster.
      bibleNames: bibleNameSet,
      rosterCharacters,
      parseCombatScore,
    });
    sessions.set(sessionId, session);

    if (truncated) {
      console.warn(
        `[add-roster] roster ${seedCharName} has ${sortedCount} chars; truncated to ${PICKER_MAX_OPTIONS} for picker.`
      );
    }

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
        logTag: "add-roster",
      }),
      SESSION_TTL_MS
    );
  }

  async function handleAddRosterButton(interaction) {
    // CustomId shape: `add-roster:<action>:<sessionId>` for confirm/cancel,
    // `add-roster:toggle:<sessionId>:<charIndex>` for per-char toggle.
    const context = await loadRosterPickerButtonContext({
      interaction,
      prefix: "add-roster",
      sessions,
      User,
      getUserLanguage,
      buildNoticeEmbed,
      EmbedBuilder,
      MessageFlags,
      t,
      staleTitleKey: "raid-add-roster.expired.staleSessionTitle",
      staleDescriptionKey: "raid-add-roster.expired.staleSessionDescription",
      authTitleKey: "raid-add-roster.auth2.notYourPickerTitle",
      authDescriptionKey: "raid-add-roster.auth2.notYourPickerDescription",
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

    if (action === "confirm") {
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
        keyPrefix: "raid-add-roster",
      });
      if (guard.handled) return;
      const selectedChars = guard.selectedChars;

      let savedAccount;
      try {
        savedAccount = await persistSelectedRoster(session, selectedChars);
      } catch (err) {
        // A concurrent /raid-add-roster session committed the same Bible
        // roster first. Direct the user to /raid-edit-roster.
        if (err?.code === "RACE_DUP_ROSTER") {
          console.warn(
            `[add-roster] race-detected duplicate roster: ${err.collidingAccountName}`
          );
          await interaction.editReply({
            content: null,
            components: [],
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "warn",
                title: t("raid-add-roster.duplicate.raceTitle", session.lang),
                description: t("raid-add-roster.duplicate.raceDescription", session.lang, {
                  accountName: err.collidingAccountName,
                }),
              }),
            ],
          });
          return;
        }
        console.error(`[add-roster] persist failed:`, err);
        await interaction.editReply({
          content: null,
          components: [],
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: t("raid-add-roster.persistFail.title", session.lang),
              description: t("raid-add-roster.persistFail.description", session.lang, {
                error: err?.message || err,
                adminMention,
              }),
            }),
          ],
        });
        return;
      }

      // Manager target onboarding: best-effort DM to the target user
      // BEFORE the channel embed lands, so the embed can surface DM
      // delivery status ("📩 Đã DM" / "⚠️ Không DM được"). DM is the
      // primary notification because it persists in the target's inbox.
      // The channel ping remains an audit record and fallback for blocked DMs.
      let dmDelivery = null;
      if (session.actingForOther) {
        const guildName = interaction.guild?.name || null;
        dmDelivery = await tryDeliverTargetDM(
          interaction.client,
          session,
          savedAccount,
          guildName
        );
      }

      // Ping the target user when Manager added on their behalf. Discord
      // ONLY fires notifications for mentions in the message `content`
      // field — mentions inside an embed description don't ping anyone,
      // even with allowedMentions set. Without an explicit content
      // mention here the target wouldn't get any notification despite
      // the embed text saying "đã được Manager add giúp <@target>".
      // Channel ping content uses the TARGET's lang because the ping
      // message is read by the target user (the @mention pulls their
      // attention to the ping; manager already has the embed details).
      let pingContent = null;
      if (session.actingForOther) {
        const targetLang = await getUserLanguage(session.targetId, { UserModel: User });
        pingContent = t("raid-add-roster.saved.managerPing", targetLang, {
          targetId: session.targetId,
          callerId: session.callerId,
        });
      }
      await interaction.editReply({
        content: pingContent,
        embeds: [buildSavedEmbed(session, savedAccount, dmDelivery)],
        components: [],
        allowedMentions: session.actingForOther
          ? { users: [session.targetId] }
          : { parse: [] },
      });
    }
  }

  return {
    handleAddRosterCommand,
    handleAddRosterButton,
    // Internals exposed for unit tests in test/raid-add-roster.test.js. Not
    // part of the public contract — runtime callers go through the
    // handlers above. The session map is exposed read-only-by-convention
    // for tests that need to inject a session before exercising Confirm.
    __test: {
      persistSelectedRoster,
      sessions,
    },
  };
}

module.exports = {
  createAddRosterCommand,
};
