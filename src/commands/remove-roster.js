const { buildNoticeEmbed } = require("../raid/shared");

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
  async function autocompleteRemoveRosterCharacter(interaction, focused) {
    const rosterInput = interaction.options.getString("roster") || "";
    if (!rosterInput) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const needle = normalizeName(focused.value || "");
    const discordId = interaction.user.id;
    const userDoc = await loadUserForAutocomplete(discordId);
    if (!userDoc || !Array.isArray(userDoc.accounts)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const normalizedRoster = normalizeName(rosterInput);
    const account = userDoc.accounts.find(
      (a) => normalizeName(a.accountName) === normalizedRoster
    );
    if (!account || !Array.isArray(account.characters)) {
      await interaction.respond([]).catch(() => {});
      return;
    }
    const choices = account.characters
      .filter((c) => {
        const name = normalizeName(getCharacterName(c));
        return name && (!needle || name.includes(needle));
      })
      .slice(0, 25)
      .map((c) => {
        const name = getCharacterName(c);
        const cls = getCharacterClass(c);
        const iLvl = Number(c.itemLevel) || 0;
        const label = `${name} · ${cls} · ${iLvl}`;
        return {
          name: label.length > 100 ? `${label.slice(0, 97)}...` : label,
          value: name.length > 100 ? name.slice(0, 100) : name,
        };
      });
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
    if (action !== "remove_roster" && action !== "remove_char") {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Action không hợp lệ",
            description: "Artist chỉ hiểu `remove_roster` (xoá cả account) hoặc `remove_char` (xoá 1 char). Pick trong dropdown nhé~",
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
            title: "Cần chọn `character`",
            description: "Action **Remove a single character** cần option `character` để Artist biết xoá ai. Gõ thêm field `character:` rồi đợi autocomplete gợi ý nhé.",
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
          .setTitle(`${UI.icons.info} No Roster`)
          .setDescription(`Cậu chưa có roster nào để xóa. Dùng \`/add-roster\` trước nhé.`);
        return;
      }
      const normalizedRoster = normalizeName(rosterName);
      const accountIndex = userDoc.accounts.findIndex(
        (a) => normalizeName(a.accountName) === normalizedRoster
      );
      if (accountIndex === -1) {
        replyEmbed = new EmbedBuilder()
          .setColor(UI.colors.danger)
          .setTitle(`${UI.icons.warn} Roster Not Found`)
          .setDescription(`Không tìm thấy roster **${rosterName}** trong data của cậu.`);
        return;
      }
      const account = userDoc.accounts[accountIndex];
      if (action === "remove_roster") {
        const removedCount = Array.isArray(account.characters) ? account.characters.length : 0;
        userDoc.accounts.splice(accountIndex, 1);
        await userDoc.save();
        // Description-driven layout (no cold field table). Artist voice
        // states what happened + reminds the user the action is
        // reversible via /add-roster, so the destructive `danger` color
        // is balanced by a recovery hint in the copy.
        const charPart =
          removedCount === 0
            ? "(account không có character nào)"
            : `cùng **${removedCount}** character${removedCount === 1 ? "" : "s"}`;
        replyEmbed = new EmbedBuilder()
          .setColor(UI.colors.danger)
          .setTitle(`🗑️ Đã xoá roster`)
          .setDescription(
            [
              `Artist vừa dọn sạch roster **${account.accountName}** ${charPart} khỏi DB của cậu.`,
              "",
              `Tất cả tiến độ raid trong account này không còn nữa. Muốn add lại thì chạy \`/add-roster name:<tên-char>\` để Artist mở picker mới nha~`,
            ].join("\n")
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
          .setTitle(`${UI.icons.warn} Character Not Found`)
          .setDescription(`Không tìm thấy character **${characterName}** trong roster **${account.accountName}**.`);
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
          ? "Roster giờ trống — cậu có thể `/remove-roster` để xoá hẳn account, hoặc `/edit-roster` để add lại chars mới."
          : `Roster **${account.accountName}** còn lại **${remaining}** character${remaining === 1 ? "" : "s"}.`;
      const embed = new EmbedBuilder()
        .setColor(UI.colors.muted)
        .setTitle(`🗑️ Đã xoá character`)
        .setDescription(
          [
            `Artist vừa xoá **${characterName}** khỏi roster **${account.accountName}** nha.`,
            "",
            remainingPart,
          ].join("\n")
        )
        .setTimestamp();
      if (reseededTo) {
        embed.setFooter({
          text: `Seed roster đổi sang "${reseededTo}" để /raid-status refresh tiếp tục hoạt động.`,
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
