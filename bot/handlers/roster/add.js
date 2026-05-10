"use strict";

const crypto = require("crypto");
const { buildNoticeEmbed } = require("../../utils/raid/common/shared");
const { t, getUserLanguage } = require("../../services/i18n");

// Two-step flow window: from /raid-add-roster invocation to Confirm click. After
// 5 minutes the in-memory session is dropped and the embed is updated to
// "expired"; user must re-run the command to retry. Matches the budget
// Traine specified.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Discord caps a message at 5 ActionRow components. The picker layout
// reserves 1 row for Confirm + Cancel buttons, leaving 4 rows for
// per-char toggle buttons at 5 buttons per row = 20 max chars in the
// picker. Real Lost Ark rosters max ~18 chars per account in-game so
// 20 still has headroom. Any chars beyond the cap get dropped from the
// picker (CP-sorted prefix wins) and surfaced as an embed warning.
const PICKER_MAX_OPTIONS = 20;
const BUTTONS_PER_ROW = 5;

const CHECK_ICON = "✅";
const UNCHECK_ICON = "⬜";
const PRESERVED_CHARACTER_FIELDS = [
  "bibleSerial",
  "bibleCid",
  "bibleRid",
  "publicLogDisabled",
];

function preserveExistingCharacterState(record, existing) {
  if (!existing) return record;
  const source = existing.toObject?.() ?? existing;
  for (const field of PRESERVED_CHARACTER_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(source, field) &&
      source[field] !== undefined
    ) {
      record[field] = source[field];
    }
  }
  return record;
}

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
  // Resolved once at factory boot. Used in error embeds to ping the
  // primary admin (first entry of RAID_MANAGER_ID env) by mention so
  // users see a clickable @<id> instead of a generic "ping admin"
  // string. Falls back to plain text when no manager is configured.
  const adminMention = (() => {
    const id = typeof getPrimaryManagerId === "function" ? getPrimaryManagerId() : null;
    return id ? `<@${id}>` : "admin";
  })();
  // Module-level cache: sessionId -> session state. Lives in process
  // memory only; bot restart drops every in-flight session, which is
  // acceptable since the user is sitting in front of the embed and can
  // simply re-run /raid-add-roster. Keying by random sessionId (not by user)
  // means a user who runs /raid-add-roster twice gets two independent
  // pickers — the older one still works until its 5-minute timer fires.
  const sessions = new Map();

  function newSessionId() {
    return crypto.randomBytes(8).toString("hex");
  }

  function buildSeedRosterLink(seedCharName) {
    return `https://lostark.bible/character/NA/${encodeURIComponent(seedCharName)}/roster`;
  }

  function buildSelectionEmbed(session) {
    // Char list shows stats only — selection state lives on the toggle
    // buttons below (✅/⬜ in the button label) so the embed and the
    // controls don't duplicate the same information visually.
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    const lines = session.chars.map((c, i) => {
      const cp = c.combatScore || "?";
      return `**${i + 1}.** ${c.charName} · ${c.className} · iLvl \`${c.itemLevel}\` · CP \`${cp}\``;
    });

    const desc = [
      t("raid-add-roster.picker.rosterLine", lang, {
        seedName: session.seedCharName,
        link,
      }),
      t("raid-add-roster.picker.foundLine", lang, { count: session.chars.length }),
      "",
      ...lines,
      "",
      t("raid-add-roster.picker.selectingLine", lang, {
        selected: session.selectedIndices.size,
        total: session.chars.length,
      }),
      t("raid-add-roster.picker.footerHint", lang, { iconInfo: UI.icons.info }),
    ];

    if (session.actingForOther) {
      desc.push("");
      desc.push(
        t("raid-add-roster.picker.managerHelping", lang, {
          iconInfo: UI.icons.info,
          callerId: session.callerId,
          targetId: session.targetId,
        })
      );
    }

    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.picker.title", lang, { iconRoster: UI.icons.roster }))
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: t("raid-add-roster.picker.footerText", lang) });
  }

  function buildSelectionComponents(session) {
    // Per-char toggle buttons replace the previous StringSelectMenu.
    // Rationale: a multi-select dropdown duplicated state with the
    // embed (both showed ✅/⬜ for each char) and got visually messy
    // when expanded with default-selected pills wrapping across lines.
    // Toggle buttons keep state visible permanently in one place
    // (button label + green/gray style) and collapse the workflow to
    // a single click per char to flip.
    //
    // Layout: 4 rows of up to 5 char buttons (PICKER_MAX_OPTIONS=20)
    // + 1 row of Confirm/Cancel. Discord's hard cap is 5 ActionRows
    // per message, so this is the maximum picker size.
    const charRows = [];
    for (let rowStart = 0; rowStart < session.chars.length; rowStart += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder();
      const rowEnd = Math.min(rowStart + BUTTONS_PER_ROW, session.chars.length);
      for (let i = rowStart; i < rowEnd; i += 1) {
        const c = session.chars[i];
        const isSelected = session.selectedIndices.has(i);
        const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
        // Button label cap is 80 chars. Keep the index + name + class
        // visible; truncate the char name first if needed.
        const baseLabel = `${marker} ${i + 1}. ${c.charName} (${c.className})`;
        const label = baseLabel.length > 80 ? `${baseLabel.slice(0, 77)}...` : baseLabel;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`add-roster:toggle:${session.sessionId}:${i}`)
            .setLabel(label)
            .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
        );
      }
      charRows.push(row);
    }

    // Color scheme keeps action buttons visually distinct from toggle
    // state buttons: Success (green) / Secondary (gray) belong to the
    // per-char toggles, so Confirm uses Primary (blue) and Cancel uses
    // Danger (red). Without this split the channel screenshot showed
    // Confirm visually identical to a selected char and Cancel
    // identical to an unselected one — hard to scan the action row.
    const confirmBtn = new ButtonBuilder()
      .setCustomId(`add-roster:confirm:${session.sessionId}`)
      .setLabel(`Confirm (${session.selectedIndices.size})`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.selectedIndices.size === 0);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`add-roster:cancel:${session.sessionId}`)
      .setLabel(t("raid-add-roster.picker.cancelLabel", session.lang))
      .setStyle(ButtonStyle.Danger);

    return [
      ...charRows,
      new ActionRowBuilder().addComponents(confirmBtn, cancelBtn),
    ];
  }

  function buildExpiredEmbed(session) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.expired.title", lang, { iconWarn: UI.icons.warn }))
      .setDescription(
        t("raid-add-roster.expired.description", lang, {
          seedName: session.seedCharName,
          link,
        })
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: t("raid-add-roster.expired.footerText", lang) });
  }

  function buildCancelledEmbed(session) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.cancelled.title", lang, { iconInfo: UI.icons.info }))
      .setDescription(
        t("raid-add-roster.cancelled.description", lang, {
          seedName: session.seedCharName,
          link,
        })
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: t("raid-add-roster.cancelled.footerText", lang) });
  }

  function buildSavedEmbed(session, savedAccount, dmDelivery = null) {
    const lang = session.lang;
    const link = buildSeedRosterLink(session.seedCharName);
    const summaryLines = savedAccount.characters.map(
      (character, index) =>
        `${index + 1}. ${character.name} · ${character.class} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``
    );
    const descriptionLines = [
      t("raid-add-roster.saved.rosterLine", lang, {
        accountName: savedAccount.accountName,
        link,
      }),
      t("raid-add-roster.saved.savedLine", lang, {
        count: savedAccount.characters.length,
      }),
    ];
    if (session.actingForOther) {
      descriptionLines.push(
        t("raid-add-roster.saved.managerHelpingLine", lang, {
          iconInfo: UI.icons.info,
          callerId: session.callerId,
          targetId: session.targetId,
        })
      );
      // Surface DM-delivery status so the Manager knows whether the
      // target got a private notice or only the channel ping.
      if (dmDelivery?.delivered) {
        descriptionLines.push(
          t("raid-add-roster.saved.dmDelivered", lang, { targetId: session.targetId })
        );
      } else if (dmDelivery?.reason === "dms-disabled") {
        descriptionLines.push(
          t("raid-add-roster.saved.dmDisabled", lang, {
            iconWarn: UI.icons.warn,
            targetId: session.targetId,
          })
        );
      } else if (dmDelivery?.reason === "error") {
        descriptionLines.push(
          t("raid-add-roster.saved.dmError", lang, {
            iconWarn: UI.icons.warn,
            targetId: session.targetId,
          })
        );
      }
    }
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.saved.title", lang, { iconRoster: UI.icons.roster }))
      .setDescription(descriptionLines.join("\n"))
      .addFields({
        name: t("raid-add-roster.saved.charactersField", lang, {
          count: savedAccount.characters.length,
        }),
        value: summaryLines.join("\n").slice(0, 1024),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: t("raid-add-roster.saved.footerText", lang) })
      .setTimestamp();
  }

  // Personal DM embed for the Manager-target onboarding flow. Mirrors
  // buildSavedEmbed's content but with a Manager-friendly intro line +
  // hints at the next-step commands (/raid-status, /raid-edit-roster) so
  // the target knows what to do without scrolling channel chrome.
  // `targetLang` resolved by caller (recipient's locale, not Manager's).
  function buildTargetDMEmbed(session, savedAccount, guildName, targetLang) {
    const lang = targetLang;
    const link = buildSeedRosterLink(session.seedCharName);
    const summaryLines = savedAccount.characters.map(
      (character, index) =>
        `${index + 1}. ${character.name} · ${character.class} · \`${character.itemLevel}\` · \`${character.combatScore || "?"}\``
    );
    const guildLine = guildName
      ? t("raid-add-roster.targetDM.guildLine", lang, { guildName })
      : "";
    return new EmbedBuilder()
      .setTitle(t("raid-add-roster.targetDM.title", lang, { iconRoster: UI.icons.roster }))
      .setDescription(
        t("raid-add-roster.targetDM.description", lang, {
          callerId: session.callerId,
          guildLine,
          accountName: savedAccount.accountName,
          link,
          count: savedAccount.characters.length,
        })
      )
      .addFields({
        name: t("raid-add-roster.targetDM.charactersField", lang, {
          count: savedAccount.characters.length,
        }),
        value: summaryLines.join("\n").slice(0, 1024),
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: t("raid-add-roster.targetDM.footerText", lang) })
      .setTimestamp();
  }

  // Best-effort DM to the target user when Manager added on their
  // behalf. Returns a delivery report so the channel embed can surface
  // success / failure ("📩 Đã DM" vs "⚠️ Không DM được"). Discord
  // API code 50007 = "Cannot send messages to this user" — fires when
  // target has DMs from server members disabled, has blocked the bot,
  // or shares no mutual servers (latter shouldn't happen here since
  // they're in the slash command's guild). Treated as expected, not
  // an error.
  async function tryDeliverTargetDM(client, session, savedAccount, guildName) {
    if (!session.actingForOther || !session.targetId) {
      return { delivered: false, reason: "not-acting-for-other" };
    }
    try {
      // Resolve recipient's locale: the DM is read by the target user,
      // not the Manager who clicked Confirm. Falls back to vi if the
      // target has no language preference.
      const targetLang = await getUserLanguage(session.targetId, { UserModel: User });
      const targetUser = await client.users.fetch(session.targetId);
      await targetUser.send({
        embeds: [buildTargetDMEmbed(session, savedAccount, guildName, targetLang)],
      });
      return { delivered: true };
    } catch (err) {
      const dmsDisabled =
        err?.code === 50007 || err?.rawError?.code === 50007;
      console.warn(
        `[add-roster] DM to target ${session.targetId} failed${dmsDisabled ? " (DMs disabled)" : ""}: ${err?.message || err}`
      );
      return {
        delivered: false,
        reason: dmsDisabled ? "dms-disabled" : "error",
      };
    }
  }

  // The save path used to live inline in handleAddRosterCommand; pulled
  // out so Confirm can reuse the same logic without round-tripping the
  // whole command. Returns a plain account snapshot for embed rendering.
  //
  // Throws an Error with code "RACE_DUP_ROSTER" + collidingAccountName
  // when the freshly-loaded userDoc already contains an account whose
  // chars overlap the bible roster we fetched. The Confirm handler
  // catches this and renders a user-friendly hint pointing to /raid-edit-roster.
  async function persistSelectedRoster(session, selectedChars) {
    const rosterNameSet = new Set(selectedChars.map((c) => normalizeName(c.charName)));
    // Full bible char names from the fetch that opened this picker.
    // Used inside the saveWithRetry body to detect a concurrent
    // /raid-add-roster session that committed first against the same bible
    // roster (race the command-time guard can't catch). Empty Set is
    // a no-op skip — preserves behavior if a future caller forgets
    // to populate session.bibleNames.
    const bibleNameSet = session.bibleNames instanceof Set
      ? session.bibleNames
      : new Set();
    let savedAccount;
    await saveWithRetry(async () => {
      let userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) {
        userDoc = new User({ discordId: session.discordId, accounts: [] });
      }
      ensureFreshWeek(userDoc);
      const normalizedSeed = normalizeName(session.seedCharName);
      let account = userDoc.accounts.find((item) => {
        if (normalizeName(item.accountName) === normalizedSeed) return true;
        const chars = Array.isArray(item.characters) ? item.characters : [];
        if (chars.some((character) => normalizeName(getCharacterName(character)) === normalizedSeed)) return true;
        return chars.some((character) => rosterNameSet.has(normalizeName(getCharacterName(character))));
      });

      // Race-safe overlap guard: re-check, with the freshest userDoc, that
      // no OTHER account already covers the bible roster we're about to
      // create/merge into. Skip the account we identified above as our
      // target — that's where merging is supposed to happen and any
      // overlap there is by design. Catches the case where two
      // /raid-add-roster sessions opened pickers concurrently (both passed
      // the command-time guard against an empty user doc), then the
      // first session committed an account that the second session can
      // no longer ignore.
      if (bibleNameSet.size > 0) {
        const collidingAccount = userDoc.accounts.find((item) => {
          if (account && item === account) return false;
          const chars = Array.isArray(item.characters) ? item.characters : [];
          return chars.some((character) =>
            bibleNameSet.has(normalizeName(getCharacterName(character)))
          );
        });
        if (collidingAccount) {
          const err = new Error(
            `Roster đã được saved ở account '${collidingAccount.accountName}' (concurrent /raid-add-roster session committed first).`
          );
          err.code = "RACE_DUP_ROSTER";
          err.collidingAccountName = collidingAccount.accountName;
          throw err;
        }
      }

      if (!account) {
        // When the caller is a Manager acting on behalf of another user
        // (`actingForOther`), stamp `registeredBy` with the caller's
        // discordId so /raid-set can later authorize that Manager to keep
        // maintaining the registered user's progress without re-checking
        // the live Manager role. Self-add path leaves `registeredBy` null.
        // We only set this on a brand-new account; an existing account's
        // `registeredBy` is preserved (the merge branch below) so a
        // different Manager re-running /raid-add-roster against an already-
        // registered roster cannot silently take over the helper slot.
        const newAccount = {
          accountName: session.seedCharName,
          characters: [],
        };
        if (session.actingForOther && session.callerId) {
          newAccount.registeredBy = session.callerId;
        }
        userDoc.accounts.push(newAccount);
        account = userDoc.accounts[userDoc.accounts.length - 1];
      }
      const existingMap = new Map(
        account.characters.map((character) => [normalizeName(getCharacterName(character)), character])
      );
      account.characters = selectedChars.map((character) => {
        const existing = existingMap.get(normalizeName(character.charName));
        const record = buildCharacterRecord(
          {
            ...(existing ? existing.toObject?.() ?? existing : {}),
            name: character.charName,
            class: character.className,
            itemLevel: character.itemLevel,
            combatScore: character.combatScore,
          },
          existing?.id || createCharacterId()
        );
        return preserveExistingCharacterState(record, existing);
      });
      // Stamp the refresh timestamp so /raid-status lazy-refresh treats this
      // account as fresh for the cooldown window and skips a redundant fetch.
      account.lastRefreshedAt = Date.now();
      await userDoc.save();
      savedAccount = {
        accountName: account.accountName,
        characters: account.characters.map((character) => ({
          name: getCharacterName(character),
          class: getCharacterClass(character),
          itemLevel: Number(character.itemLevel) || 0,
          combatScore: character.combatScore || "",
        })),
      };
    });
    return savedAccount;
  }

  function clearSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expireTimer) {
      clearTimeout(session.expireTimer);
      session.expireTimer = null;
    }
    sessions.delete(sessionId);
    return session;
  }

  async function handleSessionTimeout(sessionId, interaction) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    session.expireTimer = null;
    try {
      await interaction.editReply({
        embeds: [buildExpiredEmbed(session)],
        components: [],
      });
    } catch (err) {
      // Original message could be deleted, channel gone, etc. Nothing
      // to do — the in-memory session is already cleaned up.
      console.warn(
        `[add-roster] timeout edit failed for session ${sessionId}: ${err?.message || err}`
      );
    }
  }

  async function handleAddRosterCommand(interaction) {
    const callerId = interaction.user.id;
    // Slash invoker (Manager or self-add user) sees every reply on this
    // command in their own locale — including the Manager-target
    // onboarding ephemeral, which is the Manager's reply that *mentions*
    // the target. Target's separate DM uses their own lang (resolved in
    // tryDeliverTargetDM).
    const lang = await getUserLanguage(callerId, { UserModel: User });
    const seedCharName = interaction.options.getString("name", true).trim();

    // Target option: Raid Manager onboarding for lazy members. When the
    // caller specifies `target`, we save the roster under THAT user's
    // discordId instead of the caller's. Manager-gated because letting
    // any user write to any other user's roster doc would let members
    // grief each other (overwrite progress, add fake chars).
    const targetUser = interaction.options.getUser("target");
    let discordId = callerId;
    let actingForOther = false;
    if (targetUser && targetUser.id !== callerId) {
      if (typeof isManagerId !== "function" || !isManagerId(callerId)) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: t("raid-add-roster.auth.managerOnlyTitle", lang),
              description: t("raid-add-roster.auth.managerOnlyDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (targetUser.bot) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-add-roster.auth.botTargetTitle", lang),
              description: t("raid-add-roster.auth.botTargetDescription", lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      discordId = targetUser.id;
      actingForOther = true;
    }

    // Reject if this roster is already saved under this Discord user.
    // Seed name matches either an existing account name or any stored
    // character name → block the add. Users who want to refresh a saved
    // roster should remove it first, per Traine's explicit preference.
    const existingUser = await User.findOne({ discordId }).lean();
    if (existingUser && Array.isArray(existingUser.accounts)) {
      const normalizedSeed = normalizeName(seedCharName);
      const matched = existingUser.accounts.find((account) => {
        if (normalizeName(account.accountName) === normalizedSeed) return true;
        const chars = Array.isArray(account.characters) ? account.characters : [];
        return chars.some((c) => normalizeName(getCharacterName(c)) === normalizedSeed);
      });
      if (matched) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-add-roster.duplicate.preFetchTitle", lang),
              description: t("raid-add-roster.duplicate.preFetchDescription", lang, {
                accountName: matched.accountName,
              }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
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
    const bibleNameSet = new Set(
      rosterCharacters.map((c) => normalizeName(c.charName))
    );

    if (existingUser && Array.isArray(existingUser.accounts)) {
      const collidingAccount = existingUser.accounts.find((account) => {
        const chars = Array.isArray(account.characters) ? account.characters : [];
        return chars.some((c) =>
          bibleNameSet.has(normalizeName(getCharacterName(c)))
        );
      });
      if (collidingAccount) {
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
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

    // CP-sorted (highest first) so the picker shows the most-played
    // chars at the top by default. We only cap at PICKER_MAX_OPTIONS
    // (Discord 5-row limit minus the Confirm/Cancel row) which is
    // well above any real roster size.
    const sortedChars = [...rosterCharacters].sort((a, b) => {
      const aCombat = parseCombatScore(a.combatScore);
      const bCombat = parseCombatScore(b.combatScore);
      const combatDiff = bCombat - aCombat;
      if (combatDiff !== 0) return combatDiff;
      return b.itemLevel - a.itemLevel;
    });
    const displayChars = sortedChars.slice(0, PICKER_MAX_OPTIONS);
    const truncated = sortedChars.length > PICKER_MAX_OPTIONS;

    const sessionId = newSessionId();
    // Default selection: every char shown. Matches Traine's intent
    // ("user này chơi toàn bộ"). Users with alts they don't play
    // toggle them off via the per-char buttons before confirming.
    const selectedIndices = new Set(displayChars.map((_, i) => i));

    const session = {
      sessionId,
      callerId,
      lang,
      targetId: targetUser?.id || null,
      discordId,
      actingForOther,
      seedCharName,
      // Snapshot of the FULL bible roster's normalized char names from
      // this fetch — feeds the race-safe overlap guard inside
      // persistSelectedRoster. NOT just the displayed (capped) chars
      // because two sessions on the same bible roster could each truncate
      // to different windows yet still represent the same roster.
      bibleNames: bibleNameSet,
      chars: displayChars.map((c) => ({
        charName: c.charName,
        className: c.className,
        itemLevel: c.itemLevel,
        combatScore: c.combatScore,
      })),
      selectedIndices,
      expireTimer: null,
    };
    sessions.set(sessionId, session);

    if (truncated) {
      console.warn(
        `[add-roster] roster ${seedCharName} has ${sortedChars.length} chars; truncated to ${PICKER_MAX_OPTIONS} for picker.`
      );
    }

    await interaction.editReply({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    });

    session.expireTimer = setTimeout(
      () => handleSessionTimeout(sessionId, interaction),
      SESSION_TTL_MS
    );
  }

  // Auth gate shared by select + button paths: only the original
  // command caller can manipulate or confirm their own session. Manager
  // who used `target:` is still the caller; the target user can't click
  // anything on the picker.
  async function authorizeSession(interaction, session) {
    if (interaction.user.id !== session.callerId) {
      // Render denial in clicker's locale, not the session owner's.
      const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
      return interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: t("raid-add-roster.auth2.notYourPickerTitle", clickerLang),
            description: t("raid-add-roster.auth2.notYourPickerDescription", clickerLang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
    return null;
  }

  async function handleAddRosterButton(interaction) {
    // CustomId shape: `add-roster:<action>:<sessionId>` for confirm/cancel,
    // `add-roster:toggle:<sessionId>:<charIndex>` for per-char toggle.
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const sessionId = parts[2];
    const session = sessions.get(sessionId);
    if (!session) {
      // Stale session — resolve clicker lang since session is gone.
      const clickerLang = await getUserLanguage(interaction.user.id, { UserModel: User });
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "muted",
            title: t("raid-add-roster.expired.staleSessionTitle", clickerLang),
            description: t("raid-add-roster.expired.staleSessionDescription", clickerLang),
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const denied = await authorizeSession(interaction, session);
    if (denied) return;

    if (action === "toggle") {
      const charIndex = Number(parts[3]);
      if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= session.chars.length) {
        // Stale customId from a prior session shape; ignore silently
        // by acking the interaction. Avoids "interaction failed".
        await interaction.deferUpdate().catch(() => {});
        return;
      }
      if (session.selectedIndices.has(charIndex)) {
        session.selectedIndices.delete(charIndex);
      } else {
        session.selectedIndices.add(charIndex);
      }
      await interaction.update({
        embeds: [buildSelectionEmbed(session)],
        components: buildSelectionComponents(session),
      });
      return;
    }

    if (action === "cancel") {
      clearSession(sessionId);
      await interaction.update({
        embeds: [buildCancelledEmbed(session)],
        components: [],
      });
      return;
    }

    if (action === "confirm") {
      if (session.selectedIndices.size === 0) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-add-roster.confirm.noSelectionTitle", session.lang),
              description: t("raid-add-roster.confirm.noSelectionDescription", session.lang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Pull selected chars in display order (sorted ascending by
      // index = CP-rank order) so the saved-embed list reads naturally.
      const selectedChars = Array.from(session.selectedIndices)
        .sort((a, b) => a - b)
        .map((i) => session.chars[i]);

      // Cap at MAX_CHARACTERS_PER_ACCOUNT defensively. The picker is
      // already capped at PICKER_MAX_OPTIONS but a future change could
      // raise that without reviewing the storage cap, so guard here too.
      if (selectedChars.length > MAX_CHARACTERS_PER_ACCOUNT) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: t("raid-add-roster.confirm.capExceededTitle", session.lang),
              description: t("raid-add-roster.confirm.capExceededDescription", session.lang, {
                cap: MAX_CHARACTERS_PER_ACCOUNT,
                count: selectedChars.length,
              }),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Defer the component update before the DB write — saveWithRetry
      // can take longer than the 3s ack window if Mongo is slow. Using
      // deferUpdate keeps the picker on screen while we work, then
      // editReply swaps it for the final saved embed.
      await interaction.deferUpdate();
      clearSession(sessionId);

      let savedAccount;
      try {
        savedAccount = await persistSelectedRoster(session, selectedChars);
      } catch (err) {
        // Race-detected duplicate (a concurrent /raid-add-roster session
        // committed first against the same bible roster). Friendly
        // hint + steer to /raid-edit-roster instead of a generic error.
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
      // primary notification (cleaner, persistent in target's inbox);
      // channel ping below stays as both audit proof + fallback when
      // DMs are blocked.
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
