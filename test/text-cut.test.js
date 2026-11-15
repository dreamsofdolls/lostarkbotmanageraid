"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require("discord.js");

const { cutText, truncateText } = require("../bot/utils/raid/common/shared");
const { truncateChoice } = require("../bot/utils/raid/common/autocomplete");
const { buildFlipPickerComponents, buildTogglePickerComponents } = require("../bot/utils/raid/roster-picker");

// `count` filler units, then an emoji whose two units sit at count + 1 and
// count + 2, so a cut after count + 1 units would keep only its first half.
const straddling = (count) => `${"x".repeat(count)}😀tail`;

test("cutText keeps at most the limit and ends on a whole character", () => {
  assert.equal(cutText("abcdef", 3), "abc");
  assert.equal(cutText("ab😀cd", 3), "ab");
  assert.equal(cutText("ab😀cd", 4), "ab😀");
  assert.equal(cutText("short", 20), "short");
  assert.equal(cutText(undefined, 5), "");
});

test("truncateText never ends its cut on half an emoji", () => {
  // 20 - 3 for the dots lands inside the emoji.
  assert.equal(truncateText(straddling(16), 20), `${"x".repeat(16)}...`);
  assert.equal(truncateText("short", 20), "short");
});

test("truncateChoice cuts a label and a value on a whole character", () => {
  const choice = truncateChoice(straddling(96), straddling(99));
  assert.equal(choice.name, `${"x".repeat(96)}...`);
  assert.equal(choice.value, "x".repeat(99));
});

test("picker buttons and options never end their text on half an emoji", () => {
  const base = {
    session: { sessionId: "s1", chars: [{}] },
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    customIdPrefix: "p",
    confirmLabel: "OK",
    cancelLabel: "No",
  };
  const [buttons] = buildTogglePickerComponents({
    ...base,
    buttonsPerRow: 5,
    describeButton: () => ({ label: straddling(76), selected: false }),
  });
  assert.equal(buttons.toJSON().components[0].label, `${"x".repeat(76)}...`);

  const [select] = buildFlipPickerComponents({
    ...base,
    StringSelectMenuBuilder,
    placeholder: "Pick",
    describeOption: () => ({ label: straddling(96), description: straddling(96) }),
  });
  const [option] = select.toJSON().components[0].options;
  assert.equal(option.label, `${"x".repeat(96)}...`);
  assert.equal(option.description, `${"x".repeat(96)}...`);
});
