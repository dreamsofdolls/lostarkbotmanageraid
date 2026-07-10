const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRaidChannelPermissionHelpers,
} = require("../bot/services/raid/channel-monitor/channel-monitor-permissions");

const PermissionFlagsBits = {
  ViewChannel: 1,
  SendMessages: 2,
  ManageMessages: 4,
  ReadMessageHistory: 8,
  EmbedLinks: 16,
  PinMessages: 32,
};

function channelWithPermissions(allowedFlags) {
  return {
    permissionsFor() {
      return {
        has(flag) {
          return allowedFlags.includes(flag);
        },
      };
    },
  };
}

test("raid-channel permission helper reports missing bot-channel permissions", () => {
  const helpers = createRaidChannelPermissionHelpers({ PermissionFlagsBits });
  const missing = helpers.getMissingBotChannelPermissions(
    channelWithPermissions([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]),
    { id: "bot" }
  );

  assert.deepEqual(missing, ["Manage Messages", "Pin Messages", "Read Message History"]);
});

test("raid-channel permission helper requires Discord Pin Messages separately", () => {
  const helpers = createRaidChannelPermissionHelpers({ PermissionFlagsBits });
  const missing = helpers.getMissingBotChannelPermissions(
    channelWithPermissions([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.EmbedLinks,
    ]),
    { id: "bot" }
  );

  assert.deepEqual(missing, ["Pin Messages"]);
});

test("raid-channel permission helper supports custom required permission sets", () => {
  const helpers = createRaidChannelPermissionHelpers({ PermissionFlagsBits });
  const missing = helpers.getMissingBotChannelPermissions(
    channelWithPermissions([PermissionFlagsBits.ViewChannel]),
    { id: "bot" },
    {
      requiredPerms: [
        { flag: PermissionFlagsBits.ViewChannel, label: "View Channel" },
        { flag: PermissionFlagsBits.SendMessages, label: "Send Messages" },
      ],
    }
  );

  assert.deepEqual(missing, ["Send Messages"]);
});

test("raid-channel announcement permission helper checks the smaller announcement set", () => {
  const helpers = createRaidChannelPermissionHelpers({ PermissionFlagsBits });
  const missing = helpers.getMissingAnnouncementChannelPermissions(
    channelWithPermissions([PermissionFlagsBits.ViewChannel]),
    { id: "bot" }
  );

  assert.deepEqual(missing, ["Send Messages"]);
});

test("raid-channel text monitor flag only disables on literal false", () => {
  const helpers = createRaidChannelPermissionHelpers({ PermissionFlagsBits });
  const original = process.env.TEXT_MONITOR_ENABLED;
  try {
    process.env.TEXT_MONITOR_ENABLED = "false";
    assert.equal(helpers.isTextMonitorEnabled(), false);

    process.env.TEXT_MONITOR_ENABLED = "0";
    assert.equal(helpers.isTextMonitorEnabled(), true);

    delete process.env.TEXT_MONITOR_ENABLED;
    assert.equal(helpers.isTextMonitorEnabled(), true);
  } finally {
    if (original === undefined) delete process.env.TEXT_MONITOR_ENABLED;
    else process.env.TEXT_MONITOR_ENABLED = original;
  }
});
