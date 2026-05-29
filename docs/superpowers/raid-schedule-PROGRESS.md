# /raid-schedule - Tiến độ & Luồng hoạt động

> File này để **đọc hiểu**: feature làm gì, luồng chạy ra sao, đã xong tới đâu, còn gì phải làm.
> Cập nhật: 2026-05-29 · tip `f3d3902` · trạng thái: **nền tảng xong, lớp Discord live chưa làm**.

Tài liệu liên quan:
- Spec (cái gì): `docs/superpowers/specs/2026-05-29-raid-schedule-manager-design.md`
- Plan Phase 1 (làm thế nào): `docs/superpowers/plans/2026-05-29-raid-schedule-phase1-core-logic.md`
- Mockup embed (HTML): `E:/LostArkTool/.superpowers/brainstorm/` (mở bằng browser)

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

### Chưa build (lớp Discord live)

| File (cần tạo/sửa) | Vai trò |
|---|---|
| `bot/handlers/raid/schedule/index.js` *(tạo)* | Command `create` + handler nút (join picker, rsvp, leave, lock, end, help). |
| `bot/locales/{vi,en,jp}.js` *(sửa)* | Key `raid-schedule.*` (parity 3 locale). |
| `bot/handlers/commands/definitions.js` *(sửa)* | Định nghĩa slash command. |
| `bot/commands.js` *(sửa)* | Wire factory + dispatch map + button route. |
| `bot/app/interaction-router-registry.js` *(sửa)* | Allowlist + buttonRoutes/selectRoutes prefix `rse:`. |
| `bot/services/raid/schedulers.js` *(sửa, Phase 3)* | Scan auto-lock khi tới giờ. |

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

1. **i18n** `raid-schedule.*` 3 locale. Key `board.js` cần: `board.{summary,startLine,
   leadLine,roomLine,progress,title.<status>,supportHeader,dpsHeader,waitlistHeader,
   rsvpHeader,rsvpTentative,rsvpAbsent,emptySlot,footer.<status>}` + `btn.{join,late,
   tentative,absent,room,help,lock,unlock,end,manage}`. (parity test bắt buộc 3 locale khớp leaf)
2. **`index.js`** - command create + nút + picker. Mốc smoke-test: `/raid-schedule create`
   post board, bấm Tham gia chọn char vào comp, Trễ/Có thể/Vắng/Khoá/Kết thúc chạy.
3. **Wiring** 3 file (xem mục 3). **Quan trọng:** thiếu allowlist trong
   `interaction-router-registry.js` = command đăng ký nhưng im lặng không chạy (đã có
   test parity bắt lỗi này).
4. **Phase 3:** room modal + 🔑 reveal (gate comp) + manage menu (kick/huỷ/sửa giờ) +
   scheduler auto-lock + auto-clear write thật + section `/raid-help` + README.

**Verify mỗi push:** `node -e "require('./bot/commands')"` (smoke load) + test i18n parity
+ test router parity + `npm test` xanh 2 lần.

---

## 6. Trạng thái hiện tại

- ✅ Nền tảng + logic + renderer: **xong, test, đã push** (`f3d3902`). ~45 test, 499 xanh.
- ❌ Lớp Discord live: **chưa làm** → `/raid-schedule` chưa dùng được trong Discord.
- Lý do dừng: lớp live deploy thẳng bot thật + không unit-test được hành vi Discord →
  nên làm ở phiên tươi + smoke-test song song, không build một cục lớn lúc context đã sâu.
