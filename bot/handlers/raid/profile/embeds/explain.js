"use strict";

const { t } = require("../../../../services/i18n");
const { PROFILE_COLORS } = require("../helpers/colors");

/**
 * embeds/explain.js
 * The "Giải thích" popup: per the view the user is currently looking at, a
 * short plain-language glossary of only the HARD / derived metrics (obvious raw
 * stats are skipped). Content is decoupled from the render functions on purpose
 * - those build display strings, not structured metric lists, so a shared
 * definition pool + per-view key lists is the single source of truth here.
 */

// Each hard metric maps to an i18n NAME key (reusing the same label shown in the
// embed so the term matches what the user saw) + a one-line DEFINITION key.
// Defined once; referenced by multiple views (Overall/MVP/etc repeat).
const EXPLAIN_DEFS = {
  overallScore:  { name: "raidProfile.labels.scoreOverall",      def: "raidProfile.explain.defs.overallScore" },
  mvpScore:      { name: "raidProfile.labels.scoreMvp",          def: "raidProfile.explain.defs.mvpScore" },
  roleAvg:       { name: "raidProfile.explain.names.roleAvg",    def: "raidProfile.explain.defs.roleAvg" },
  survival:      { name: "raidProfile.labels.scoreSurvival",     def: "raidProfile.explain.defs.survival" },
  stability:     { name: "raidProfile.labels.scoreConsistency",  def: "raidProfile.explain.defs.stability" },
  contextPct:    { name: "raidProfile.labels.contextPercentile", def: "raidProfile.explain.defs.contextPct" },
  damageShare:   { name: "raidProfile.labels.damageShare",       def: "raidProfile.explain.defs.damageShare" },
  peakBurst:     { name: "raidProfile.labels.peakBurst",         def: "raidProfile.explain.defs.peakBurst" },
  deathless:     { name: "raidProfile.labels.deathless",         def: "raidProfile.explain.defs.deathless" },
  rdpsImpact:    { name: "raidProfile.labels.supportImpact",     def: "raidProfile.explain.defs.rdpsImpact" },
  contribution:  { name: "raidProfile.labels.contribution",     def: "raidProfile.explain.defs.contribution" },
  rContribution: { name: "raidProfile.labels.rContribution",    def: "raidProfile.explain.defs.rContribution" },
  supporterPct:  { name: "raidProfile.labels.supporterPercent",  def: "raidProfile.explain.defs.supporterPct" },
  radiantPct:    { name: "raidProfile.labels.radiantPercent",    def: "raidProfile.explain.defs.radiantPct" },
  supportRank:   { name: "raidProfile.labels.supportRank",       def: "raidProfile.explain.defs.supportRank" },
  protection:    { name: "raidProfile.labels.protection",        def: "raidProfile.explain.defs.protection" },
  apBrand:       { name: "raidProfile.labels.apBrand",           def: "raidProfile.explain.defs.apBrand" },
  identityHyper: { name: "raidProfile.labels.identityHyper",     def: "raidProfile.explain.defs.identityHyper" },
};

// Hard metrics actually rendered per view (kept in sync with embeds.js +
// character-lines.js). Overall/roster show aggregate scores; character views
// split by role (DPS output vs Support impact metrics).
const EXPLAIN_VIEWS = {
  overall: ["overallScore", "mvpScore", "roleAvg"],
  roster: ["overallScore", "mvpScore", "roleAvg"],
  characterDps: ["overallScore", "mvpScore", "survival", "stability", "contextPct", "damageShare", "peakBurst", "deathless"],
  characterSup: ["overallScore", "mvpScore", "survival", "stability", "rdpsImpact", "contribution", "rContribution", "supporterPct", "radiantPct", "supportRank", "protection", "apBrand", "identityHyper", "deathless"],
};

/**
 * Resolve which view the user is currently looking at, so the popup explains
 * exactly the metrics on screen. Mirrors renderSessionPayload's branch logic
 * (overall -> roster -> character) plus the character's role split.
 * @param {object} session - the profile session (rosterIndex/charIndex/entries)
 * @returns {"overall"|"roster"|"characterDps"|"characterSup"}
 */
function resolveExplainView(session) {
  if (!session || session.rosterIndex < 0) return "overall";
  const entry = session.entries?.[session.rosterIndex];
  if (!entry || session.charIndex < 0) return "roster";
  const character = entry.characters?.[session.charIndex];
  return character?.role === "support" ? "characterSup" : "characterDps";
}

/**
 * Build the ephemeral "explain" embed for the session's current view.
 * @param {object} session - the profile session
 * @param {string} [lang="vi"] - viewer language (session is owner-locked, so this is the clicker's lang)
 * @param {{ EmbedBuilder: Function }} deps - discord.js EmbedBuilder
 * @returns {object} an EmbedBuilder instance
 */
function buildExplainEmbed(session, lang = "vi", { EmbedBuilder }) {
  const view = resolveExplainView(session);
  const keys = EXPLAIN_VIEWS[view] || EXPLAIN_VIEWS.overall;
  // Colon-separated glossary line; no em-dash per the repo's no-emdash rule.
  const lines = keys
    .map((key) => EXPLAIN_DEFS[key])
    .filter(Boolean)
    .map((entry) => `**${t(entry.name, lang)}**: ${t(entry.def, lang)}`);
  return new EmbedBuilder()
    .setColor(PROFILE_COLORS.amber)
    .setAuthor({ name: t("raidProfile.author.explain", lang) })
    .setTitle(t("raidProfile.explain.title", lang))
    .setDescription(lines.join("\n"));
}

module.exports = {
  EXPLAIN_DEFS,
  EXPLAIN_VIEWS,
  resolveExplainView,
  buildExplainEmbed,
};
