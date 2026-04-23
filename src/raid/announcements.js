"use strict";

// ---------------------------------------------------------------------------
// Announcement registry - single source of truth for all Artist channel
// announcements. Adding a new type requires:
//   1. A new entry here (type key + label + subdocKey + channelOverridable)
//   2. A matching subdoc in GuildConfig.announcements schema
//   3. Firing-site code at wherever the announcement actually fires
//   4. (Optional) note in HELP_SECTIONS /raid-announce bullet
//
// Design choice: nested subdoc storage (GuildConfig.announcements) stays,
// a collection-per-announcement refactor was considered and skipped because
// cardinality is low (5 types × 1-ish guilds) and no query pattern needs
// cross-guild announcement analytics or dynamic user-defined types. If the
// type count crosses ~10 OR rich metadata lands (cron, TTL override,
// conditions), revisit collection split then.
//
// Groups:
//   - channelOverridable: destination CAN be redirected to a non-monitor
//     channel via /raid-announce set-channel. Used for pure announcements
//     and user-tag nudges that don't semantically refer to the monitor
//     channel itself.
//   - !channelOverridable (channel-bound): destination MUST be the monitor
//     channel because the message refers to that channel (greeting = "this
//     channel is set", cleanup notice = "this channel just got cleaned",
//     whisper ack = reply to a user's message here).
const ANNOUNCEMENT_REGISTRY = {
  "weekly-reset": {
    label: "Weekly reset",
    subdocKey: "weeklyReset",
    channelOverridable: true,
    // Trigger + lifecycle metadata shown in /raid-announce show. Keeping
    // these as registry data (not hardcoded in the embed builder) means
    // adding a new announcement type only touches the registry.
    trigger: "Every Wednesday 17:00 VN (= Wed 10:00 UTC), right after the weekly raid progress reset runs.",
    dedup: "Once per ISO week per guild (`lastWeeklyAnnouncementKey`). Tick 30 phút cadence với 24h post-reset window catches catch-up scenarios.",
    messageTtl: "30 phút rồi Artist tự xóa",
    // Preview shown in /raid-announce show. Firing sites still inline
    // content because some interpolate (<@user>, N count); preview gives
    // admins a read-only sample of the message template.
    previewContent:
      "Tuần mới đến rồi nhỉ~ Artist vừa reset progress raid tuần này cho các cậu, giờ chỉ việc làm lại từ đầu thôi. Chúc các cậu tuần raid vui vẻ nha, biển báo này Artist cuỗm đi sau 30 phút.",
  },
  "stuck-nudge": {
    label: "Stuck private log nudge",
    subdocKey: "stuckPrivateLogNudge",
    channelOverridable: true,
    trigger: "During the 30-minute phase-3 auto-manage tick, when a user's roster returns `Logs not enabled` for every character (all private).",
    dedup: "7 ngày per user (`User.lastPrivateLogNudgeAt`). Guild chọn = first reachable guild có member cache hit.",
    messageTtl: "30 phút rồi Artist tự xóa",
    previewContent:
      "<@user> nhắc khẽ nhé~ Roster cậu đã bật auto-manage nhưng hiện tại tất cả char đều là private log, Artist không sync được data đâu. Vào https://lostark.bible/me/logs bật **Show on Profile** cho char cần sync giúp tớ nha. Biển báo này Artist cuỗm đi sau 30 phút.",
  },
  "set-greeting": {
    label: "Set greeting",
    subdocKey: "setGreeting",
    channelOverridable: false,
    trigger: "Ngay sau khi admin chạy `/raid-channel config action:set` và welcome pin post thành công.",
    dedup: "Không có dedup - greeting bám theo mỗi lần admin set channel (hiếm khi lặp).",
    messageTtl: "2 phút rồi Artist tự xóa",
    previewContent:
      "Ồ, chỗ mới này Artist được mời đến trông coi nhỉ~ Xin chào các cậu, từ giờ cứ post clear raid theo format ở welcome pin phía trên là Artist tự cập nhật progress cho nha. Biển báo này Artist cuỗm đi sau 2 phút, welcome thì giữ nguyên.",
  },
  "hourly-cleanup": {
    label: "Cleanup notice",
    subdocKey: "hourlyCleanupNotice",
    channelOverridable: false,
    trigger: "Mỗi 30 phút (đầu giờ + :30 giờ VN, khi `schedule-on` đã bật), sau khi cleanup sweep chạy xong.",
    dedup: "1 post/slot/guild (`lastAutoCleanupKey = 'YYYY-MM-DDTHH:MM'` với MM ∈ {00, 30}). Tick 30 phút align với slot boundary.",
    messageTtl: "5 phút rồi Artist tự xóa",
    previewContent:
      "Variant tone thay đổi theo lượng rác:\n- Sạch sẵn: `Ồ, giờ này Artist ghé qua... ai dè sạch sẽ sẵn rồi nhé~ ...`\n- 1-5 tin: `Nhẹ nhàng thôi mà~ Artist vừa thu gom **N** mẩu tin rồi ...`\n- 6-20 tin: `Hừm... đến ca dọn rồi nhé. Xong, vừa dọn **N** tin ...`\n- 21+ tin: `Oáp... có tới **N** tin phải dọn này, Artist làm hụt hơi luôn~ ...`",
  },
  "artist-bedtime": {
    label: "Artist bedtime",
    subdocKey: "artistBedtime",
    channelOverridable: false,
    trigger: "Mỗi ngày lúc 3:00 VN (= 20:00 UTC hôm trước), tick đầu tiên sau boundary. Artist post embed ngủ nghỉ rồi quiet-hours bắt đầu.",
    dedup: "1 post/VN calendar day/guild (`lastArtistBedtimeKey = 'YYYY-MM-DD'`). Tick 30 phút trong [3:00, 8:00) bỏ qua cả cleanup sweep lẫn notice.",
    messageTtl: "5 phút rồi Artist tự xóa",
    previewContent:
      "Khuya rồi, Artist đi ngủ đây nhé~ Từ giờ tới 8h sáng tớ tạm nghỉ, không dọn rác cũng không ồn ào gì đâu. Các cậu cứ post clear bình thường, sáng ra Artist dậy xử lý gọn 1 lần. Biển báo này Artist cuỗm đi sau 5 phút, chúc cả nhà ngủ ngon~",
  },
  "artist-wakeup": {
    label: "Artist wakeup",
    subdocKey: "artistWakeup",
    channelOverridable: false,
    trigger: "Mỗi ngày lúc 8:00 VN (= 1:00 UTC), tick đầu tiên sau boundary. Artist post wake-up greeting + sweep catch-up 1 lần cho đống tin đêm qua.",
    dedup: "1 post/VN calendar day/guild (`lastArtistWakeupKey = 'YYYY-MM-DD'`). Sau wake-up, các slot :30/:00 trong ngày quay về hourly-cleanup bình thường.",
    messageTtl: "10 phút rồi Artist tự xóa (dài hơn cleanup thường để members online 8h sáng kịp thấy)",
    previewContent:
      "Morning các cậu~ Artist vừa dậy đây nè, vươn vai một cái. Đêm qua tích **N** tin nhắn, Artist dọn luôn 1 thể cho kênh thoáng nha. Giờ Artist làm việc bình thường, biển báo này 10 phút tự cuỗm.",
  },
  "whisper-ack": {
    label: "Whisper ack",
    subdocKey: "whisperAck",
    channelOverridable: false,
    trigger: "Sau mỗi post clear raid hợp lệ trong monitor channel + DM xác nhận gửi thành công.",
    dedup: "Không có - fire mỗi message hợp lệ (đã được rate-limit bởi per-user cooldown 2 giây).",
    messageTtl: "5 giây rồi Artist xóa cùng tin gốc",
    previewContent:
      "<@user> ...Artist nhận được rồi nha~ Chờ Artist 5 giây gửi kết quả qua DM cho cậu nhé...",
  },
};

// Derived accessors - cheap object iteration on a 5-entry object. Keeping
// derivations in-function (rather than top-level computed consts) makes
// the registry the only place that needs editing when adding a type.
function announcementTypeKeys() {
  return Object.keys(ANNOUNCEMENT_REGISTRY);
}
function announcementTypeEntry(typeKey) {
  return ANNOUNCEMENT_REGISTRY[typeKey] || null;
}
function announcementSubdocKeys() {
  return Object.values(ANNOUNCEMENT_REGISTRY).map((r) => r.subdocKey);
}

module.exports = {
  ANNOUNCEMENT_REGISTRY,
  announcementTypeKeys,
  announcementTypeEntry,
  announcementSubdocKeys,
};
