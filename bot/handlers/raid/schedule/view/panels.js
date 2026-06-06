/**
 * handlers/raid/schedule/panels.js
 * Ephemeral Discord payload builders for lead controls and schedule dashboards.
 * These stay separate from index.js so handlers can focus on interaction
 * lifecycle and persisted RaidEvent mutations.
 */

"use strict";

const { t } = require("../../../../services/i18n");
const { getRaidRequirementMap } = require("../../../../domain/raid-catalog");
const { assignSlots } = require("../../../../services/raid/schedule/slots");
const { shapeOwnedBoardOptions } = require("../../../../services/raid/schedule/owned-boards");
const {
  buildTurnPlanEmbed,
  buildSwitcherRow,
  renderGauge,
  STATUS_CODE,
} = require("./board");
const {
  clip,
  characterSelectOptions,
  signupSelectOptions,
} = require("./select-options");

function raidLabelFor(event) {
  const meta = getRaidRequirementMap()[`${event.raidKey}_${event.modeKey}`];
  return meta?.label || `${event.raidKey} ${event.modeKey}`;
}

function createSchedulePanelBuilders({
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  EmbedBuilder,
  UI,
  ephemeralFlag,
  noticeEmbed,
}) {
  function manageMenuPayload(event, lang) {
    const id = String(event._id);
    const locked = event.status === "locked";
    const configRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:${locked ? "unlock" : "lock"}:${id}`)
        .setLabel(t(locked ? "raid-schedule.btn.unlock" : "raid-schedule.btn.lock", lang))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`rse:setroom:${id}`)
        .setLabel(t("raid-schedule.btn.setRoom", lang))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`rse:edittime:${id}`)
        .setLabel(t("raid-schedule.btn.editTime", lang))
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`rse:notify:${id}`)
        .setLabel(t(event.skipNotify ? "raid-schedule.btn.notifyOff" : "raid-schedule.btn.notifyOn", lang))
        .setStyle(ButtonStyle.Secondary),
    );
    const peopleRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:teams:${id}`)
        .setLabel(t("raid-schedule.btn.teams", lang))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`rse:addmember:${id}`)
        .setLabel(t("raid-schedule.btn.addMember", lang))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rse:kick:${id}`)
        .setLabel(t("raid-schedule.btn.kick", lang))
        .setStyle(ButtonStyle.Danger),
    );
    const terminalRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:end:${id}`)
        .setLabel(t("raid-schedule.btn.end", lang))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`rse:cancel:${id}`)
        .setLabel(t("raid-schedule.btn.cancelEvent", lang))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`rse:delete:${id}`)
        .setLabel(t("raid-schedule.btn.deleteEvent", lang))
        .setStyle(ButtonStyle.Danger),
    );

    const slots = assignSlots(event.signups, { supSlots: event.supSlots, dpsSlots: event.dpsSlots });
    const compCount = slots.support.length + slots.dps.length;
    const gauge = renderGauge(compCount, event.partySize);
    const manageDesc = [
      `\`${raidLabelFor(event)} · ${STATUS_CODE[event.status] || ""}\``,
      `${gauge ? `${gauge}  ` : ""}**${compCount}/${event.partySize}** · ⏳ ${slots.waitlist.length}`,
      t("raid-schedule.notice.manageDescription", lang),
    ].join("\n");

    return {
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.notice.manageTitle", lang),
          manageDesc,
        ),
      ],
      components: [configRow, peopleRow, terminalRow],
      flags: ephemeralFlag,
    };
  }

  function deleteConfirmPayload(event, lang) {
    const id = String(event._id);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:delyes:${id}`)
        .setLabel(t("raid-schedule.btn.deleteConfirmYes", lang))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`rse:delno:${id}`)
        .setLabel(t("raid-schedule.btn.deleteConfirmNo", lang))
        .setStyle(ButtonStyle.Secondary),
    );
    return {
      embeds: [
        noticeEmbed(
          "danger",
          t("raid-schedule.notice.deleteConfirmTitle", lang),
          t("raid-schedule.notice.deleteConfirmDescription", lang),
        ),
      ],
      components: [row],
      flags: ephemeralFlag,
    };
  }

  function kickSelectPayload(event, lang) {
    const options = signupSelectOptions(event.signups, lang);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rse:kickpick:${event._id}`)
      .setPlaceholder(t("raid-schedule.kick.placeholder", lang))
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options);
    return {
      embeds: [
        noticeEmbed(
          "warn",
          t("raid-schedule.kick.title", lang),
          t("raid-schedule.kick.intro", lang),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
      flags: ephemeralFlag,
    };
  }

  function addUserSelectPayload(event, lang) {
    const select = new UserSelectMenuBuilder()
      .setCustomId(`rse:adduser:${event._id}`)
      .setPlaceholder(t("raid-schedule.addMember.userPlaceholder", lang))
      .setMinValues(1)
      .setMaxValues(1);
    return {
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.addMember.title", lang),
          t("raid-schedule.addMember.intro", lang),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
      flags: ephemeralFlag,
    };
  }

  function addCharSelectPayload(event, targetId, rows, lang) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rse:addpick:${targetId}:${event._id}`)
      .setPlaceholder(t("raid-schedule.addMember.charPlaceholder", lang))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(characterSelectOptions(rows, lang));
    return {
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.addMember.charTitle", lang),
          t("raid-schedule.addMember.charIntro", lang, { user: `<@${targetId}>` }),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
    };
  }

  function teamsPanelPayload(event, lang) {
    const turns = Array.isArray(event.turns) ? event.turns : [];
    const lines = turns.length
      ? turns
          .map((tn) => t("raid-schedule.teams.turnLine", lang, { name: tn.name, n: (tn.memberIds || []).length }))
          .join("\n")
      : t("raid-schedule.teams.none", lang);
    const options = turns.map((tn, i) => ({
      label: clip(tn.name, 100),
      value: String(i),
      description: clip(t("raid-schedule.teams.memberCount", lang, { n: (tn.memberIds || []).length }), 100),
    }));
    options.push({ label: t("raid-schedule.teams.newTurn", lang), value: "new" });
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rse:teamturn:${event._id}`)
        .setPlaceholder(t("raid-schedule.teams.pickTurn", lang))
        .addOptions(options.slice(0, 25)),
    );
    return {
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.teams.title", lang),
          `${t("raid-schedule.teams.intro", lang)}\n\n${lines}`,
        ),
      ],
      components: [row],
      flags: ephemeralFlag,
    };
  }

  function memberSelectPayload(event, turnIndex, lang) {
    const turn = event.turns[turnIndex];
    const current = new Set(turn.memberIds || []);
    const options = signupSelectOptions(event.signups, lang, current);
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rse:teammembers:${turnIndex}:${event._id}`)
      .setPlaceholder(clip(t("raid-schedule.teams.pickMembers", lang, { turn: turn.name }), 150))
      .setMinValues(0)
      .setMaxValues(options.length)
      .addOptions(options);
    return {
      embeds: [
        noticeEmbed(
          "info",
          t("raid-schedule.teams.assignTitle", lang, { turn: turn.name }),
          t("raid-schedule.teams.assignIntro", lang),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
    };
  }

  function turnPlanDashboardPayload(event, ownedEvents, lang) {
    const components = [];
    if (ownedEvents.length >= 2) {
      const rows = shapeOwnedBoardOptions(ownedEvents, String(event._id));
      components.push(buildSwitcherRow(String(event._id), rows, {
        ActionRowBuilder,
        StringSelectMenuBuilder,
        lang,
        action: "showtp",
        placeholderKey: "raid-schedule.show.tpSwitchPlaceholder",
      }));
    }
    return {
      embeds: [buildTurnPlanEmbed(event, { EmbedBuilder, UI, lang })],
      components,
      flags: ephemeralFlag,
    };
  }

  return {
    manageMenuPayload,
    deleteConfirmPayload,
    kickSelectPayload,
    addUserSelectPayload,
    addCharSelectPayload,
    teamsPanelPayload,
    memberSelectPayload,
    turnPlanDashboardPayload,
  };
}

module.exports = {
  createSchedulePanelBuilders,
  raidLabelFor,
};
