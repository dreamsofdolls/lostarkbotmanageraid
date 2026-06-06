const test = require("node:test");
const assert = require("node:assert/strict");

const { EmbedBuilder } = require("discord.js");
const { UI } = require("../bot/utils/raid/common/shared");
const {
  createRaidChannelEmbedBuilders,
  joinIfArray,
} = require("../bot/services/raid/channel-monitor/channel-monitor-embeds");

const raidMeta = {
  raidKey: "kazeros",
  modeKey: "hard",
  label: "Kazeros Hard",
  minItemLevel: 1730,
};

function builders() {
  return createRaidChannelEmbedBuilders({ EmbedBuilder, UI });
}

test("raid-channel embed helper joins locale arrays without touching strings", () => {
  assert.equal(joinIfArray(["a", "b"]), "a\nb");
  assert.equal(joinIfArray("already text"), "already text");
});

test("raid-channel aggregate embed buckets mixed write results", () => {
  const embed = builders().buildRaidChannelMultiResultEmbed({
    results: [
      { charName: "DoneRaw", displayName: "Done", updated: true, matched: true },
      { charName: "AlreadyRaw", displayName: "Already", alreadyComplete: true, matched: true },
      { charName: "Missing", matched: false },
      { charName: "LowRaw", displayName: "Low", matched: true, updated: false, alreadyComplete: false, ineligibleItemLevel: 1710 },
      { charName: "Errored", error: "mongo offline" },
    ],
    raidMeta,
    gates: ["G1", "G2"],
    statusType: "process",
    guildName: "Raid Guild",
    lang: "en",
  }).toJSON();

  assert.equal(embed.color, UI.colors.progress);
  assert.match(embed.title, /Kazeros Hard/);
  assert.match(embed.title, /G1, G2/);
  assert.equal(embed.fields.length, 5);
  assert.ok(embed.fields.some((field) => field.value.includes("**Done**")));
  assert.ok(embed.fields.some((field) => field.value.includes("**Already**")));
  assert.ok(embed.fields.some((field) => field.value.includes("`Missing`")));
  assert.ok(embed.fields.some((field) => field.value.includes("Low (iLvl 1710)")));
  assert.ok(embed.fields.some((field) => field.value.includes("`Errored`")));
  assert.match(embed.footer.text, /Raid Guild/);
});

test("raid-channel welcome embed renders the configured onboarding field set", () => {
  const embed = builders().buildRaidChannelWelcomeEmbed("en").toJSON();

  assert.equal(embed.color, UI.colors.neutral);
  assert.ok(embed.title);
  assert.ok(embed.description);
  assert.equal(embed.fields.length, 11);
  assert.ok(embed.fields.every((field) => typeof field.name === "string" && field.name.length > 0));
  assert.ok(embed.fields.every((field) => typeof field.value === "string" && field.value.length > 0));
});
