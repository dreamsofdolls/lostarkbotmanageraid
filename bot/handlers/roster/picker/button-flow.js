"use strict";

const {
  authorizePickerSession,
  clearPickerSession,
} = require("../../../utils/raid/roster-picker");
const {
  getRosterPickerRoute,
} = require("./picker-routes");

async function replyStaleRosterPicker({
  interaction,
  User,
  getUserLanguage,
  buildNoticeEmbed,
  EmbedBuilder,
  MessageFlags,
  t,
  titleKey,
  descriptionKey,
}) {
  const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
  await interaction.reply({
    embeds: [
      buildNoticeEmbed(EmbedBuilder, {
        type: "muted",
        title: t(titleKey, clickerLang),
        description: t(descriptionKey, clickerLang),
      }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function loadRosterPickerButtonContext({
  interaction,
  prefix,
  sessions,
  User,
  getUserLanguage,
  buildNoticeEmbed,
  EmbedBuilder,
  MessageFlags,
  t,
  staleTitleKey,
  staleDescriptionKey,
  authTitleKey,
  authDescriptionKey,
}) {
  const route = getRosterPickerRoute(interaction.customId, { prefix });
  const action = route?.action || "";
  const sessionId = route?.sessionId || "";
  const session = sessions.get(sessionId);
  if (!session) {
    await replyStaleRosterPicker({
      interaction,
      User,
      getUserLanguage,
      buildNoticeEmbed,
      EmbedBuilder,
      MessageFlags,
      t,
      titleKey: staleTitleKey,
      descriptionKey: staleDescriptionKey,
    });
    return { handled: true, route, action, sessionId, session: null };
  }

  const denied = await authorizePickerSession({
    interaction,
    session,
    User,
    getUserLanguage,
    buildNoticeEmbed,
    EmbedBuilder,
    MessageFlags,
    t,
    titleKey: authTitleKey,
    descriptionKey: authDescriptionKey,
  });
  if (denied) return { handled: true, route, action, sessionId, session };

  return { handled: false, route, action, sessionId, session };
}

function toggleRosterPickerIndex(session, charIndex) {
  if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= session.chars.length) {
    return false;
  }
  if (session.selectedIndices.has(charIndex)) {
    session.selectedIndices.delete(charIndex);
  } else {
    session.selectedIndices.add(charIndex);
  }
  return true;
}

async function handleRosterPickerToggle({
  interaction,
  session,
  charIndex,
  buildSelectionEmbed,
  buildSelectionComponents,
}) {
  if (!toggleRosterPickerIndex(session, charIndex)) {
    await interaction.deferUpdate().catch(() => {});
    return;
  }
  await interaction.update({
    embeds: [buildSelectionEmbed(session)],
    components: buildSelectionComponents(session),
  });
}

async function handleRosterPickerCancel({
  interaction,
  sessions,
  sessionId,
  session,
  buildCancelledEmbed,
}) {
  clearPickerSession(sessions, sessionId);
  await interaction.update({
    embeds: [buildCancelledEmbed(session)],
    components: [],
  });
}

/**
 * Confirm-button guard shared by the /raid-add-roster + /raid-edit-roster
 * pickers. Runs the two pre-persist gates (empty selection, per-account cap)
 * in identical order, replying with the clicker's localized warning on
 * failure, then defers the component update and clears the in-flight session
 * so the caller can go straight to the DB write.
 * @param {object} args - see destructure. `keyPrefix` selects the locale
 *   namespace ("raid-add-roster" | "raid-edit-roster"); `noSelectionVars`
 *   threads extra copy vars (edit passes the accountName).
 * @returns {Promise<{handled: boolean, selectedChars: object[]|null}>}
 *   handled=true means a guard already replied and the caller must return;
 *   otherwise selectedChars holds the confirmed picks (session deferred + cleared).
 */
async function guardPickerConfirm({
  interaction,
  session,
  sessions,
  sessionId,
  EmbedBuilder,
  MessageFlags,
  t,
  buildNoticeEmbed,
  maxChars,
  keyPrefix,
  noSelectionVars = {},
}) {
  if (session.selectedIndices.size === 0) {
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: t(`${keyPrefix}.confirm.noSelectionTitle`, session.lang),
          description: t(`${keyPrefix}.confirm.noSelectionDescription`, session.lang, noSelectionVars),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return { handled: true, selectedChars: null };
  }

  // Selected chars in display order (index = CP-rank) so the saved-embed list
  // reads naturally. Cap defensively at maxChars: the picker is already capped
  // at PICKER_MAX_OPTIONS, but a future bump there must not silently overflow
  // the per-account storage cap.
  const selectedChars = selectedRosterPickerChars(session);
  if (selectedChars.length > maxChars) {
    await interaction.reply({
      embeds: [
        buildNoticeEmbed(EmbedBuilder, {
          type: "warn",
          title: t(`${keyPrefix}.confirm.capExceededTitle`, session.lang),
          description: t(`${keyPrefix}.confirm.capExceededDescription`, session.lang, {
            cap: maxChars,
            count: selectedChars.length,
          }),
        }),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return { handled: true, selectedChars: null };
  }

  // Defer before the DB write - saveWithRetry can exceed the 3s ack window if
  // Mongo is slow; deferUpdate keeps the picker on screen until editReply
  // swaps in the final embed. Clear the session now so a double-click can't
  // re-enter the confirm path mid-write.
  await interaction.deferUpdate();
  clearPickerSession(sessions, sessionId);
  return { handled: false, selectedChars };
}

function selectedRosterPickerChars(session) {
  return Array.from(session.selectedIndices)
    .sort((a, b) => a - b)
    .map((i) => session.chars[i])
    .filter(Boolean);
}

module.exports = {
  loadRosterPickerButtonContext,
  handleRosterPickerToggle,
  handleRosterPickerCancel,
  guardPickerConfirm,
  selectedRosterPickerChars,
  toggleRosterPickerIndex,
};
