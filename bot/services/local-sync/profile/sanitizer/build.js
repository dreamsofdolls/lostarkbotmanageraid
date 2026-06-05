"use strict";

const {
  MAX_ARK_PASSIVE_NODES_PER_TREE,
  MAX_ENGRAVINGS_PER_CHAR,
} = require("./constants");
const {
  clampNumber,
  cleanShortString,
} = require("./common");

function cleanEngraving(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = cleanShortString(raw.name, 80);
  if (!name) return null;
  return {
    id: cleanShortString(raw.id, 32),
    name,
    level: clampNumber(raw.level, { max: 10 }),
    isClass: !!raw.isClass,
  };
}

function cleanArkPassiveSummary(raw) {
  if (!raw || typeof raw !== "object") return null;
  const cleanNode = (value) => {
    if (!value || typeof value !== "object") return null;
    const id = Math.round(clampNumber(value.id, { max: 9999999 }));
    const level = Math.round(clampNumber(value.level ?? value.lv, { max: 100 }));
    if (!id || !level) return null;
    return {
      id,
      level,
      name: cleanShortString(value.name, 96),
      tier: Math.round(clampNumber(value.tier, { max: 10 })),
      position: Math.round(clampNumber(value.position, { max: 100 })),
      maxLevel: Math.round(clampNumber(value.maxLevel, { max: 100 })),
      points: clampNumber(value.points, { max: 1000 }),
    };
  };
  const cleanTree = (value) => {
    const nodes = (Array.isArray(value?.nodes) ? value.nodes : [])
      .slice(0, MAX_ARK_PASSIVE_NODES_PER_TREE)
      .map(cleanNode)
      .filter(Boolean);
    const tree = {
      count: clampNumber(value?.count, { max: 100, fallback: nodes.length }),
      points: clampNumber(value?.points, { max: 1000 }),
      spentPoints: clampNumber(value?.spentPoints, { max: 1000 }),
      nodes,
    };
    const spec = cleanShortString(value?.spec, 80);
    if (spec) tree.spec = spec;
    return tree;
  };
  return {
    evolution: cleanTree(raw.evolution),
    enlightenment: cleanTree(raw.enlightenment),
    leap: cleanTree(raw.leap),
  };
}

function cleanBuild(raw) {
  if (!raw || typeof raw !== "object") return {};
  return {
    classId: clampNumber(raw.classId, { max: 999999 }),
    spec: cleanShortString(raw.spec, 80),
    gearScore: clampNumber(raw.gearScore, { max: 9999 }),
    combatPower: clampNumber(raw.combatPower),
    arkPassiveActive: raw.arkPassiveActive === null || raw.arkPassiveActive === undefined
      ? null
      : !!raw.arkPassiveActive,
    engravings: (Array.isArray(raw.engravings) ? raw.engravings : [])
      .slice(0, MAX_ENGRAVINGS_PER_CHAR)
      .map(cleanEngraving)
      .filter(Boolean),
    arkPassive: cleanArkPassiveSummary(raw.arkPassive),
  };
}

module.exports = {
  cleanBuild,
};
