const { buildNoticeEmbed } = require("../raid/shared");

function createRaidSetCommand(deps) {
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
    getRaidRequirementList,
    RAID_REQUIREMENT_MAP,
    getGatesForRaid,
    ensureAssignedRaids,
    normalizeAssignedRaid,
    getGateKeys,
    toModeLabel,
  } = deps;

// Finds a character by name inside a user doc. Optional `rosterName` narrows
  // the search to a single account (accountName match) so /raid-set with the
  // new roster field can disambiguate same-named characters across rosters.
  // Without roster (e.g. text-monitor parser which only has the char name),
  // falls back to first-by-iteration match - same behavior as before.
  function findCharacterInUser(userDoc, characterName, rosterName = null) {
    if (!userDoc || !Array.isArray(userDoc.accounts)) return null;
    const target = normalizeName(characterName);
    const rosterTarget = rosterName ? normalizeName(rosterName) : null;
    for (const account of userDoc.accounts) {
      if (rosterTarget && normalizeName(account.accountName) !== rosterTarget) continue;
      const chars = Array.isArray(account.characters) ? account.characters : [];
      for (const character of chars) {
        if (normalizeName(getCharacterName(character)) === target) return character;
      }
    }
    return null;
  }
  // Autocomplete for the /raid-set `roster` option - lists user's accounts
  // (rosters) with char count suffix so picker can see roster size at a glance.
  // Same format as /remove-roster's roster autocomplete for visual consistency.
  async function autocompleteRaidSetRoster(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const userDoc = await loadUserForAutocomplete(discordId);
    if (!userDoc || !Array.isArray(userDoc.accounts)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const choices = userDoc.accounts
      .filter((a) => !needle || normalizeName(a.accountName).includes(needle))
      .slice(0, 25)
      .map((a) => {
        const chars = Array.isArray(a.characters) ? a.characters : [];
        const label = `📁 ${a.accountName} · ${chars.length} char${chars.length === 1 ? "" : "s"}`;
        return {
          name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
          value: a.accountName.length > 100 ? a.accountName.slice(0, 100) : a.accountName,
        };
      });
    await interaction.respond(choices).catch(() => {});
  }
  // Character autocomplete for /raid-set. Reads the upstream `roster` option
  // (now required) and filters to just that account's chars - sidesteps the
  // Discord 25-result cap when the user has 5+ rosters worth of characters
  // (~30+ total), which the flat "top 25 by iLvl" approach silently truncated.
  async function autocompleteRaidSetCharacter(interaction, focused) {
    const needle = normalizeName(focused.value || "");
    const rosterInput = interaction.options.getString("roster") || "";
    const discordId = interaction.user.id;
    const userDoc = await loadUserForAutocomplete(discordId);
    if (!userDoc || !Array.isArray(userDoc.accounts)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    // Source accounts: roster-filtered if user has already picked one, else
    // all accounts (so the field works even before roster is filled - Discord
    // autocomplete fires per-keystroke regardless of fill order).
    const rosterTarget = rosterInput ? normalizeName(rosterInput) : null;
    const accounts = rosterTarget
      ? userDoc.accounts.filter((a) => normalizeName(a.accountName) === rosterTarget)
      : userDoc.accounts;
    const entries = [];
    const seen = new Set();
    for (const account of accounts) {
      const chars = Array.isArray(account.characters) ? account.characters : [];
      for (const character of chars) {
        const name = getCharacterName(character);
        const normalized = normalizeName(name);
        if (!name || seen.has(normalized)) continue;
        if (needle && !normalized.includes(needle)) continue;
        seen.add(normalized);
        entries.push({
          name,
          className: getCharacterClass(character),
          itemLevel: Number(character.itemLevel) || 0,
        });
      }
    }
    entries.sort((a, b) => b.itemLevel - a.itemLevel || a.name.localeCompare(b.name));
    const choices = entries.slice(0, 25).map((entry) => {
      const label = `${entry.name} · ${entry.className} · ${entry.itemLevel}`;
      return {
        name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
        value: entry.name.length > 100 ? entry.name.slice(0, 100) : entry.name,
      };
    });
    await interaction.respond(choices).catch(() => {});
  }
  function computeRaidProgress(character, req) {
    const assignedRaids = ensureAssignedRaids(character);
    const assigned = assignedRaids[req.raidKey] || {};
    const rawGates = getGateKeys(assigned);
    const allGates = rawGates.length > 0 ? rawGates : getGatesForRaid(req.raidKey);
    const total = allGates.length;
    const storedDifficulty = assigned?.G1?.difficulty || assigned?.G2?.difficulty || "Normal";
    const sameDifficulty = normalizeName(storedDifficulty) === normalizeName(toModeLabel(req.modeKey));
    const done = sameDifficulty
      ? allGates.filter((g) => Number(assigned?.[g]?.completedDate) > 0).length
      : 0;
    const isComplete = total > 0 && done === total;
    let icon;
    if (isComplete) icon = UI.icons.done;
    else if (done > 0) icon = UI.icons.partial;
    else icon = UI.icons.pending;
    return { done, total, isComplete, icon };
  }
  async function autocompleteRaidSetRaid(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    const characterInput = interaction.options.getString("character") || "";
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const allRaids = getRaidRequirementList();
    const renderPlain = () =>
      allRaids
        .filter((req) => !needle || normalizeName(req.label).includes(needle))
        .slice(0, 25)
        .map((req) => ({
          name: `${req.label} · ${req.minItemLevel}+`,
          value: `${req.raidKey}_${req.modeKey}`,
        }));
    if (!characterInput) {
      await interaction.respond(renderPlain()).catch(() => {});
      return;
    }
    const userDoc = await loadUserForAutocomplete(discordId);
    // Pass rosterInput so same-named chars across rosters resolve to the
    // roster the user actually picked, not just first-by-iteration.
    const character = findCharacterInUser(userDoc, characterInput, rosterInput || null);
    if (!character) {
      await interaction.respond(renderPlain()).catch(() => {});
      return;
    }
    const itemLevel = Number(character.itemLevel) || 0;
    const choices = [];
    for (const req of allRaids) {
      if (itemLevel < req.minItemLevel) continue;
      if (needle && !normalizeName(req.label).includes(needle)) continue;
      const { done, total, isComplete, icon } = computeRaidProgress(character, req);
      const base = `${icon} ${req.label} · ${done}/${total}`;
      choices.push({
        name: isComplete ? `${base} · DONE` : base,
        value: `${req.raidKey}_${req.modeKey}`,
      });
      if (choices.length >= 25) break;
    }
    await interaction.respond(choices).catch(() => {});
  }
  async function autocompleteRaidSetStatus(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    const characterInput = interaction.options.getString("character") || "";
    const raidValue = interaction.options.getString("raid") || "";
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const baseChoices = [
      { name: "Complete - mark the whole raid as done", value: "complete" },
      { name: "Process - mark one specific gate as done (requires gate)", value: "process" },
      { name: "Reset - clear all gates back to 0", value: "reset" },
    ];
    const applyFilter = (list) =>
      list.filter((c) => !needle || normalizeName(c.name).includes(needle));
    const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
    if (!characterInput || !raidMeta) {
      await interaction.respond(applyFilter(baseChoices)).catch(() => {});
      return;
    }
    const userDoc = await loadUserForAutocomplete(discordId);
    const character = findCharacterInUser(userDoc, characterInput, rosterInput || null);
    if (!character) {
      await interaction.respond(applyFilter(baseChoices)).catch(() => {});
      return;
    }
    const { isComplete } = computeRaidProgress(character, raidMeta);
    const choices = isComplete
      ? [{ name: "Reset (raid đã hoàn thành - chỉ có thể reset)", value: "reset" }]
      : baseChoices;
    await interaction.respond(applyFilter(choices)).catch(() => {});
  }
  async function autocompleteRaidSetGate(interaction, focused) {
    const raidValue = interaction.options.getString("raid") || "";
    const statusValue = interaction.options.getString("status") || "";
    const needle = normalizeName(focused.value || "");
    if (statusValue !== "process") {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const raidMeta = RAID_REQUIREMENT_MAP[raidValue];
    if (!raidMeta) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const gates = getGatesForRaid(raidMeta.raidKey);
    const choices = gates
      .filter((g) => !needle || normalizeName(g).includes(needle))
      .map((g) => ({ name: g, value: g }));
    await interaction.respond(choices).catch(() => {});
  }
  async function handleRaidSetAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name === "roster") {
        await autocompleteRaidSetRoster(interaction, focused);
        return;
      }
      if (focused?.name === "character") {
        await autocompleteRaidSetCharacter(interaction, focused);
        return;
      }
      if (focused?.name === "raid") {
        await autocompleteRaidSetRaid(interaction, focused);
        return;
      }
      if (focused?.name === "status") {
        await autocompleteRaidSetStatus(interaction, focused);
        return;
      }
      if (focused?.name === "gate") {
        await autocompleteRaidSetGate(interaction, focused);
        return;
      }
      await interaction.respond([]).catch(() => {});
    } catch (error) {
      console.error("[autocomplete] raid-set error:", error?.message || error);
      await interaction.respond([]).catch(() => {});
    }
  }
  /**
   * Core raid-set write path shared by `/raid-set` and the channel-monitor
   * text handler. Given a Discord user id and a raid/gate target, load the
   * user doc, find the single first-by-iteration character match, enforce
   * iLvl eligibility, wipe the raid on difficulty switch, and write the
   * gate(s). Returns a status object the caller can render into whatever
   * surface it owns (slash-command embed, message reaction, log line).
   *
   * Returns:
   *   { noRoster?, matched, updated, ineligibleItemLevel, modeResetCount }
   */
  async function applyRaidSetForDiscordId({
    discordId,
    characterName,
    rosterName = null,
    raidMeta,
    statusType,
    effectiveGates,
  }) {
    const gateList = Array.isArray(effectiveGates) ? effectiveGates.filter(Boolean) : [];
    const selectedDifficulty = toModeLabel(raidMeta.modeKey);
    let noRoster = false;
    let updatedCount = 0;
    let matchedCount = 0;
    let ineligibleItemLevel = 0;
    let modeResetCount = 0;
    let alreadyComplete = false;
    let alreadyReset = false;
    // The properly-cased character name from the roster - user's input may
    // be lowercase (especially from the text-channel parser which lowercases
    // for alias matching), but the embed should show the name the way the
    // owner registered it.
    let displayName = "";
    await saveWithRetry(async () => {
      // Reset outer counters on each retry attempt so VersionError retries
      // start from a clean slate of status flags.
      noRoster = false;
      updatedCount = 0;
      matchedCount = 0;
      ineligibleItemLevel = 0;
      modeResetCount = 0;
      alreadyComplete = false;
      alreadyReset = false;
      displayName = "";
      const userDoc = await User.findOne({ discordId });
      if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
        // No roster at all - single-read detection inside retry, so we
        // avoid a duplicate pre-check findOne and stay consistent if the
        // document is created concurrently.
        noRoster = true;
        return;
      }
      ensureFreshWeek(userDoc);
      // Resolve exactly ONE character. When rosterName is provided (slash
      // command path, required field), scope the lookup to that roster so
      // same-named chars across rosters don't collide. When null (text-
      // monitor parser path), fall back to first-by-iteration match.
      const character = findCharacterInUser(userDoc, characterName, rosterName);
      if (!character) return;
      matchedCount = 1;
      displayName = getCharacterName(character);
      const charItemLevel = Number(character.itemLevel) || 0;
      if (charItemLevel < raidMeta.minItemLevel) {
        ineligibleItemLevel = charItemLevel;
        return;
      }
      const now = Date.now();
      const normalizedSelectedDiff = normalizeName(selectedDifficulty);
      const officialGateList = getGatesForRaid(raidMeta.raidKey);
      const assignedRaids = ensureAssignedRaids(character);
      const raidData = normalizeAssignedRaid(
        assignedRaids[raidMeta.raidKey] || {},
        selectedDifficulty,
        raidMeta.raidKey
      );
      let modeChangeDetected = false;
      for (const g of officialGateList) {
        const existingDiff = raidData[g]?.difficulty;
        if (existingDiff && normalizeName(existingDiff) !== normalizedSelectedDiff) {
          modeChangeDetected = true;
          break;
        }
      }
      if (modeChangeDetected) {
        for (const g of officialGateList) {
          raidData[g] = { difficulty: selectedDifficulty, completedDate: undefined };
        }
        modeResetCount = 1;
      }
      const gateKeys = gateList.length > 0 ? gateList : getGateKeys(raidData);
      const shouldMarkDone = statusType === "complete" || statusType === "process";
      // Short-circuit if the requested mark-done is a complete no-op: every
      // target gate already has completedDate > 0 for the selected difficulty,
      // and there's no mode-switch in play. Without this check the caller
      // would silently re-stamp timestamps and surface a fresh "Raid
      // Completed" DM - confusing the user into thinking a fresh clear was
      // recorded. Skip the write and let the handler surface a specific
      // "already DONE" notice.
      if (shouldMarkDone && !modeChangeDetected) {
        const everyTargetAlreadyDone = gateKeys.length > 0 && gateKeys.every((g) => {
          const entry = raidData[g];
          if (!entry) return false;
          if (!(Number(entry.completedDate) > 0)) return false;
          const entryDiff = normalizeName(entry.difficulty || "");
          return !entryDiff || entryDiff === normalizedSelectedDiff;
        });
        if (everyTargetAlreadyDone) {
          alreadyComplete = true;
          return;
        }
      }
      // Symmetric short-circuit for reset: if no mode-change would fire AND
      // every target gate is already unstamped (completedDate missing or 0),
      // the reset is a pure no-op. Without this, applyRaidSetForDiscordId
      // re-writes { completedDate: null } on top of already-null gates, still
      // returns updated: true, and the /raid-check Edit DM ends up telling
      // the member "Artist vừa Reset về 0" for a raid they never touched.
      // Codex flagged this after the Edit DM landed.
      if (!shouldMarkDone && !modeChangeDetected) {
        const everyTargetAlreadyEmpty = gateKeys.length === 0 || gateKeys.every((g) => {
          const entry = raidData[g];
          return !entry || !(Number(entry.completedDate) > 0);
        });
        if (everyTargetAlreadyEmpty) {
          alreadyReset = true;
          return;
        }
      }
      for (const gate of gateKeys) {
        raidData[gate] = {
          difficulty: selectedDifficulty,
          completedDate: shouldMarkDone ? now : null,
        };
      }
      assignedRaids[raidMeta.raidKey] = raidData;
      character.assignedRaids = assignedRaids;
      if (!character.name) character.name = getCharacterName(character);
      if (!character.class) character.class = getCharacterClass(character);
      if (!character.id) character.id = createCharacterId();
      updatedCount = 1;
      await userDoc.save();
    });
    return {
      noRoster,
      matched: matchedCount > 0,
      updated: updatedCount > 0,
      alreadyComplete,
      alreadyReset,
      ineligibleItemLevel,
      modeResetCount,
      selectedDifficulty,
      displayName,
    };
  }
  async function handleRaidSetCommand(interaction) {
    const discordId = interaction.user.id;
    const rosterName = interaction.options.getString("roster", true).trim();
    const characterName = interaction.options.getString("character", true).trim();
    const raidKey = interaction.options.getString("raid", true);
    const statusType = interaction.options.getString("status", true);
    const targetGate = interaction.options.getString("gate") || "";
    const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
    if (!raidMeta) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Raid option không hợp lệ",
            description: "Pick raid trong dropdown autocomplete nhé - Artist chỉ hiểu các raid có trong list cố định.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!["complete", "reset", "process"].includes(statusType)) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Status không hợp lệ",
            description: "Artist chỉ hiểu 3 status: `complete` (mark cả raid), `process` (mark 1 gate), `reset` (xoá hết). Pick một trong autocomplete nhé.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const effectiveGate = statusType === "process" ? targetGate : "";
    if (statusType === "process") {
      if (!targetGate) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "`process` cần chọn gate",
              description: "Status `process` để mark 1 gate cụ thể, Artist cần biết gate nào (G1, G2, ...). Nếu muốn mark cả raid done, đổi sang status `complete` thay nha.",
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const validGates = getGatesForRaid(raidMeta.raidKey);
      if (!validGates.includes(targetGate)) {
        await interaction.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Gate không tồn tại",
              description: `Gate **${targetGate}** không có trong **${raidMeta.label}** đâu nha. Gates hợp lệ: ${validGates.map((g) => `\`${g}\``).join(", ")}.`,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
    // /raid-set slash command keeps explicit single-gate semantics - admin
    // power-user surface needs the ability to mark exactly one gate without
    // cascading to earlier ones (edge cases like fixing a bad record).
    const result = await applyRaidSetForDiscordId({
      discordId,
      characterName,
      rosterName,
      raidMeta,
      statusType,
      effectiveGates: effectiveGate ? [effectiveGate] : [],
    });
    if (result.noRoster) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Cậu chưa có roster nào",
            description: "Artist không thấy roster nào của cậu. Dùng `/add-roster` để add roster đầu tiên trước, sau đó mới `/raid-set` được nha~",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!result.matched) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy character",
            description: `Artist không tìm thấy character **${characterName}** trong roster **${rosterName}** của cậu. Lần sau dùng autocomplete (gõ field \`character:\` rồi đợi gợi ý) để tránh sai tên nha.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (result.alreadyComplete) {
      const scope = effectiveGate ? `${raidMeta.label} · ${effectiveGate}` : raidMeta.label;
      const alreadyEmbed = new EmbedBuilder()
        .setColor(UI.colors.progress)
        .setTitle(`${UI.icons.info} Đã DONE từ trước rồi`)
        .setDescription(`**${characterName}** đã clear **${scope}** tuần này rồi, không update lại. Nếu cậu muốn reset, đổi \`status\` sang \`reset\` và chạy lại nhé.`)
        .addFields(
          { name: "Character", value: `**${characterName}**`, inline: true },
          { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
          { name: "Gate", value: effectiveGate || "All gates", inline: true },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [alreadyEmbed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (result.alreadyReset) {
      const scope = effectiveGate ? `${raidMeta.label} · ${effectiveGate}` : raidMeta.label;
      const alreadyResetEmbed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`${UI.icons.info} Raid này vốn đã sạch rồi`)
        .setDescription(`**${characterName}** ở **${scope}** chưa có gate nào được đánh dấu xong cả, Artist chẳng có gì để xoá cho cậu đâu~ Nếu cậu muốn đánh dấu gate xong xuôi thì đổi \`status\` sang \`complete\` hoặc \`process\` rồi chạy lại giúp tớ nha.`)
        .addFields(
          { name: "Character", value: `**${characterName}**`, inline: true },
          { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
          { name: "Gate", value: effectiveGate || "Toàn bộ gate", inline: true },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [alreadyResetEmbed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (!result.updated) {
      // By this point noRoster / matched / alreadyComplete / alreadyReset are
      // all handled. The only remaining not-updated branch is ineligible iLvl.
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Character chưa đủ iLvl",
            description: `**${characterName}** đang ở iLvl **${result.ineligibleItemLevel}**, chưa đủ **${raidMeta.minItemLevel}+** để vào **${raidMeta.label}**. Lên gear thêm rồi chạy lại nha~`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const markedDone = statusType === "complete" || statusType === "process";
    const titleText =
      statusType === "process" ? "Gate Completed" :
      statusType === "complete" ? "Raid Completed" :
      "Raid Reset";
    const resultEmbed = new EmbedBuilder()
      .setTitle(`${markedDone ? UI.icons.done : UI.icons.reset} ${titleText}`)
      .setColor(markedDone ? UI.colors.success : UI.colors.muted)
      .addFields(
        { name: "Character", value: `**${characterName}**`, inline: true },
        { name: "Raid", value: `**${raidMeta.label}**`, inline: true },
        { name: "Gates", value: effectiveGate || "All gates", inline: true },
      )
      .setTimestamp();
    if (result.modeResetCount > 0) {
      resultEmbed.setFooter({
        text: `Switched difficulty to ${result.selectedDifficulty} - previous mode progress cleared for a consistent state.`,
      });
    }
    await interaction.reply({ embeds: [resultEmbed], flags: MessageFlags.Ephemeral });
  }
  return {
    handleRaidSetAutocomplete,
    handleRaidSetCommand,
    applyRaidSetForDiscordId,
  };
}

module.exports = {
  createRaidSetCommand,
};
