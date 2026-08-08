"use strict";

const { handleClearAnnouncementChannel, handleSetAnnouncementChannel } = require("./channel");
const { handleShowAnnouncement } = require("./show");
const { handleToggleAnnouncement } = require("./toggle");

const RAID_ANNOUNCE_ACTION_CHOICES = Object.freeze([
  {
    name: "Show current configuration",
    name_localizations: {
      vi: "Xem cấu hình hiện tại",
      ja: "現在の設定を表示",
    },
    value: "show",
  },
  {
    name: "Turn notifications ON",
    name_localizations: {
      vi: "Bật thông báo",
      ja: "通知をオンにする",
    },
    value: "on",
  },
  {
    name: "Turn notifications OFF",
    name_localizations: {
      vi: "Tắt thông báo",
      ja: "通知をオフにする",
    },
    value: "off",
  },
  {
    name: "Set a dedicated channel",
    name_localizations: {
      vi: "Đặt kênh thông báo riêng",
      ja: "専用チャンネルを設定",
    },
    value: "set-channel",
  },
  {
    name: "Use the default monitor channel",
    name_localizations: {
      vi: "Dùng lại kênh monitor mặc định",
      ja: "既定の監視チャンネルに戻す",
    },
    value: "clear-channel",
  },
]);

const RAID_ANNOUNCE_ACTIONS = Object.freeze(
  RAID_ANNOUNCE_ACTION_CHOICES.map((choice) => choice.value)
);

const RAID_ANNOUNCE_ACTION_HANDLERS = Object.freeze({
  show: handleShowAnnouncement,
  on: handleToggleAnnouncement,
  off: handleToggleAnnouncement,
  "set-channel": handleSetAnnouncementChannel,
  "clear-channel": handleClearAnnouncementChannel,
});

function isValidRaidAnnounceAction(action) {
  return RAID_ANNOUNCE_ACTIONS.includes(action);
}

function getRaidAnnounceActionHandler(action) {
  return RAID_ANNOUNCE_ACTION_HANDLERS[action] || null;
}

module.exports = {
  RAID_ANNOUNCE_ACTION_CHOICES,
  RAID_ANNOUNCE_ACTIONS,
  getRaidAnnounceActionHandler,
  isValidRaidAnnounceAction,
};
