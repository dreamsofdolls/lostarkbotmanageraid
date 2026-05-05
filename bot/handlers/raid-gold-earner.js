"use strict";

const crypto = require("crypto");
const {
  buildNoticeEmbed,
  normalizeName,
} = require("../utils/raid/shared");
const {
  getRosterMatches,
  truncateChoice,
} = require("../utils/raid/autocomplete-helpers");

// Picker session window: from /raid-gold-earner invocation to Confirm
// click. After 5 minutes the in-memory session is dropped and the embed
// flips to "expired"; user must re-run the command. Mirrors the
// /add-roster + /edit-roster TTL so the muscle memory transfers.
const SESSION_TTL_MS = 5 * 60 * 1000;

// Hard cap from Lost Ark: a character only earns weekly gold if it's one
// of (up to) 6 chars an account has marked as gold-earners in-game. The
// picker enforces this cap visually (clicking a 7th unselected char is a
// no-op + a transient ephemeral notice) so the bot's totals never imply
// gold the player can't actually receive.
const GOLD_EARNER_CAP_PER_ACCOUNT = 6;

// Discord caps a message at 5 ActionRows. Reserve 1 row for Confirm +
// Cancel, leaving 4 rows × 5 buttons = 20 char slots. Real LA accounts
// max ~18 chars so 20 is comfortable; rosters beyond the cap get the
// CP-sorted prefix and a warning surfaced in the embed.
const PICKER_MAX_OPTIONS = 20;
const BUTTONS_PER_ROW = 5;

const CHECK_ICON = "💰";
const UNCHECK_ICON = "⬜";

function createRaidGoldEarnerCommand({
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  saveWithRetry,
  loadUserForAutocomplete,
}) {
  // Session cache lives in process memory only; bot restart drops every
  // in-flight picker. Acceptable - user can simply re-run the command.
  // Keyed by random sessionId so a user running /raid-gold-earner twice
  // gets two independent pickers; older one keeps working until its
  // 5-minute timer fires.
  const sessions = new Map();

  function newSessionId() {
    return crypto.randomBytes(8).toString("hex");
  }

  function expireSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    sessions.delete(sessionId);
    return session;
  }

  // Decide which char indices should be pre-checked when the picker
  // opens. If at least one char in the account already has
  // isGoldEarner=true, mirror that state verbatim (the user has already
  // configured this roster - don't second-guess them). Otherwise
  // (legacy data: every char `false` from the pre-flag-default-true
  // world), pre-check the top 6 by iLvl as a UX nudge so the user can
  // Confirm in one click instead of ticking 6 boxes manually.
  //
  // Tie-break on iLvl uses original index order (stable sort behavior of
  // Array.prototype.sort in V8) so identical iLvls don't shuffle on
  // repeat opens.
  function pickInitialSelection(chars) {
    const anyExisting = chars.some((c) => c.isGoldEarner);
    if (anyExisting) {
      return new Set(
        chars.map((c, i) => (c.isGoldEarner ? i : -1)).filter((i) => i >= 0)
      );
    }
    // Migration path: rank by iLvl desc, take top 6.
    const ranked = chars
      .map((c, i) => ({ i, itemLevel: Number(c.itemLevel) || 0 }))
      .sort((a, b) => b.itemLevel - a.itemLevel)
      .slice(0, GOLD_EARNER_CAP_PER_ACCOUNT);
    return new Set(ranked.map((r) => r.i));
  }

  function buildSelectionEmbed(session) {
    const lines = session.chars.map((c, i) => {
      const isSelected = session.selectedIndices.has(i);
      const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
      return `${marker} **${i + 1}.** ${c.name} · ${c.class} · iLvl \`${c.itemLevel}\``;
    });

    const overflow = session.overflowCount > 0
      ? `\n${UI.icons.warn} ${session.overflowCount} char ngoài cap ${PICKER_MAX_OPTIONS} không hiện ở picker (bỏ qua isGoldEarner sẽ giữ nguyên).`
      : "";

    const desc = [
      `Roster: **${session.accountName}**`,
      `Pick tối đa **${GOLD_EARNER_CAP_PER_ACCOUNT}** char nhận gold (LA cap 6 / account / tuần):`,
      "",
      ...lines,
      "",
      `Đang chọn: **${session.selectedIndices.size}** / ${GOLD_EARNER_CAP_PER_ACCOUNT}`,
      `${UI.icons.info} Phiên 5 phút - hết giờ sẽ tự huỷ. Bấm **Confirm** để lưu, **Cancel** để bỏ.${overflow}`,
    ];

    return new EmbedBuilder()
      .setTitle(`${CHECK_ICON} Chọn gold-earner cho ${session.accountName}`)
      .setDescription(desc.join("\n").slice(0, 4000))
      .setColor(UI.colors.neutral)
      .setFooter({ text: "Confirm trong 5 phút" });
  }

  function buildSelectionComponents(session) {
    const charRows = [];
    for (let rowStart = 0; rowStart < session.chars.length; rowStart += BUTTONS_PER_ROW) {
      const row = new ActionRowBuilder();
      const rowEnd = Math.min(rowStart + BUTTONS_PER_ROW, session.chars.length);
      for (let i = rowStart; i < rowEnd; i += 1) {
        const c = session.chars[i];
        const isSelected = session.selectedIndices.has(i);
        const marker = isSelected ? CHECK_ICON : UNCHECK_ICON;
        const baseLabel = `${marker} ${i + 1}. ${c.name}`;
        const label = baseLabel.length > 80 ? `${baseLabel.slice(0, 77)}...` : baseLabel;
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`gold-earner:toggle:${session.sessionId}:${i}`)
            .setLabel(label)
            .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
        );
      }
      charRows.push(row);
    }

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`gold-earner:confirm:${session.sessionId}`)
      .setLabel(`Confirm (${session.selectedIndices.size})`)
      .setStyle(ButtonStyle.Primary);

    const cancelBtn = new ButtonBuilder()
      .setCustomId(`gold-earner:cancel:${session.sessionId}`)
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
        `Roster **${session.accountName}**: phiên 5 phút đã hết, không có gì được lưu. Chạy lại \`/raid-gold-earner\` để thử lại nhé~`
      )
      .setColor(UI.colors.muted);
  }

  function buildCancelledEmbed(session) {
    return new EmbedBuilder()
      .setTitle(`${UI.icons.info} Đã huỷ`)
      .setDescription(
        `Roster **${session.accountName}**: không có gì được lưu. Chạy lại \`/raid-gold-earner\` khi cậu sẵn sàng.`
      )
      .setColor(UI.colors.muted);
  }

  function buildSavedEmbed(session, savedNames) {
    const previewSlice = savedNames.slice(0, GOLD_EARNER_CAP_PER_ACCOUNT);
    const value = previewSlice.length > 0
      ? previewSlice.map((n, i) => `${i + 1}. ${n}`).join("\n")
      : "_Không có gold-earner nào được chọn._";
    return new EmbedBuilder()
      .setTitle(`${CHECK_ICON} Đã lưu gold-earner`)
      .setDescription(
        `Roster **${session.accountName}**: ${savedNames.length}/${GOLD_EARNER_CAP_PER_ACCOUNT} char nhận gold tuần này. Mở \`/raid-status\` để xem rollup mới nha~`
      )
      .addFields({
        name: `Gold-earner (${savedNames.length})`,
        value,
        inline: false,
      })
      .setColor(UI.colors.success)
      .setTimestamp();
  }

  // ---------- Autocomplete (roster name) ----------

  async function handleRaidGoldEarnerAutocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      if (focused?.name !== "roster") {
        await interaction.respond([]).catch(() => {});
        return;
      }
      const userDoc = await loadUserForAutocomplete(interaction.user.id);
      const matches = getRosterMatches(userDoc, focused.value || "");
      const choices = matches.map((a) => {
        const charCount = Array.isArray(a.characters) ? a.characters.length : 0;
        const earnerCount = (a.characters || []).filter((c) => c.isGoldEarner).length;
        const label = `📁 ${a.accountName} · ${earnerCount}/${charCount} earner`;
        return truncateChoice(label, a.accountName);
      });
      await interaction.respond(choices).catch(() => {});
    } catch (error) {
      console.error("[autocomplete] raid-gold-earner error:", error?.message || error);
      await interaction.respond([]).catch(() => {});
    }
  }

  // ---------- Slash command entry ----------

  async function handleRaidGoldEarnerCommand(interaction) {
    const discordId = interaction.user.id;
    const rosterInput = interaction.options.getString("roster", true).trim();
    if (!rosterInput) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Cần option `roster`",
            description: "Gõ thêm field `roster:` rồi đợi autocomplete gợi ý nhé. Cậu chỉ chỉnh được roster của chính mình.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const userDoc = await User.findOne({ discordId });
    const accounts = Array.isArray(userDoc?.accounts) ? userDoc.accounts : [];
    const target = accounts.find(
      (a) => normalizeName(a.accountName) === normalizeName(rosterInput)
    );

    if (!target) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Không tìm thấy roster",
            description: `Artist không thấy roster **${rosterInput}** trong DB của cậu. Pick từ autocomplete hoặc dùng \`/raid-status\` để xem các roster đang có.`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const allChars = Array.isArray(target.characters) ? target.characters : [];
    if (allChars.length === 0) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Roster trống",
            description: `Roster **${target.accountName}** không có char nào. Add char qua \`/edit-roster\` trước rồi quay lại đây nhé~`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Cap to PICKER_MAX_OPTIONS by iLvl desc so the picker fits Discord's
    // 5-row component limit. Realistic LA rosters max ~18 chars so the
    // tail is rare; when it triggers, the off-window chars keep their
    // existing isGoldEarner state untouched (we only write to the chars
    // shown in the picker on Confirm).
    const sortedAll = [...allChars].sort(
      (a, b) => (Number(b.itemLevel) || 0) - (Number(a.itemLevel) || 0)
    );
    const pickerChars = sortedAll.slice(0, PICKER_MAX_OPTIONS).map((c) => ({
      id: c.id,
      name: c.name,
      class: c.class,
      itemLevel: Number(c.itemLevel) || 0,
      isGoldEarner: !!c.isGoldEarner,
    }));
    const overflowCount = Math.max(0, sortedAll.length - PICKER_MAX_OPTIONS);

    const sessionId = newSessionId();
    const session = {
      sessionId,
      callerId: discordId,
      accountName: target.accountName,
      chars: pickerChars,
      selectedIndices: pickInitialSelection(pickerChars),
      overflowCount,
      timer: null,
    };
    sessions.set(sessionId, session);

    await interaction.reply({
      embeds: [buildSelectionEmbed(session)],
      components: buildSelectionComponents(session),
      flags: MessageFlags.Ephemeral,
    });

    session.timer = setTimeout(async () => {
      const expired = expireSession(sessionId);
      if (!expired) return;
      try {
        await interaction.editReply({
          embeds: [buildExpiredEmbed(expired)],
          components: [],
        });
      } catch {
        // Token may have already expired - safe to ignore.
      }
    }, SESSION_TTL_MS);
  }

  // ---------- Button dispatch ----------

  async function handleRaidGoldEarnerButton(interaction) {
    // CustomId shapes:
    //   gold-earner:toggle:<sid>:<idx>
    //   gold-earner:confirm:<sid>
    //   gold-earner:cancel:<sid>
    const parts = String(interaction.customId || "").split(":");
    const action = parts[1];
    const sessionId = parts[2];
    const session = sessions.get(sessionId);

    if (!session) {
      // Stale button (session expired or bot restarted). Disable the
      // controls so the user doesn't keep clicking into nothing.
      await interaction.update({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: "Phiên đã hết",
            description: "Phiên picker này không còn active (hết 5 phút hoặc bot vừa restart). Chạy lại `/raid-gold-earner` nhé~",
          }),
        ],
        components: [],
      }).catch(() => {});
      return;
    }

    // Ownership guard: only the user who opened the picker can interact.
    // Sessions are caller-scoped and the reply is ephemeral so this is
    // mostly defense-in-depth, but cheap to enforce.
    if (interaction.user.id !== session.callerId) {
      await interaction.reply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "lock",
            title: "Không phải session của cậu",
            description: "Picker này thuộc về người khác. Mở session riêng bằng `/raid-gold-earner` của mình nhé.",
          }),
        ],
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    if (action === "toggle") {
      const idx = Number(parts[3]);
      if (!Number.isInteger(idx) || idx < 0 || idx >= session.chars.length) {
        await interaction.deferUpdate().catch(() => {});
        return;
      }
      const isSelected = session.selectedIndices.has(idx);
      if (isSelected) {
        session.selectedIndices.delete(idx);
      } else {
        // Cap-6 enforcement at toggle time. A 7th tick is rejected with
        // an ephemeral followup so the user understands why nothing
        // changed (silent no-op would feel like a broken button).
        if (session.selectedIndices.size >= GOLD_EARNER_CAP_PER_ACCOUNT) {
          await interaction.reply({
            embeds: [
              buildNoticeEmbed(EmbedBuilder, {
                type: "warn",
                title: `Đã chọn đủ ${GOLD_EARNER_CAP_PER_ACCOUNT} char`,
                description: `Lost Ark cap **${GOLD_EARNER_CAP_PER_ACCOUNT}** gold-earner / account / tuần. Bỏ tick 1 char khác trước đã rồi mới tick char này nha~`,
              }),
            ],
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
          return;
        }
        session.selectedIndices.add(idx);
      }

      await interaction.update({
        embeds: [buildSelectionEmbed(session)],
        components: buildSelectionComponents(session),
      }).catch(() => {});
      return;
    }

    if (action === "cancel") {
      expireSession(sessionId);
      await interaction.update({
        embeds: [buildCancelledEmbed(session)],
        components: [],
      }).catch(() => {});
      return;
    }

    if (action === "confirm") {
      // Persist isGoldEarner per char in the target account. Off-window
      // chars (overflowCount > 0 case) are NOT touched - we only write
      // to chars that appeared in the picker. This preserves the
      // semantic that the picker is the sole authority over what it
      // displayed and nothing else.
      const selectedIds = new Set(
        Array.from(session.selectedIndices).map((i) => session.chars[i]?.id).filter(Boolean)
      );
      const pickerCharIds = new Set(session.chars.map((c) => c.id));

      let savedNames = [];
      try {
        await saveWithRetry(async () => {
          const doc = await User.findOne({ discordId: session.callerId });
          if (!doc) return;
          const account = (doc.accounts || []).find(
            (a) => a.accountName === session.accountName
          );
          if (!account) return;
          const out = [];
          for (const character of account.characters || []) {
            if (!pickerCharIds.has(character.id)) continue; // off-window
            character.isGoldEarner = selectedIds.has(character.id);
            if (character.isGoldEarner) out.push(character.name);
          }
          // Maintain canonical ordering by iLvl desc for the saved
          // summary list so the embed matches what the picker showed.
          out.sort((a, b) => {
            const ai = (account.characters || []).find((c) => c.name === a)?.itemLevel || 0;
            const bi = (account.characters || []).find((c) => c.name === b)?.itemLevel || 0;
            return (Number(bi) || 0) - (Number(ai) || 0);
          });
          savedNames = out;
          await doc.save();
        });
      } catch (err) {
        console.error("[raid-gold-earner confirm] save failed:", err?.message || err);
        await interaction.update({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "warn",
              title: "Lưu thất bại",
              description: "Artist không lưu được vào DB lần này. Cậu thử lại sau vài giây giúp tớ nhé~",
            }),
          ],
          components: [],
        }).catch(() => {});
        return;
      }

      expireSession(sessionId);
      await interaction.update({
        embeds: [buildSavedEmbed(session, savedNames)],
        components: [],
      }).catch(() => {});
      return;
    }

    await interaction.deferUpdate().catch(() => {});
  }

  return {
    handleRaidGoldEarnerCommand,
    handleRaidGoldEarnerAutocomplete,
    handleRaidGoldEarnerButton,
    // Test seam: lets unit tests inspect picker session state without
    // exercising the full Discord interaction lifecycle.
    __test: {
      sessions,
      pickInitialSelection,
      GOLD_EARNER_CAP_PER_ACCOUNT,
      PICKER_MAX_OPTIONS,
    },
  };
}

module.exports = {
  createRaidGoldEarnerCommand,
  GOLD_EARNER_CAP_PER_ACCOUNT,
  PICKER_MAX_OPTIONS,
};
