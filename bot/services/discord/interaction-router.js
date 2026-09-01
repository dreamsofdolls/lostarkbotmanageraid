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
 * shares the same fallback contract. Discord acknowledgement races
 * (10062/40060) are logged with process identity and never trigger a
 * second reply; unrelated failures use the generic error response.
 */

const {
  buildRuntimeInstanceIdentity,
} = require("../runtime/instance-identity");

const INITIAL_ACK_DEADLINE_MS = 3_000;
const INTERACTION_DEDUPE_TTL_MS = 15 * 60 * 1_000;
const INTERACTION_DEDUPE_MAX_ENTRIES = 4_096;

function getDiscordErrorCode(error) {
  for (const value of [error?.code, error?.rawError?.code]) {
    if (value === null || value === undefined || value === "") continue;
    const numeric = Number(value);
    if (Number.isInteger(numeric)) return numeric;
  }
  return null;
}

/**
 * Identify Discord's "Unknown interaction" acknowledgement failure.
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnknownInteractionError(error) {
  return getDiscordErrorCode(error) === 10062;
}

/**
 * Identify Discord's explicit duplicate acknowledgement failure.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAlreadyAcknowledgedError(error) {
  return getDiscordErrorCode(error) === 40060;
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

function getLocalAckState(interaction) {
  if (interaction?.replied) return "replied";
  if (interaction?.deferred) return "deferred";
  return "none";
}

function describeInteractionContext(interaction, instanceIdentity) {
  const interactionId = interaction?.id || "unknown";
  const ageMs = getInteractionAgeMs(interaction);
  const agePart = ageMs === null ? "ageMs=unknown" : `ageMs=${ageMs}`;
  return [
    describeInteraction(interaction),
    `interactionId=${interactionId}`,
    agePart,
    `localAck=${getLocalAckState(interaction)}`,
    instanceIdentity,
  ].join(" ");
}

function createInteractionDeduper({
  ttlMs = INTERACTION_DEDUPE_TTL_MS,
  maxEntries = INTERACTION_DEDUPE_MAX_ENTRIES,
  now = Date.now,
} = {}) {
  const seenAtById = new Map();

  return {
    claim(rawInteractionId) {
      const interactionId = String(rawInteractionId || "");
      if (!interactionId) return true;

      const timestamp = now();
      const previousTimestamp = seenAtById.get(interactionId);
      if (
        previousTimestamp !== undefined &&
        timestamp - previousTimestamp < ttlMs
      ) {
        return false;
      }

      seenAtById.delete(interactionId);
      seenAtById.set(interactionId, timestamp);
      if (seenAtById.size > maxEntries) {
        const oldestId = seenAtById.keys().next().value;
        seenAtById.delete(oldestId);
      }
      return true;
    },
  };
}

/**
 * @typedef {object} InteractionRouterDeps
 * @property {object} MessageFlags - discord.js MessageFlags enum (need .Ephemeral)
 * @property {string[]} allowedCommands - Slash command allowlist; non-matching commands are ignored.
 * @property {(interaction) => Promise<void>} handleSlashCommand - Dispatcher for any slash command in `allowedCommands`.
 * @property {Record<string, (interaction) => Promise<void>>} autocompleteHandlers - Per-command autocomplete handlers, keyed by commandName.
 * @property {Record<string, (interaction) => Promise<void>>} selectHandlers - String-select handlers, keyed by exact customId. Tried first.
 * @property {Array<{prefix: string, handle: (interaction) => Promise<void>}>} [selectRoutes] - Optional select handlers matched by customId prefix (first match wins). Used when the customId carries dynamic data (session IDs, etc.).
 * @property {Array<{prefix: string, handle: (interaction) => Promise<void>}>} buttonRoutes - Button handlers matched by customId prefix (first match wins).
 * @property {string} [instanceIdentity] - secret-free runtime fingerprint for diagnostics
 * @property {{warn: Function, error: Function}} [log] - injectable logger
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
  selectRoutes = [],
  buttonRoutes,
  instanceIdentity = buildRuntimeInstanceIdentity(),
  log = console,
}) {
  const allowedCommandSet = new Set(allowedCommands);
  const interactionDeduper = createInteractionDeduper();

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

    // User Select menus route through the same selectRoutes as
    // String Select - the add-member flow uses a native user picker. Optional
    // call so callers/mocks without the method (older tests) stay safe.
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu?.()) {
      // Exact-match table first (covers static customIds like
      // "raid-help:select"); then prefix-match routes (used when the
      // customId carries dynamic data such as a session ID — same shape
      // as buttonRoutes below). First matching prefix wins.
      const handler = selectHandlers[interaction.customId];
      if (handler) {
        await handler(interaction);
        return;
      }
      for (const route of selectRoutes) {
        if (interaction.customId.startsWith(route.prefix)) {
          await route.handle(interaction);
          return;
        }
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
    const interactionContext = describeInteractionContext(
      interaction,
      instanceIdentity
    );
    if (isAlreadyAcknowledgedError(error)) {
      log.warn(
        `[interaction-router] duplicate acknowledgement ignored: ${interactionContext}`
      );
      return;
    }

    if (isUnknownInteractionError(error)) {
      const ageMs = getInteractionAgeMs(interaction);
      const event =
        ageMs !== null && ageMs < INITIAL_ACK_DEADLINE_MS
          ? "interaction unavailable before deadline; duplicate consumer suspected"
          : "stale interaction ignored";
      log.warn(
        `[interaction-router] ${event}: ${interactionContext}`
      );
      return;
    }

    log.error("[interaction-router] error:", error);

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
      if (!interactionDeduper.claim(interaction?.id)) {
        log.warn(
          `[interaction-router] duplicate in-process dispatch ignored: ${describeInteractionContext(
            interaction,
            instanceIdentity
          )}`
        );
        return;
      }
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
  isAlreadyAcknowledgedError,
  isUnknownInteractionError,
};
