/**
 * interaction-router.js
 *
 * Single dispatcher for every Discord interaction the bot receives.
 *
 * Pulled out of `bot.js` so the entry point stays focused on lifecycle
 * (login, ClientReady, scheduler startup, MessageCreate listener) and
 * routing changes don't force edits to the entry point. Adding a new
 * slash command, autocomplete, button, or select menu now means
 * updating one of the registry props passed to `createInteractionRouter`
 * - bot.js stays untouched.
 *
 * Error handling lives here too because every code path inside `handle`
 * shares the same fallback contract: stale interaction (HTTP 10062) is
 * a benign "user clicked too late, ignore" log; everything else gets a
 * generic error reply via the appropriate followUp/reply path depending
 * on whether the interaction was already deferred.
 */

// Discord returns 10062 / "Unknown interaction" when the interaction
// token has expired before we got around to acknowledging it (typically
// 3s deadline for first response). Distinguish from real errors so the
// noise log doesn't drown out actionable failures.
function isUnknownInteractionError(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062;
}

// Compact one-line summary of an interaction for log lines. Picks the
// most-identifying field per type (commandName for slash + autocomplete,
// customId for components) and falls back to type-only when nothing
// usable is present.
function describeInteraction(interaction) {
  if (!interaction) return "unknown";
  if (interaction.isChatInputCommand?.()) return `command=${interaction.commandName}`;
  if (interaction.isAutocomplete?.()) return `autocomplete=${interaction.commandName}`;
  if (interaction.customId) return `customId=${interaction.customId}`;
  return `type=${interaction.type || "unknown"}`;
}

function getInteractionAgeMs(interaction) {
  const created = Number(interaction?.createdTimestamp) || 0;
  return created > 0 ? Date.now() - created : null;
}

/**
 * @typedef {object} InteractionRouterDeps
 * @property {object} MessageFlags - discord.js MessageFlags enum (need .Ephemeral)
 * @property {string[]} allowedCommands - Slash command allowlist; non-matching commands are ignored.
 * @property {(interaction) => Promise<void>} handleSlashCommand - Dispatcher for any slash command in `allowedCommands`.
 * @property {Record<string, (interaction) => Promise<void>>} autocompleteHandlers - Per-command autocomplete handlers, keyed by commandName.
 * @property {Record<string, (interaction) => Promise<void>>} selectHandlers - String-select handlers, keyed by exact customId.
 * @property {Array<{prefix: string, handle: (interaction) => Promise<void>}>} buttonRoutes - Button handlers matched by customId prefix (first match wins).
 */

/**
 * @param {InteractionRouterDeps} deps
 * @returns {{handle: (interaction) => Promise<void>}}
 */
function createInteractionRouter({
  MessageFlags,
  allowedCommands,
  handleSlashCommand,
  autocompleteHandlers,
  selectHandlers,
  buttonRoutes,
}) {
  const allowedCommandSet = new Set(allowedCommands);

  async function dispatch(interaction) {
    if (interaction.isChatInputCommand()) {
      if (!allowedCommandSet.has(interaction.commandName)) return;
      await handleSlashCommand(interaction);
      return;
    }

    if (interaction.isAutocomplete()) {
      const handler = autocompleteHandlers[interaction.commandName];
      if (handler) {
        await handler(interaction);
      } else {
        // Unknown autocomplete: respond with empty suggestions so the
        // Discord client doesn't show a perpetual spinner. Swallow any
        // failure - the user already sees no suggestions either way.
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const handler = selectHandlers[interaction.customId];
      if (handler) {
        await handler(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      // Prefix-match: button customIds in this bot follow
      // `raid-check:<action>:<raidKey>` and similar shapes. First
      // matching prefix wins; order in `buttonRoutes` matters.
      for (const route of buttonRoutes) {
        if (interaction.customId.startsWith(route.prefix)) {
          await route.handle(interaction);
          return;
        }
      }
    }
  }

  async function handleError(error, interaction) {
    if (isUnknownInteractionError(error)) {
      const ageMs = getInteractionAgeMs(interaction);
      const agePart = ageMs === null ? "" : ` ageMs=${ageMs}`;
      console.warn(
        `[interaction-router] stale interaction ignored: ${describeInteraction(interaction)}${agePart}`
      );
      return;
    }

    console.error("[interaction-router] error:", error);

    // Best-effort generic error reply. If the interaction was already
    // acknowledged (deferReply / reply / update), follow up; otherwise
    // try a fresh reply. Both paths swallow secondary failures because
    // the user has already seen *something* go wrong - don't compound
    // the bug with an unhandled rejection.
    const payload = {
      content: "Có lỗi xảy ra khi xử lý lệnh. Vui lòng thử lại.",
      flags: MessageFlags.Ephemeral,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => {});
    } else if (interaction.isRepliable?.()) {
      await interaction.reply(payload).catch(() => {});
    }
  }

  return {
    handle: async (interaction) => {
      try {
        await dispatch(interaction);
      } catch (error) {
        await handleError(error, interaction);
      }
    },
  };
}

module.exports = {
  createInteractionRouter,
  // Re-exported for tests / future direct use; the router uses them
  // internally but they're pure helpers with no closure state.
  isUnknownInteractionError,
  describeInteraction,
  getInteractionAgeMs,
};
