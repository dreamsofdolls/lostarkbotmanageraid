"use strict";

const RAID_LOG_TABS = Object.freeze({
  damage: "Damage", party_buffs: "Party Buffs", party_buffs_all: "Party Buffs · All",
  self_buffs: "Self Buffs", self_buffs_all: "Self Buffs · All",
  shields: "Shields · Given", shields_received: "Shields · Received",
  shields_blocked: "Shields · Total Blocked", shields_breakdown: "Shields · Blocked Breakdown",
  tanked: "Tanked", dps_average: "Charts · Average DPS", dps_10s: "Charts · 10s DPS",
});

const RAID_LOG_PLAYER_TABS = Object.freeze({
  damage: "Skill Damage", party_buffs: "Skill Party Buffs", party_buffs_all: "Skill Party Buffs · All",
  self_buffs: "Skill Self Buffs", self_buffs_all: "Skill Self Buffs · All", damage_category: "Damage · By Category",
});

const tabsForPlayer = (player, result) => player
  ? Object.fromEntries(Object.entries(RAID_LOG_PLAYER_TABS).filter(([key]) => key !== "damage_category" || result?.hasBreakdown !== false))
  : RAID_LOG_TABS;
const TAB_OPTIONS = Object.freeze({
  party_buffs: { button: "Party Buffs", allBuffs: false },
  party_buffs_all: { button: "Party Buffs", allBuffs: true },
  self_buffs: { button: "Self Buffs", allBuffs: false },
  self_buffs_all: { button: "Self Buffs", allBuffs: true },
  shields: { button: "Shields", sub: "Given" },
  shields_received: { button: "Shields", sub: "Received" },
  shields_blocked: { button: "Shields", sub: "Total Blocked" },
  shields_breakdown: { button: "Shields", sub: "Blocked Breakdown" },
  dps_average: { button: "Damage", chart: "Average DPS" },
  dps_10s: { button: "Damage", chart: "10s DPS Window" },
  damage_category: { button: "Damage", breakdown: "By Category" },
});
const captureTabOptions = tab => TAB_OPTIONS[tab] || { button: RAID_LOG_TABS[tab] };

module.exports = { RAID_LOG_TABS, RAID_LOG_PLAYER_TABS, tabsForPlayer, captureTabOptions };
