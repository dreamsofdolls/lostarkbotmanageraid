"use strict";

const { randomUUID } = require("node:crypto");
const { getAccessibleAccounts } = require("../../services/access/access-control");
const { buildNoticeEmbed } = require("../../utils/raid/common/shared");

const PROFILE_SESSION_TTL_MS = 5 * 60 * 1000;
const profileSessions = new Map();

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function shortNumber(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : "0.0%";
}

function shortLabel(value, max = 28) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function sourceSummary(sources, limit = 3) {
  const lines = [...(sources || [])]
    .filter((source) => source?.name)
    .slice(0, limit)
    .map((source) => `${shortLabel(source.name)} ${pct(source.share)}`);
  return lines.length ? lines.join(", ") : "N/A";
}

function engravingSummary(engravings, limit = 5) {
  const lines = [...(engravings || [])]
    .filter((engraving) => engraving?.name)
    .slice(0, limit)
    .map((engraving) => `${shortLabel(engraving.name, 22)} ${engraving.level || 0}`);
  return lines.length ? lines.join(", ") : "N/A";
}

function arkPassiveSummary(arkPassive) {
  if (!arkPassive) return "N/A";
  const evolution = Number(arkPassive.evolution?.points) || 0;
  const enlightenment = Number(arkPassive.enlightenment?.points) || 0;
  const leap = Number(arkPassive.leap?.points) || 0;
  if (!evolution && !enlightenment && !leap) return "N/A";
  return `Evo ${evolution} / Enl ${enlightenment} / Leap ${leap}`;
}

function ratePct(value) {
  const n = Number(value) || 0;
  const normalized = n > 1 ? n / 100 : n;
  return pct(Math.max(0, Math.min(1, normalized)) * 100);
}

function attackStyleLabel(value) {
  if (value === "back") return "Back Attack";
  if (value === "front") return "Front Attack";
  return "Hit Master";
}

function score(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : "0.0";
}

function formatDateMs(ms) {
  const n = Number(ms) || 0;
  if (!n) return "chưa có";
  return `<t:${Math.floor(n / 1000)}:R>`;
}

function confidenceForLogs(logs) {
  const n = Number(logs) || 0;
  if (n >= 20) return "High";
  if (n >= 5) return "Medium";
  return "Low";
}

function charWeight(character) {
  const logs = Number(character?.stats?.encounters) || 0;
  if (logs >= 20) return 1;
  if (logs >= 5) return 0.8;
  if (logs > 0) return 0.5;
  return 0;
}

function weightedAverage(chars, pick) {
  let total = 0;
  let weightTotal = 0;
  for (const character of chars) {
    const w = charWeight(character);
    const value = Number(pick(character));
    if (!w || !Number.isFinite(value)) continue;
    total += value * w;
    weightTotal += w;
  }
  return weightTotal > 0 ? total / weightTotal : 0;
}

function flattenCharacters(entries) {
  const chars = [];
  for (const entry of entries || []) {
    for (const character of entry.characters || []) {
      chars.push({ ...character, _profileEntry: entry });
    }
  }
  return chars;
}

function aggregateCharacters(chars) {
  const list = Array.isArray(chars) ? chars : [];
  const dpsChars = list.filter((c) => c.role !== "support");
  const supportChars = list.filter((c) => c.role === "support");
  const logs = list.reduce((sum, c) => sum + (Number(c?.stats?.encounters) || 0), 0);
  const lastFightStart = Math.max(0, ...list.map((c) => Number(c?.stats?.lastFightStart) || 0));
  return {
    charCount: list.length,
    logs,
    lastFightStart,
    overall: weightedAverage(list, (c) => c?.scores?.overall),
    mvp: weightedAverage(list, (c) => c?.scores?.mvp),
    dpsOverall: weightedAverage(dpsChars, (c) => c?.scores?.overall),
    supportOverall: weightedAverage(supportChars, (c) => c?.scores?.overall),
    dpsCount: dpsChars.length,
    supportCount: supportChars.length,
  };
}

function pickTopChar(chars, scoreKey = "overall") {
  return [...(chars || [])]
    .filter((c) => Number(c?.scores?.[scoreKey]) > 0)
    .sort((a, b) => Number(b.scores[scoreKey]) - Number(a.scores[scoreKey]))[0] || null;
}

function getEntryLabel(entry) {
  if (entry.isOwn) return entry.accountName;
  return `${entry.ownerLabel || entry.ownerDiscordId} / ${entry.accountName}`;
}

async function buildAccessibleProfileEntries(viewerDiscordId, { RaidProfileSnapshot }) {
  const accessible = await getAccessibleAccounts(viewerDiscordId, { includeOwn: true });
  if (!accessible.length) return { accessible, entries: [] };

  const ownerIds = [...new Set(accessible.map((entry) => entry.ownerDiscordId).filter(Boolean))];
  const snapshots = await RaidProfileSnapshot.find({ discordId: { $in: ownerIds } }).lean();
  const snapshotByOwner = new Map(snapshots.map((snapshot) => [snapshot.discordId, snapshot]));
  const entries = [];

  for (const access of accessible) {
    const snapshot = snapshotByOwner.get(access.ownerDiscordId);
    if (!snapshot) continue;
    const account = (snapshot.accounts || []).find(
      (item) => normalizeName(item.accountName) === normalizeName(access.accountName)
    );
    if (!account || !Array.isArray(account.characters) || account.characters.length === 0) continue;
    entries.push({
      ownerDiscordId: access.ownerDiscordId,
      ownerLabel: access.ownerLabel,
      accessLevel: access.accessLevel,
      isOwn: !!access.isOwn,
      accountName: account.accountName || access.accountName,
      generatedAt: snapshot.generatedAt,
      receivedAt: snapshot.receivedAt,
      source: snapshot.source || "local",
      characters: account.characters,
    });
  }

  return { accessible, entries };
}

function buildOverallEmbed({ EmbedBuilder, UI }, session) {
  const chars = flattenCharacters(session.entries);
  const agg = aggregateCharacters(chars);
  const topOverall = pickTopChar(chars, "overall");
  const topMvp = pickTopChar(chars, "mvp");
  const embed = new EmbedBuilder()
    .setColor(UI.colors.neutral)
    .setTitle("Raid Profile")
    .setDescription([
      "Nguồn: local encounters.db profile snapshot.",
      "Chỉ tính boss raid đang được RaidManage hỗ trợ, clear thành công, duration > 3 phút.",
    ].join("\n"))
    .addFields(
      {
        name: "Tổng quan",
        value: [
          `Roster: **${session.entries.length}**`,
          `Character: **${agg.charCount}**`,
          `Log hợp lệ: **${agg.logs}**`,
          `Lần mới nhất: ${formatDateMs(agg.lastFightStart)}`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Điểm tổng hợp",
        value: [
          `Overall: **${score(agg.overall)}**`,
          `MVP chance: **${score(agg.mvp)}**`,
          `DPS avg: **${agg.dpsCount ? score(agg.dpsOverall) : "N/A"}**`,
          `SUP avg: **${agg.supportCount ? score(agg.supportOverall) : "N/A"}**`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Top nổi bật",
        value: [
          topOverall ? `Overall: **${topOverall.name}** (${score(topOverall.scores.overall)})` : "Overall: N/A",
          topMvp ? `MVP: **${topMvp.name}** (${score(topMvp.scores.mvp)})` : "MVP: N/A",
        ].join("\n"),
        inline: false,
      }
    );

  const rosterLines = session.entries.slice(0, 10).map((entry, index) => {
    const rosterAgg = aggregateCharacters(entry.characters);
    const prefix = entry.isOwn ? "Own" : "Shared";
    return `\`${index + 1}.\` **${getEntryLabel(entry)}** · ${prefix} · ${rosterAgg.charCount} char · ${rosterAgg.logs} log · score ${score(rosterAgg.overall)}`;
  });
  embed.addFields({
    name: "Roster",
    value: rosterLines.length ? rosterLines.join("\n") : "Chưa có profile snapshot.",
    inline: false,
  });

  return embed;
}

function buildRosterEmbed({ EmbedBuilder, UI }, session, entry) {
  const agg = aggregateCharacters(entry.characters);
  const topOverall = pickTopChar(entry.characters, "overall");
  const embed = new EmbedBuilder()
    .setColor(entry.isOwn ? UI.colors.neutral : UI.colors.progress)
    .setTitle(`Raid Profile · ${entry.accountName}`)
    .setDescription([
      entry.isOwn
        ? "Roster của cậu."
        : `Roster được share bởi **${entry.ownerLabel || entry.ownerDiscordId}** (${entry.accessLevel}).`,
      `Snapshot: ${formatDateMs(entry.receivedAt || entry.generatedAt)}`,
    ].join("\n"))
    .addFields(
      {
        name: "Tổng quan roster",
        value: [
          `Character: **${agg.charCount}**`,
          `Log hợp lệ: **${agg.logs}**`,
          `Overall: **${score(agg.overall)}**`,
          `MVP chance: **${score(agg.mvp)}**`,
        ].join("\n"),
        inline: true,
      },
      {
        name: "Role split",
        value: [
          `DPS: **${agg.dpsCount}** · ${agg.dpsCount ? score(agg.dpsOverall) : "N/A"}`,
          `SUP: **${agg.supportCount}** · ${agg.supportCount ? score(agg.supportOverall) : "N/A"}`,
          topOverall ? `Top: **${topOverall.name}** (${score(topOverall.scores.overall)})` : "Top: N/A",
        ].join("\n"),
        inline: true,
      }
    );

  const lines = [...entry.characters]
    .sort((a, b) => Number(b?.scores?.overall || 0) - Number(a?.scores?.overall || 0))
    .slice(0, 12)
    .map((character, index) => {
      const role = character.role === "support" ? "SUP" : "DPS";
      const logs = Number(character?.stats?.encounters) || 0;
      return `\`${index + 1}.\` **${character.name}** · ${role} · ${logs} log · score ${score(character?.scores?.overall)} · MVP ${score(character?.scores?.mvp)}`;
    });
  embed.addFields({
    name: "Character",
    value: lines.length ? lines.join("\n") : "Roster này chưa có character snapshot.",
    inline: false,
  });

  return embed;
}

function buildCharacterEmbed({ EmbedBuilder, UI }, session, entry, character) {
  const stats = character.stats || {};
  const scores = character.scores || {};
  const isSupport = character.role === "support";
  const embed = new EmbedBuilder()
    .setColor(isSupport ? UI.colors.success : UI.colors.neutral)
    .setTitle(`Raid Profile · ${character.name}`)
    .setDescription([
      `Roster: **${getEntryLabel(entry)}**`,
      `Class: **${character.class || "Unknown"}** · iLvl **${character.itemLevel || 0}** · ${isSupport ? "SUP" : "DPS"}`,
      `Confidence: **${confidenceForLogs(stats.encounters)}** (${stats.encounters || 0} log)`,
    ].join("\n"))
    .addFields(
      {
        name: "Score",
        value: [
          `Overall: **${score(scores.overall)}**`,
          `MVP chance: **${score(scores.mvp)}**`,
          `Survival: **${score(scores.survival)}**`,
          `Consistency: **${score(scores.consistency)}**`,
        ].join("\n"),
        inline: true,
      },
      {
        name: isSupport ? "SUP detail" : "DPS detail",
        value: isSupport
          ? [
              `Uptime: **${score(scores.supportUptime)}**`,
              `Raid contribution: **${score(scores.raidContribution)}**`,
              `Protection: **${score(scores.protection)}**`,
              `Shield/min: **${shortNumber(stats.avgProtectionPerMinute)}**`,
              `Synergy/min: **${shortNumber(stats.avgSynergyGivenPerMinute)}**`,
              `AP/Brand: ${ratePct(stats.avgSupportAp)} / ${ratePct(stats.avgSupportBrand)}`,
              `Identity/Hyper: ${ratePct(stats.avgSupportIdentity)} / ${ratePct(stats.avgSupportHyper)}`,
            ].join("\n")
          : [
              `Avg DPS: **${shortNumber(stats.avgDps)}**`,
              `Median DPS: **${shortNumber(stats.medianDps)}**`,
              `Damage share: **${pct(stats.avgDamageShare)}**`,
              `Top rate: **${pct(stats.topRate)}**`,
            ].join("\n"),
        inline: true,
      },
      {
        name: "Combat shape",
        value: [
          `Style: **${attackStyleLabel(stats.attackStyle)}**`,
          `Crit: **${pct(stats.avgCritRate)}**`,
          `Back/Front: ${pct(stats.avgBackAttackRate)} / ${pct(stats.avgFrontAttackRate)}`,
          `Hyper share: **${pct(stats.avgHyperShare)}**`,
          `Skills/top share: **${score(stats.avgSkillCount)}** / ${pct(stats.avgTopSkillShare)}`,
          `SUP buff/debuff: ${pct(stats.avgSupportBuffedShare)} / ${pct(stats.avgSupportDebuffedShare)}`,
        ].join("\n"),
        inline: false,
      },
      {
        name: "Reliability",
        value: [
          `Deathless: **${pct(stats.deathlessRate)}**`,
          `Death rate: **${pct(stats.deathRate)}**`,
          `Deaths: **${Math.round(Number(stats.totalDeaths) || 0)}** total · avg ${score(stats.avgDeaths)}`,
          `Avg rank: **${score(stats.avgRank)}**`,
          `Counters/Stagger: **${score(stats.avgCounters)}** / ${shortNumber(stats.avgStaggerPerMinute)}/min`,
          `Taken/Shielded: ${shortNumber(stats.avgDamageTakenPerMinute)}/min / ${shortNumber(stats.avgShieldReceivedPerMinute)}/min`,
          `Incap: **${score(stats.avgIncapacitations)}** avg`,
          `Lần mới nhất: ${formatDateMs(stats.lastFightStart)}`,
        ].join("\n"),
        inline: false,
      }
    );

  embed.addFields({
    name: "Buff profile",
    value: [
      `Party attr buff/debuff: **${pct(stats.avgPartyBuffedShare)}** / **${pct(stats.avgPartyDebuffedShare)}**`,
      `Self attr / battle item: **${pct(stats.avgSelfBuffedShare)}** / **${pct(stats.avgBattleItemDebuffedShare)}**`,
      `Top buff: ${sourceSummary(character.topBuffSources)}`,
      `Top debuff: ${sourceSummary(character.topDebuffSources)}`,
      `Shield given: ${sourceSummary(character.topShieldGivenSources, 2)}`,
      `Shield received: ${sourceSummary(character.topShieldReceivedSources, 2)}`,
    ].join("\n"),
    inline: false,
  });

  const build = character.build || {};
  if (build.spec || build.gearScore || build.combatPower || build.engravings?.length || build.arkPassive) {
    embed.addFields({
      name: "Build",
      value: [
        `Spec: **${build.spec || "N/A"}**`,
        `Gear/CP: **${build.gearScore ? score(build.gearScore) : "N/A"}** / **${build.combatPower ? score(build.combatPower) : "N/A"}**`,
        `Ark passive: **${build.arkPassiveActive === null || build.arkPassiveActive === undefined ? "N/A" : build.arkPassiveActive ? "ON" : "OFF"}** / rate ${pct(stats.arkPassiveRate)}`,
        `Build variants: **${Math.round(Number(stats.buildVariantCount) || 0)}**`,
        `Engravings: ${engravingSummary(build.engravings)}`,
        `Ark points: ${arkPassiveSummary(build.arkPassive)}`,
      ].join("\n"),
      inline: false,
    });
  }

  const skillLines = [...(character.topSkills || [])]
    .slice(0, 5)
    .map((skill, index) => (
      `\`${index + 1}.\` **${skill.name || "Unknown"}** · ${pct(skill.share)} · crit ${pct(skill.critRate)}`
    ));
  if (skillLines.length) {
    embed.addFields({
      name: "Top skills",
      value: skillLines.join("\n"),
      inline: false,
    });
  }

  const raidLines = [...(character.raids || [])]
    .sort((a, b) => Number(b?.encounters || 0) - Number(a?.encounters || 0))
    .slice(0, 8)
    .map((raid) => {
      return `**${raid.raidKey} ${raid.modeKey}** · ${raid.boss || "?"} · ${raid.encounters || 0} log · DPS ${shortNumber(raid.medianDps)} · share ${pct(raid.avgDamageShare)} · top ${pct(raid.topRate)}`;
    });
  embed.addFields({
    name: "Raid breakdown",
    value: raidLines.length ? raidLines.join("\n") : "Chưa có breakdown đủ điều kiện.",
    inline: false,
  });

  return embed;
}

function selectOption(label, value, description, emoji, isDefault = false) {
  const option = {
    label: label.slice(0, 100) || "Unknown",
    value,
    default: isDefault,
  };
  if (description) option.description = description.slice(0, 100);
  if (emoji) option.emoji = emoji;
  return option;
}

function buildComponents(deps, session) {
  const {
    StringSelectMenuBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
  } = deps;
  const sid = session.id;
  const selectedEntry = session.rosterIndex >= 0 ? session.entries[session.rosterIndex] : null;
  const selectedChar = selectedEntry && session.charIndex >= 0
    ? selectedEntry.characters[session.charIndex]
    : null;

  const rosterOptions = [
    selectOption("Tổng quan", "overall", "Gộp toàn bộ roster có quyền xem", "📊", session.rosterIndex < 0),
    ...session.entries.slice(0, 24).map((entry, index) => {
      const agg = aggregateCharacters(entry.characters);
      return selectOption(
        getEntryLabel(entry),
        String(index),
        `${entry.isOwn ? "Own" : "Shared"} · ${agg.charCount} char · ${agg.logs} log`,
        entry.isOwn ? "📁" : "👥",
        session.rosterIndex === index
      );
    }),
  ];

  const rosterRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:roster:${sid}`)
      .setPlaceholder("Chọn roster...")
      .addOptions(rosterOptions)
  );

  const charOptions = selectedEntry
    ? [
        selectOption("Tổng quan roster", "overview", "Xem thống kê gộp của roster", "📁", session.charIndex < 0),
        ...selectedEntry.characters.slice(0, 24).map((character, index) => {
          const role = character.role === "support" ? "SUP" : "DPS";
          return selectOption(
            character.name,
            String(index),
            `${role} · ${character.stats?.encounters || 0} log · score ${score(character.scores?.overall)}`,
            role === "SUP" ? "🛡️" : "⚔️",
            session.charIndex === index
          );
        }),
      ]
    : [selectOption("Chọn roster trước", "disabled", "Dropdown này sẽ load character của roster", "📁", true)];

  const charRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`raid-profile:char:${sid}`)
      .setPlaceholder("Chọn character...")
      .setDisabled(!selectedEntry)
      .addOptions(charOptions)
  );

  const canPage = !!selectedEntry && selectedEntry.characters.length > 0;
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`raid-profile:prev:${sid}`)
      .setLabel("Trước")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage),
    new ButtonBuilder()
      .setCustomId(`raid-profile:overview:${sid}`)
      .setLabel(selectedChar ? "Tổng quan roster" : "Tổng quan")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!selectedEntry),
    new ButtonBuilder()
      .setCustomId(`raid-profile:next:${sid}`)
      .setLabel("Sau")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canPage)
  );

  return [rosterRow, charRow, buttonRow];
}

function renderSessionPayload(deps, session) {
  let embed;
  if (session.rosterIndex < 0) {
    embed = buildOverallEmbed(deps, session);
  } else {
    const entry = session.entries[session.rosterIndex];
    if (session.charIndex >= 0 && entry?.characters?.[session.charIndex]) {
      embed = buildCharacterEmbed(deps, session, entry, entry.characters[session.charIndex]);
    } else {
      embed = buildRosterEmbed(deps, session, entry);
    }
  }
  return {
    embeds: [embed],
    components: buildComponents(deps, session),
  };
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of profileSessions) {
    if (session.expiresAt <= now) profileSessions.delete(id);
  }
}

function getSessionForInteraction(interaction) {
  cleanupSessions();
  const parts = String(interaction.customId || "").split(":");
  const sid = parts[2];
  const session = profileSessions.get(sid);
  if (!session) return { action: parts[1], session: null };
  if (session.viewerDiscordId !== interaction.user?.id) {
    return { action: parts[1], session: null, forbidden: true };
  }
  session.expiresAt = Date.now() + PROFILE_SESSION_TTL_MS;
  return { action: parts[1], session };
}

function createRaidProfileCommand(deps) {
  const {
    EmbedBuilder,
    MessageFlags,
    UI,
    User,
    RaidProfileSnapshot,
  } = deps;

  const renderDeps = { ...deps, EmbedBuilder, UI };

  async function handleRaidProfileCommand(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const viewerDiscordId = interaction.user.id;
    const { accessible, entries } = await buildAccessibleProfileEntries(viewerDiscordId, {
      RaidProfileSnapshot,
    });

    if (!accessible.length) {
      await interaction.editReply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Chưa có roster",
            description: "Cậu cần `/raid-add-roster` trước, hoặc nhận roster share từ manager, rồi mở web companion để profile auto-sync đọc encounters.db.",
          }),
        ],
      });
      return;
    }

    if (!entries.length) {
      const userDoc = await User.findOne({ discordId: viewerDiscordId })
        .select("localSyncEnabled lastLocalProfileSyncAt lastLocalSyncAt")
        .lean()
        .catch(() => null);
      const hint = userDoc?.localSyncEnabled
        ? "Local-sync đang bật rồi. Mở Web Companion từ `/raid-status`, chọn/restore encounters.db, đợi dòng profile auto-sync báo xong rồi chạy lại `/raid-profile`."
        : "Bật `/raid-auto-manage action:local-on`, mở Web Companion, chọn encounters.db để tạo profile snapshot trước.";
      await interaction.editReply({
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "info",
            title: "Chưa có profile snapshot",
            description: hint,
          }),
        ],
      });
      return;
    }

    const sid = randomUUID();
    const session = {
      id: sid,
      viewerDiscordId,
      entries,
      rosterIndex: -1,
      charIndex: -1,
      expiresAt: Date.now() + PROFILE_SESSION_TTL_MS,
    };
    profileSessions.set(sid, session);
    await interaction.editReply(renderSessionPayload(renderDeps, session));
  }

  async function handleRaidProfileComponent(interaction) {
    const { action, session, forbidden } = getSessionForInteraction(interaction);
    if (!session) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          buildNoticeEmbed(EmbedBuilder, {
            type: "warn",
            title: forbidden ? "Không phải profile của cậu" : "Profile view đã hết hạn",
            description: forbidden
              ? "Component này thuộc phiên `/raid-profile` của người khác."
              : "Chạy lại `/raid-profile` để mở phiên mới.",
          }),
        ],
      });
      return;
    }

    if (interaction.isStringSelectMenu?.()) {
      const value = interaction.values?.[0] || "";
      if (action === "roster") {
        if (value === "overall") {
          session.rosterIndex = -1;
          session.charIndex = -1;
        } else {
          const idx = Number(value);
          if (Number.isInteger(idx) && session.entries[idx]) {
            session.rosterIndex = idx;
            session.charIndex = -1;
          }
        }
      } else if (action === "char") {
        if (value === "overview") {
          session.charIndex = -1;
        } else {
          const idx = Number(value);
          const entry = session.entries[session.rosterIndex];
          if (Number.isInteger(idx) && entry?.characters?.[idx]) {
            session.charIndex = idx;
          }
        }
      }
      await interaction.update(renderSessionPayload(renderDeps, session));
      return;
    }

    if (interaction.isButton?.()) {
      const entry = session.entries[session.rosterIndex];
      if (action === "overview") {
        if (session.rosterIndex >= 0) session.charIndex = -1;
        else session.rosterIndex = -1;
      } else if (entry?.characters?.length) {
        const total = entry.characters.length;
        const current = session.charIndex >= 0 ? session.charIndex : 0;
        if (action === "prev") session.charIndex = (current - 1 + total) % total;
        if (action === "next") session.charIndex = (current + 1) % total;
      }
      await interaction.update(renderSessionPayload(renderDeps, session));
    }
  }

  return {
    handleRaidProfileCommand,
    handleRaidProfileComponent,
    __test: {
      aggregateCharacters,
      buildAccessibleProfileEntries,
      renderSessionPayload,
    },
  };
}

module.exports = {
  createRaidProfileCommand,
};
