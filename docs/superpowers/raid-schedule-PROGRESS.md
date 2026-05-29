# /raid-schedule - Tiến độ & Luồng hoạt động

> File này để **đọc hiểu**: feature làm gì, luồng chạy ra sao, đã xong tới đâu, còn gì phải làm.
> Cập nhật: 2026-05-29 · trạng thái: **Discord live MVP đã bật; còn phase manage modal/smoke live**.

Tài liệu liên quan:
- Spec (cái gì): `docs/superpowers/specs/2026-05-29-raid-schedule-manager-design.md`
- Plan Phase 1 (làm thế nào): `docs/superpowers/plans/2026-05-29-raid-schedule-phase1-core-logic.md`
- Mockup embed (HTML): `E:/LostArkTool/.superpowers/brainstorm/` (mở bằng browser)

---

## 0. Cập nhật mới nhất (2026-05-29)

Discord live MVP đã được bật:
- `/raid-schedule create` đã có slash definition, dispatch map, allowlist/router.
- Board public có Join picker, RSVP Late/Maybe/Absent, Lock/Unlock, End, Room gate, Help.
- End ghi clear cho các character trong comp qua write-path `/raid-set`.
- Auto-lock có scheduler riêng, tôn trọng `auto_lock` theo từng event.
- Locale `raid-schedule.*` và `/raid-help` section đã có đủ 3 pack `vi/en/jp`.
- Test hiện tại: `node --test` = 503 pass.

Vẫn còn lại phase sau: manage modal đầy đủ cho room/password, cancel/kick/edit-time UI, và smoke test live trong Discord sau deploy.

---

## 1. Feature là gì

`/raid-schedule` = bảng đăng ký raid kiểu **Raid-Helper**, nhưng "thông minh" hơn vì bot
đã biết roster + item level của mọi người (qua `/raid-add-roster`):

- Lead (trong `RAID_MANAGER_ID`) tạo một event cho 1 raid cụ thể (raid + mode + size 4/8
  + giờ bắt đầu + tiêu đề).
- Người chơi bấm nút đăng ký, chọn **char trong roster của mình** - bot tự lọc char đủ
  item level (>= sàn của raid). Không đủ thì chặn.
- Board hiển thị comp Support/DPS, hàng chờ (waitlist), và phản hồi (RSVP).
- Có countdown (Discord native, tự đổi theo múi giờ mỗi người).
- Lead khoá board, kết thúc raid; khi kết thúc, clear tự ghi vào `/raid-status` của từng
  người trong comp.
- Có phòng + mật khẩu (mật khẩu chỉ người trong comp thấy), và nút Hướng dẫn tại chỗ.

---

## 2. Luồng hoạt động (end-to-end)

```
Lead: /raid-schedule create raid:Act4 mode:Hard size:8 when:20:00 title:"Tối nay"
   │
   ├─ bot validate (lead? raid/mode hợp lệ? giờ parse được?)
   ├─ tạo RaidEvent (status=open) + lưu Mongo
   └─ post BOARD (embed + 3 hàng nút) vào channel, lưu messageId

Người chơi bấm [✅ Tham gia]
   │
   ├─ bot reply EPHEMERAL: select-menu các char đủ ilvl trong roster (char thiếu ilvl = mờ)
   └─ chọn char → applyJoin → còn slot thì vào comp, đầy thì vào waitlist → EDIT board

[🕐 Trễ] giữ slot (đi muộn vẫn tính)  ·  [🤔 Có thể]/[❌ Vắng] rời slot (có thể đẩy waitlist lên → ping)

Lead [🔒 Khoá] → status=locked, nút signup tắt
Lead [🏁 Kết thúc] → status=cleared → auto-ghi clear vào /raid-status cho từng người trong comp
   (hoặc) [⚙️ Quản lý → Huỷ] → status=cancelled → KHÔNG ghi clear, ping báo tan

Nút [🔑 Phòng & mật khẩu] (mọi người) → ephemeral; trong comp thì thấy mật khẩu, không thì bị chặn
Nút [❓ Hướng dẫn] → ephemeral giải thích theo data event + ngôn ngữ người bấm
```

**Vòng đời:** `open → locked → cleared`  HOẶC  `open/locked → cancelled`.

---

## 3. Kiến trúc (mỗi file làm gì)

### Đã build (logic thuần + model + renderer)

| File | Vai trò |
|---|---|
| `bot/models/RaidEvent.js` | Schema Mongo `raid_events` (event + signups nhúng). Enum chừa sẵn cho v2 (signupPolicy, status pending/rejected). |
| `bot/services/raid/schedule/slot-config.js` | Size 4/8 → số slot Support/DPS (4=1+3, 8=2+6). |
| `bot/services/raid/schedule/time-parse.js` | Nhập giờ `+2h`/`+90m` hoặc `HH:MM` (theo múi giờ ngôn ngữ lead) → UTC tuyệt đối. |
| `bot/services/raid/schedule/eligibility.js` | Lọc char roster đủ ilvl + suy ra role (support/dps) + cờ "đã clear tuần này". |
| `bot/services/raid/schedule/slots.js` | `assignSlots` (xếp comp/waitlist từ join order) + `nextWaitlistPromotion` + `detectPromotion`. |
| `bot/services/raid/schedule/signup-state.js` | `applyJoin`/`applyRsvp`/`applyLeave` (mutation thuần trên mảng signups). |
| `bot/services/raid/schedule/auto-clear.js` | Chọn ai được ghi clear khi Kết thúc (chỉ comp thật, KHÔNG ghi waitlist). |
| `bot/handlers/raid/schedule/board.js` | `buildScheduleEmbed` + `buildScheduleComponents` (render board + 3 hàng nút). |

### Đã build thêm (Discord live MVP)

| File | Vai trò |
|---|---|
| `bot/handlers/raid/schedule/index.js` | Command `create` + handler nút/select: join picker, rsvp, lock/unlock, end, room, help. |
| `bot/services/raid/schedule/auto-lock.js` | Scheduler auto-lock riêng cho event đến giờ. |
| `bot/locales/{vi,en,jp}.js` | Key `raid-schedule.*` (parity 3 locale). |
| `bot/handlers/commands/definitions.js` | Định nghĩa slash command. |
| `bot/commands.js` | Wire factory + dispatch map + scheduler export. |
| `bot/app/interaction-router-registry.js` | Allowlist + buttonRoutes/selectRoutes prefix `rse:`. |

---

## 4. Quyết định thiết kế đã chốt (đừng đổi khi tiếp)

- **Placement DERIVED** (không lưu slot index): `assignSlots` tính comp/waitlist từ join order
  + capacity. Slot-move thủ công tạm hoãn (kick + rejoin để cân bằng).
- **Slot-occupying = confirmed + late.** Late giữ slot (đi muộn vẫn tính clear).
  Tentative/Absent KHÔNG giữ slot, hiện ở vùng "Phản hồi".
- **Auto-clear chỉ credit comp thật** (support+dps đã xếp slot), KHÔNG credit waitlist
  overflow (họ không đánh). Đây là bug đã sửa.
- **Mỗi người 1 signup / 1 event.** Re-join (đổi char) giữ nguyên joinedAt (giữ vị trí).
- **Mọi signup phải có char** (chọn qua Tham gia). RSVP (Trễ/Có thể/Vắng) flip status của
  signup đã có → phải Tham gia trước.
- **Custom ID:** `rse:<action>:<eventId>` (vd `rse:join:<id>`, `rse:rsvp:late:<id>`,
  `rse:pick:<id>` cho select). Router prefix-match `rse:`.
- **Consent = signup:** đăng ký bằng char của mình = đồng ý ghi clear vào /raid-status của
  chính mình khi event xong (đi qua write-path của `/raid-set`).
- **Giờ:** parse theo múi giờ ngôn ngữ lead (vi+7/jp+9/en0), lưu UTC, hiện bằng Discord
  native timestamp (tự đổi theo region mỗi người xem).
- **Auto-lock = lựa chọn của lead** mỗi event (`autoLockAtStart`), scheduler tick khoá khi tới giờ.

---

## 5. Còn lại phải làm (theo thứ tự, mỗi mốc smoke-test trong Discord)

1. **Live smoke sau deploy:** `/raid-schedule create` post board, Join picker chọn char vào comp, RSVP, Lock/Unlock, End ghi clear vào `/raid-status`.
2. **Room/password modal:** hiện tại Room gate có sẵn nhưng chưa có UI set room/password từ Discord.
3. **Manage menu nâng cao:** cancel event, kick member, sửa giờ/title, và setting nâng cao.
4. **Polish help theo event:** help hiện là hướng dẫn MVP tĩnh; phase sau có thể render theo trạng thái event hiện tại.

**Verify mỗi push:** `node -e "require('./bot/commands')"` (smoke load) + test i18n parity
+ test router parity + `npm test` xanh 2 lần.

---

## 6. Trạng thái hiện tại

- ✅ Nền tảng + logic + renderer: xong.
- ✅ Discord live MVP: đã wire slash command, router `rse:`, handler create/join/RSVP/lock/end/help/room, auto-lock scheduler, auto-clear write qua `/raid-set`.
- ✅ Verification local: `node -e "require('./bot/commands')"` load được, `node --test` xanh 503/503.
- ⚠️ Chưa live-smoke trong Discord sau deploy ở phiên này. Cần test thật: create board, Join picker, RSVP, Lock, End, và auto-clear trên một event sandbox.
- ⏳ Phase còn lại: manage modal room/password, cancel/kick/edit-time UI, và polish hướng dẫn theo event.
