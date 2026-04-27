"use strict";

const crypto = require("crypto");
const { buildNoticeEmbed } = require("../raid/shared");
const {
  getRosterMatches,
  truncateChoice,
} = require("../raid/autocomplete-helpers");

// Same 5-min window as /add-roster picker. Long enough to read + decide,
// short enough that abandoned sessions don't pile up in memory.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Discord caps a message at 5 ActionRow components. The picker layout
// reserves 1 row for Confirm + Cancel buttons, leaving 4 rows for
// per-char toggle buttons at 5 buttons per row = 20 max chars in the
// picker. Matches the cap used by /add-roster's picker.
const PICKER_MAX_OPTIONS = 20;
const BUTTONS_PER_ROW = 5;

const CHECK_ICON = "✅";
const UNCHECK_ICON = "⬜";
const NEW_TAG = "🆕";
const STALE_TAG = "📦"; // saved locally but not in current bible roster

function createEditRosterCommand({
  EmbedBuilder,
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
  loadUserForAutocomplete,
  getPrimaryManagerId,
}) {
  // Used in error embeds to ping the primary admin (first entry of
  // RAID_MANAGER_ID env) by mention. Falls back to plain "admin"
  // text when no manager is configured.
  const adminMention = (() => {
    const id = typeof getPrimaryManagerId === "function" ? getPrimaryManagerId() : null;
    return id ? `<@${id}>` : "admin";
  })();
  // sessionId -> session state. Same shape/semantics as the /add-roster
  // sessions map: in-process only, dropped on bot restart, keyed by a
  // random 16-hex token so concurrent /edit-roster invocations don't
  // step on each other.
  const sessions = new Map();

  function newSessionId() {
    return crypto.randomBytes(8).toString("hex");
  }

  // Build the picker char list from saved + bible. Pure helper extracted
  // so the saved-first sort + truncation contract is unit-testable
  // without driving the full Discord handler. The saved-first ordering
  // is LOAD-BEARING: slice-to-cap must never bump a saved char out of
  // the displayed window because Confirm persists exactly the displayed
  // selection. Returns the displayed chars plus separate counts for
  // bible-only-overflow vs saved-overflow so the embed can warn the user
  // accurately and persistEditedRoster can preserve off-window saved
  // chars instead of silently dropping them on Confirm (legacy rosters
  // with > cap saved chars).
  function buildEditRosterPickerChars(savedChars, bibleChars, cap) {
    const savedMap = new Map(savedChars.map((c) => [normalizeName(c.name), c]));
    const bibleMap = new Map(bibleChars.map((c) => [normalizeName(c.charName), c]));
    const allKeys = new Set([...savedMap.keys(), ...bibleMap.keys()]);

    const merged = [];
    for (const key of allKeys) {
      const saved = savedMap.get(key);
      const bible = bibleMap.get(key);
      merged.push({
        charName: bible?.charName || saved.name,
        className: bible?.className || saved.class,
        itemLevel: bible?.itemLevel ?? saved.itemLevel,
        combatScore: bible?.combatScore || saved.combatScore,
        savedKey: saved ? key : null,
        inBible: !!bible,
      });
    }

    merged.sort((a, b) => {
      const aIsSaved = a.savedKey ? 1 : 0;
      const bIsSaved = b.savedKey ? 1 : 0;
      if (aIsSaved !== bIsSaved) return bIsSaved - aIsSaved;
      const cpDiff = parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore);
      if (cpDiff !== 0) return cpDiff;
      return (b.itemLevel || 0) - (a.itemLevel || 0);
    });

    const displayChars = merged.slice(0, cap);
    const excluded = merged.slice(cap);
    let excludedBibleOnlyCount = 0;
    let excludedSavedCount = 0;
    const excludedSavedKeys = new Set();
    for (const c of excluded) {
      if (c.savedKey) {
        excludedSavedCount += 1;
        excludedSavedKeys.add(c.savedKey);
      } else {
        excludedBibleOnlyCount += 1;
      }
    }
    return {
      merged,
      displayChars,
      excludedBibleOnlyCount,
      excludedSavedCount,
      excludedSavedKeys,
    };
  }

  // Multi-seed bible fetch with overlap reject. Builds a seed list from
  // the saved chars (highest-CP first) + accountName as last fallback,
  // then tries each seed sequentially. Skips any result that has ZERO
  // overlap with the saved roster — that's the signal the seed went
  // stale (in-game rename / different player's char with same name) and
  // bible returned someone else's roster, which we MUST NOT silently
  // merge into the picker. First seed with overlap wins. All seeds
  // failing or zero-overlap → `bibleError` set, caller falls back to
  // saved-only / remove-only mode.
  async function fetchBibleRosterWithFallback(savedChars, accountName) {
    const seeds = [];
    const sortedSaved = [...savedChars].sort(
      (a, b) => parseCombatScore(b.combatScore) - parseCombatScore(a.combatScore)
    );
    for (const c of sortedSaved) {
      if (c.name && !seeds.includes(c.name)) seeds.push(c.name);
    }
    if (accountName && !seeds.includes(accountName)) seeds.push(accountName);

    if (seeds.length === 0) {
      return { bibleChars: [], bibleError: "Không có seed để fetch bible." };
    }

    const savedNameSet = new Set(
      savedChars.map((c) => normalizeName(c.name)).filter(Boolean)
    );

    let lastError = null;
    let zeroOverlapHit = false;
    for (const seed of seeds) {
      try {
        const fetched = await fetchRosterCharacters(seed);
        if (!Array.isArray(fetched) || fetched.length === 0) continue;

        // Skip overlap check only when the saved roster is empty (no
        // way to verify the seed pointed at the right roster — but
        // there's also no risk of merging the wrong chars into a
        // populated picker).
        if (savedNameSet.size > 0) {
          const fetchedNames = new Set(
            fetched.map((c) => normalizeName(c.charName))
          );
          const hasOverlap = [...savedNameSet].some((n) => fetchedNames.has(n));
          if (!hasOverlap) {
            zeroOverlapHit = true;
            console.warn(
              `[edit-roster] seed "${seed}" returned ${fetched.length} chars but zero overlap with saved roster - trying next seed.`
            );
            continue;
          }
        }

        return { bibleChars: fetched, bibleError: null };
      } catch (err) {
        lastError = err?.message || String(err);
        console.warn(`[edit-roster] seed "${seed}" failed: ${lastError}`);
      }
    }

    return {
      bibleChars: [],
      bibleError:
        lastError ||
        (zeroOverlapHit
          ? "Mọi seed đều trả roster không trùng saved chars (rename in-game?)"
          : "Bible không trả về kết quả nào."),
    };
  }

  // Mirror /remove-roster's roster autocomplete: list the caller's saved
  // accounts with a char-count hint, fuzzy-filtered by what they've typed.
  async function handleEditRosterAutocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== "roster") {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const userDoc = await loadUserForAutocomplete(interaction.user.id);
    const matches = getRosterMatches(userDoc, focused.value || "");
    const choices = matches.map((a) => {
      const charCount = Array.isArray(a.characters) ? a.characters.length : 0;
      const label = `${UI.icons.folder} ${a.accountName} · ${charCount} char${charCount === 1 ? "" : "s"}`;
      return truncateChoice(label, a.accountName);
    });
    await interaction.respond(choices).catch(() => {});
  }

  function tagFor(c) {
    if (c.savedKey && !c.inBible) return STALE_TAG;
    if (!c.savedKey && c.inBible) return NEW_TAG;
    return "";
  }

  function buildSelectionEmbed(session) {
    // Char list shows stats + tag (🆕/📦) only — selection state lives
    // on the per-char toggle buttons below so embed and controls don't
    // duplicate the same ✅/⬜ marker visually.
    const lines = session.chars.map((c, i) => {
      const cp = c.combatScore || "?";
      const tag = tagFor(c);
      const tagSuffix = tag ? ` · ${tag}` : "";
      return `**${i + 1}.** ${c.charName} · ${c.className} · iLvl \`${c.itemLevel}\` · CP \`${cp}\`${tagSuffix}`;
    });

    const desc = [
      `Roster: **${session.accountName}**`,
      `Đang edit - bấm nút bên dưới để toggle ✅/⬜ chars muốn **giữ/add** vs **xoá**:`,
      "",
      ...lines,
      "",
      `Đang chọn: **${session.selectedIndices.size}** / ${session.chars.length}`,
    ];

    if (session.bibleError) {
      desc.push("");
      desc.push(
        `${UI.icons.warn} Bible offline (${session.bibleError}) - chỉ thấy char đã saved, không add char mới được. Thử lại sau khi bible up.`
      );
    } else {
      desc.push(
        `${UI.icons.info} ${NEW_TAG} = char mới có ở bible chưa được add · ${STALE_TAG} = char đã saved nhưng không còn ở bible (rename/private log?).`
      );
    }
    if (session.excludedSavedCount > 0) {
      desc.push("");
      desc.push(
        `${UI.icons.warn} Roster có saved chars vượt cap picker (${PICKER_MAX_OPTIONS}). **${session.excludedSavedCount}** saved char ngoài cửa sổ sẽ được giữ nguyên không thay đổi - cậu chỉ edit được top ${PICKER_MAX_OPTIONS} chars hiển thị thôi nha. Để dọn hẳn, dùng \`/remove-roster\` rồi \`/add-roster\` lại từ đầu.`
      );
    }
    if (session.excludedBibleOnlyCount > 0) {
      desc.push("");
      desc.push(
        `${UI.icons.warn} ${session.excludedBibleOnlyCount} char mới ở bible chưa hiện được do cap ${PICKER_MAX_OPTIONS} đầy. Toggle off saved char muốn xoá rồi Confirm trước, sau đó \`/edit-roster\` lần nữa để add tiếp char mới còn lại.`
      );
    }
    desc.push(
      `${UI.icons.info} Phiên 5 phút - hết giờ sẽ tự huỷ. Bấm **Confirm** để apply, **Cancel** để bỏ.`
    );

    return new EmbedBuilder()
      .setTitle(`${UI.icons.folder} Edit roster: ${session.accountName}`)
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: "Source: lostark.bible · Confirm trong 5 phút" });
  }

  function buildSelectionComponents(session) {
    // Per-char toggle buttons. See add-roster.js for the rationale —
    // dropdown was visually messy with default-selected pills wrapping.
    // Toggle button label carries the ✅/⬜ state, style flips between
    // Success (green) / Secondary (gray). Layout: 4 rows of up to 5
    // char buttons + 1 row of Confirm/Cancel. Discord 5-row hard cap.
    const charRows = [];
    for (let rowStart = 0; rowStart < session.chars.length; rowStart += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder();
      const rowEnd = Math.min(rowStart + BUTTONS_PER_ROW, session.chars.length);
      for (let i = rowStart; i < rowEnd; i += 1) {
        const c = session.chars[i];
        const isSelected = session.selectedIndices.has(i);
        const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
        const tag = tagFor(c);
        const tagSuffix = tag ? ` ${tag}` : "";
        const baseLabel = `${marker} ${i + 1}. ${c.charName}${tagSuffix}`;
        const label = baseLabel.length > 80 ? `${baseLabel.slice(0, 77)}...` : baseLabel;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`edit-roster:toggle:${session.sessionId}:${i}`)
            .setLabel(label)
            .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
        );
      }
      charRows.push(row);
    }

    // Color scheme: Success/Secondary are reserved for per-char toggle
    // buttons above. Confirm = Primary (blue), Cancel = Danger (red)
    // so the action row is visually distinct from the toggle row.
    const confirmBtn = new ButtonBuilder()
      .setCustomId(`edit-roster:confirm:${session.sessionId}`)
      .setLabel(`Confirm (${session.selectedIndices.size})`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(session.selectedIndices.size === 0);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`edit-roster:cancel:${session.sessionId}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Danger);

    return [
      ...charRows,
      new ActionRowBuilder().addComponents(confirmBtn, cancelBtn),
    ];
  }

  function buildExpiredEmbed(session) {
    return new EmbedBuilder()
      .setTitle(`${UI.icons.warn} Phiên đã hết hạn`)
      .setDescription(
        [
          `Roster: **${session.accountName}**`,
          "",
          `Phiên 5 phút đã hết và không có thay đổi nào được lưu. Chạy lại \`/edit-roster\` để thử lại nhé~`,
        ].join("\n")
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: "Source: lostark.bible" });
  }

  function buildCancelledEmbed(session) {
    return new EmbedBuilder()
      .setTitle(`${UI.icons.info} Đã huỷ`)
      .setDescription(
        [
          `Roster: **${session.accountName}**`,
          "",
          `Không có thay đổi nào được lưu. Chạy lại \`/edit-roster\` khi cậu sẵn sàng.`,
        ].join("\n")
      )
      .setColor(UI.colors.muted)
      .setFooter({ text: "Source: lostark.bible" });
  }

  function buildSavedEmbed(session, summary) {
    const { added, removed, kept, finalChars } = summary;
    const lines = finalChars.map(
      (c, i) =>
        `${i + 1}. ${c.name} · ${c.class} · \`${c.itemLevel}\` · \`${c.combatScore || "?"}\``
    );
    const diffParts = [];
    if (added.length) diffParts.push(`${added.length} added (${added.join(", ")})`);
    if (removed.length) diffParts.push(`${removed.length} removed (${removed.join(", ")})`);
    if (kept.length && !added.length && !removed.length) {
      diffParts.push(`${kept.length} unchanged (refreshed bible-side fields)`);
    }
    const diffLine = diffParts.length ? diffParts.join(" · ") : "Không có thay đổi";

    return new EmbedBuilder()
      .setTitle(`${UI.icons.folder} Roster Updated`)
      .setDescription(
        [
          `Roster: **${session.accountName}**`,
          `Diff: ${diffLine}`,
        ].join("\n")
      )
      .addFields({
        name: `Characters (${finalChars.length})`,
        value: lines.join("\n").slice(0, 1024) || "_(empty)_",
        inline: false,
      })
      .setColor(UI.colors.success)
      .setFooter({ text: "Source: lostark.bible" })
      .setTimestamp();
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
      console.warn(
        `[edit-roster] timeout edit failed for session ${sessionId}: ${err?.message || err}`
      );
    }
  }

  // The diff-apply save: fully replace account.characters[] based on the
  // user's selection, but preserve per-char state (raid completion,
  // bibleSerial/cid/rid, publicLogDisabled, tasks, sideTasks) on chars
  // that survive the edit by name match. New chars get a fresh id +
  // record. Removed chars are dropped entirely. Off-window saved chars
  // (legacy roster > picker cap, recorded in session.preservedSavedKeys)
  // were never displayed to the user, so they bypass the diff entirely
  // and are kept as-is at the head of account.characters.
  //
  // Returns a summary: which char names were added/removed/kept, plus
  // the final chars array for the embed.
  async function persistEditedRoster(session, selectedChars) {
    const summary = { added: [], removed: [], kept: [], finalChars: [] };
    const preservedKeys = session.preservedSavedKeys || new Set();

    await saveWithRetry(async () => {
      const userDoc = await User.findOne({ discordId: session.discordId });
      if (!userDoc) throw new Error("User document disappeared between command and confirm.");
      ensureFreshWeek(userDoc);

      const account = userDoc.accounts.find(
        (a) => normalizeName(a.accountName) === normalizeName(session.accountName)
      );
      if (!account) {
        throw new Error(`Roster '${session.accountName}' không còn tồn tại.`);
      }

      const existingMap = new Map(
        (account.characters || []).map((c) => [normalizeName(getCharacterName(c)), c])
      );

      const selectedNameSet = new Set(selectedChars.map((c) => normalizeName(c.charName)));

      // Reset diff (saveWithRetry can re-fire body — keep summary in sync
      // with the latest pass).
      summary.added = [];
      summary.removed = [];
      summary.kept = [];

      // Tally removals: chars previously in account but absent from the
      // user's selection. Off-window saved chars (preservedKeys) are
      // never on the picker so they cannot be selected, but they MUST
      // NOT be tallied as removals either - they survive untouched.
      for (const [key, oldChar] of existingMap.entries()) {
        if (preservedKeys.has(key)) continue;
        if (!selectedNameSet.has(key)) {
          summary.removed.push(getCharacterName(oldChar));
        }
      }

      // Off-window saved chars are appended as-is at the head of the
      // rebuilt characters array. Order matters less than identity here
      // (every other code path looks them up by name), but heading the
      // list keeps stable indices for the chars that did fit in the
      // picker.
      const preservedChars = [];
      for (const [key, oldChar] of existingMap.entries()) {
        if (preservedKeys.has(key)) preservedChars.push(oldChar);
      }

      const editedChars = selectedChars.map((character) => {
        const key = normalizeName(character.charName);
        const existing = existingMap.get(key);
        if (existing) {
          summary.kept.push(getCharacterName(existing));
        } else {
          summary.added.push(character.charName);
        }
        const existingPlain = existing ? existing.toObject?.() ?? existing : {};
        const record = buildCharacterRecord(
          {
            ...existingPlain,
            name: character.charName,
            class: character.className,
            itemLevel: character.itemLevel,
            combatScore: character.combatScore,
          },
          existing?.id || createCharacterId()
        );
        // buildCharacterRecord ships id/name/class/itemLevel/isGoldEarner/
        // combatScore/assignedRaids/tasks/sideTasks. It does NOT pass
        // through bible-side identifiers or the public-log flag, so
        // overlay them explicitly - without this, every Confirm would
        // wipe bibleSerial/cid/rid (forcing the next /raid-auto-manage
        // sync to re-resolve them via bible's SSR page, extra HTTP
        // round-trip per char) and forget publicLogDisabled (causing
        // the bot to re-attempt sync on chars known to have public log
        // off).
        if (existing) {
          if (existing.bibleSerial != null) record.bibleSerial = existing.bibleSerial;
          if (existing.bibleCid != null) record.bibleCid = existing.bibleCid;
          if (existing.bibleRid != null) record.bibleRid = existing.bibleRid;
          if (existing.publicLogDisabled !== undefined) {
            record.publicLogDisabled = existing.publicLogDisabled;
          }
        }
        return record;
      });

      account.characters = [...preservedChars, ...editedChars];

      // Stamp lastRefreshedAt: the bible fetch we just did to build the
      // picker is fresher than whatever was on the account, so /raid-status
      // lazy-refresh can skip a re-fetch for the cooldown window.
      account.lastRefreshedAt = Date.now();
      await userDoc.save();

      summary.finalChars = account.characters.map((character) => ({
        name: getCharacterName(character),
        class: getCharacterClass(character),
        itemLevel: Number(character.itemLevel) || 0,
        combatScore: character.combatScore || "",
      }));
    });

    return summary;
  }

  async function handleEditRosterCommand(interaction) {
    const callerId = interaction.user.id;
    const rosterArg = interaction.options.getString("roster", true).trim();

    const userDoc = await User.findOne({ discordId: callerId }).lean();
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Cậu chưa có roster nào",
            description: "Artist không thấy roster nào của cậu trong DB cả. Dùng `/add-roster` để add roster đầu tiên trước, sau đó mới `/edit-roster` được nha~",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetAccount = userDoc.accounts.find(
      (a) => normalizeName(a.accountName) === normalizeName(rosterArg)
    );
    if (!targetAccount) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy roster",
            description: `Artist không tìm thấy roster **${rosterArg}** trong DB của cậu. Lần sau dùng autocomplete (gõ field \`roster:\` rồi đợi dropdown gợi ý) cho chuẩn nha~`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Ephemeral: /edit-roster is a maintenance operation on the caller's
    // own roster — the picker, the diff outcome, and the bible-fetch
    // error states are all only meaningful to the caller. Showing them
    // in-channel would be channel noise + leak roster composition to
    // bystanders. Component interactions (Confirm/Cancel/select) work
    // identically on ephemeral messages, so the contract carries through
    // the whole 5-min session. Contrast with /add-roster, which stays
    // public on purpose so members can see new rosters being onboarded.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const savedChars = (targetAccount.characters || []).map((c) => ({
      name: getCharacterName(c),
      class: getCharacterClass(c),
      itemLevel: Number(c.itemLevel) || 0,
      combatScore: c.combatScore || "",
    }));

    // Multi-seed bible fetch with overlap check. Mirrors the safer
    // pattern in services/roster-refresh.js (collectStaleAccountRefreshes):
    // try each saved char + accountName as a seed in priority order;
    // skip results that have ZERO overlap with the saved roster (signals
    // the seed is stale / pointing at someone else's roster after an
    // in-game rename, and merging that data would silently fold an
    // unrelated roster's chars into the picker). Single-seed trust was
    // the bug Codex flagged.
    const { bibleChars, bibleError } = await fetchBibleRosterWithFallback(
      savedChars,
      targetAccount.accountName
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
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Roster trống và bible không trả về gì",
            description: [
              `Roster **${targetAccount.accountName}** không có char nào ở DB, bible cũng không fetch được kết quả.`,
              "",
              "Cậu có thể:",
              `• \`/remove-roster\` để xoá hẳn account trống này`,
              `• \`/add-roster\` để tạo lại từ seed char khác`,
            ].join("\n"),
          }),
        ],
      });
      return;
    }

    if (excludedBibleOnlyCount > 0 || excludedSavedCount > 0) {
      console.warn(
        `[edit-roster] roster ${targetAccount.accountName} merged ${merged.length} chars; excluded from picker (cap ${PICKER_MAX_OPTIONS}): ${excludedSavedCount} saved + ${excludedBibleOnlyCount} bible-only.`
      );
    }

    // Default selection = chars currently in saved roster. New bible
    // chars start unticked - user has to opt them in. Saved-not-in-bible
    // chars stay ticked so the default action is "preserve current state".
    const selectedIndices = new Set();
    displayChars.forEach((c, i) => {
      if (c.savedKey) selectedIndices.add(i);
    });

    const sessionId = newSessionId();
    const session = {
      sessionId,
      callerId,
      discordId: callerId,
      accountName: targetAccount.accountName,
      bibleError,
      excludedBibleOnlyCount,
      excludedSavedCount,
      // Off-window saved-char keys (legacy roster > picker cap). These chars
      // are not in the picker, so they cannot participate in the toggle
      // decision - persistEditedRoster preserves them as-is rather than
      // dropping them when rewriting account.characters from selectedChars.
      preservedSavedKeys: excludedSavedKeys,
      chars: displayChars.map((c) => ({
        charName: c.charName,
        className: c.className,
        itemLevel: c.itemLevel,
        combatScore: c.combatScore,
        savedKey: c.savedKey,
        inBible: c.inBible,
      })),
      selectedIndices,
      expireTimer: null,
    };
    sessions.set(sessionId, session);

    await interaction.editReply({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
    });

    session.expireTimer = setTimeout(
      () => handleSessionTimeout(sessionId, interaction),
      SESSION_TTL_MS
    );
  }

  function authorizeSession(interaction, session) {
    if (interaction.user.id !== session.callerId) {
      return interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: "Picker này không phải của cậu",
            description: "Chỉ người gõ lệnh `/edit-roster` mới điều khiển được picker đó nha. Cậu muốn edit roster của mình thì gõ `/edit-roster` riêng.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
    return null;
  }

  async function handleEditRosterButton(interaction) {
    // CustomId shape: `edit-roster:<action>:<sessionId>` for confirm/cancel,
    // `edit-roster:toggle:<sessionId>:<charIndex>` for per-char toggle.
    const parts = interaction.customId.split(":");
    const action = parts[1];
    const sessionId = parts[2];
    const session = sessions.get(sessionId);
    if (!session) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "muted",
            title: "Phiên đã hết hạn",
            description: "Phiên 5 phút đã trôi qua mất rồi. Chạy lại `/edit-roster` để Artist mở picker mới cho cậu nha~",
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
        // Reject 0-select with a hint sang /remove-roster - empty roster
        // is a different operation (cleanup the whole account) and has its
        // own dedicated command.
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Phải giữ ít nhất 1 char",
              description: `Cậu toggle off hết tất cả chars rồi - Artist không cho roster trống. Nếu cậu muốn xoá hẳn roster **${session.accountName}**, dùng \`/remove-roster\` (lệnh dành riêng cho việc xoá hẳn account).`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const selectedChars = Array.from(session.selectedIndices)
        .sort((a, b) => a - b)
        .map((i) => session.chars[i]);

      if (selectedChars.length > MAX_CHARACTERS_PER_ACCOUNT) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Vượt cap roster",
              description: `Mỗi roster Artist lưu được tối đa **${MAX_CHARACTERS_PER_ACCOUNT}** chars. Cậu đang chọn **${selectedChars.length}** - toggle off bớt vài char rồi Confirm lại nhé.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferUpdate();
      clearSession(sessionId);

      let summary;
      try {
        summary = await persistEditedRoster(session, selectedChars);
      } catch (err) {
        console.error(`[edit-roster] persist failed:`, err);
        await interaction.editReply({
          content: null,
          components: [],
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "error",
              title: "Lưu roster fail",
              description: `Artist lưu thay đổi không xong: ${err?.message || err}\n\nThử lại sau vài giây nhé. Nếu lặp lại nhiều lần ping ${adminMention} giúp Artist debug~`,
            }),
          ],
        });
        return;
      }

      await interaction.editReply({
        embeds: [buildSavedEmbed(session, summary)],
        components: [],
        allowedMentions: { parse: [] },
      });
    }
  }

  return {
    handleEditRosterAutocomplete,
    handleEditRosterCommand,
    handleEditRosterButton,
    // Internals exposed for unit tests in test/edit-roster.test.js. Not
    // part of the public contract.
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
