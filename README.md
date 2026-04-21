# Lost Ark Raid Management Bot

Discord bot quản lý tiến độ raid cho roster Lost Ark, sử dụng slash commands và MongoDB. Tự động sync roster từ `lostark.bible`, theo dõi progress theo từng gate, và reset weekly vào thứ 4 lúc 17:00 giờ Việt Nam (UTC+7).

## Tính Năng Chính

- Sync roster từ `lostark.bible` theo combat score (top 1-6 characters)
- Theo dõi tiến độ raid theo từng gate (`G1`, `G2`, có thể mở rộng `G3`)
- Gán difficulty (Normal/Hard/Nightmare) độc lập per-raid per-character
- Raid Leader có thể scan roster để tìm character chưa hoàn thành raid
- Weekly reset tự động vào thứ 4 lúc 17:00 giờ Việt Nam = 10:00 UTC thứ 4 (với catch-up nếu bot offline qua reset window)
- Hỗ trợ 3 raid: Act 4, Kazeros, Serca (với Nightmare mode cho Serca 1740+)
- Embed UI với dynamic color theo tiến độ + per-gate visualization (`{icon} {raid} · done/total`)
- `/raid-status` lazy auto-refresh iLvl/combatScore từ lostark.bible (2h cooldown, preserve raid progress)
- `/raid-status` pagination 1 roster = 1 page, 2 chars/row, session 2 phút
- `/remove-roster` xóa roster hoặc 1 char riêng (autocomplete chained)
- Bilingual help command (`/raid-help`) với dropdown drill-down
- `/raid-channel` + text monitor: post message ngắn `<raid> <difficulty> <character> [gate]` vào channel đã config — bot tự parse, update raid, xóa message

## Commands

### `/add-roster`

Sync roster từ `lostark.bible` và lưu top-N characters theo combat score.

| Option | Required | Mặc định | Mô tả |
|--------|----------|----------|-------|
| `name` | ✅ | — | Tên 1 character trong roster muốn sync |
| `total` | ❌ | 6 | Số characters muốn lưu (1-6) |

Ví dụ: `/add-roster name:Clauseduk total:6`

Lưu ý: Nếu character/account đã tồn tại trong roster khác của cùng Discord user, bot sẽ từ chối với cảnh báo ephemeral.

### `/raid-status`

Hiển thị tiến độ raid của tất cả characters, **paginated 1 roster = 1 page**, 2 characters per row.

**Ký hiệu trong output:**

- `🟢` — Raid hoàn thành tất cả gates (`done/total` khớp)
- `🟡` — Partial progress (ít nhất 1 gate đã xong, nhưng chưa full)
- `⚪` — Chưa xong gate nào
- `🔒` — Character chưa đủ item level cho raid nào

Mỗi dòng raid hiển thị dạng `{icon} {raid name} · {done}/{total}` — ví dụ `🟢 Kazeros Hard · 2/2` hoặc `🟡 Serca Hard · 1/2`. Raid order per character: **Act 4 → Kazeros → Serca**, top-to-bottom (Serca Hard trước Serca Nightmare).

**Embed color động** theo tổng thể per-account: **xanh lá** nếu tất cả raid đã xong, **vàng** nếu đang có tiến triển, **blurple** nếu chưa bắt đầu gì.

**Pagination:** Nếu có nhiều hơn 1 roster, xuất hiện `◀ Previous` / `Next ▶` buttons (Secondary style). Chỉ người chạy command mới điều khiển được. Session timeout **2 phút** — hết hạn thì buttons disable + footer đổi thành `⏱️ Session đã hết hạn (120s) · Dùng /raid-status để xem lại`.

**Lazy auto-refresh iLvl từ lostark.bible:**
- Mỗi account có `lastRefreshedAt` timestamp.
- Khi `/raid-status` chạy: account nào có `lastRefreshedAt` > **2 tiếng** (hoặc chưa bao giờ) → background fetch lostark.bible, update `itemLevel` + `combatScore` + `class` cho các char match theo name.
- Trong window 2h → zero API calls, dùng cache.
- Raid progress (`assignedRaids`), `weeklyResetKey`, `tasks` **được bảo toàn** — refresh chỉ đụng roster-shape fields.
- Cooldown 2h align với upstream cadence của lostark.bible (họ cũng update mỗi char ~2h).
- Fetch failure (Bible down, rate limit) → log warning + skip account đó, command vẫn render cached data.

Đặc biệt Serca: Characters ở item level 1740+ sẽ thấy Serca Hard **và** Nightmare là hai lựa chọn riêng biệt.

### `/raid-set`

Update trạng thái raid cho 1 character cụ thể.

| Option | Required | Choices |
|--------|----------|---------|
| `character` | ✅ | Tên character — **autocomplete** từ roster đã lưu (top 25, sort theo iLvl desc, format `name · class · iLvl`) |
| `raid` | ✅ | Raid + difficulty — **autocomplete** filter theo character đã chọn: chỉ show raids đủ iLvl, kèm icon tiến độ (`🟢 done · 🟡 partial · ⚪ pending · x/y`). Thứ tự luôn `Act 4 → Kazeros → Serca`, và trong từng raid thì `Normal → Hard → Nightmare` (khớp thứ tự card trong `/raid-status`). Raid đã hoàn thành hiển thị thêm suffix ` · DONE` để nổi bật. Values: `armoche_normal`, `armoche_hard`, `kazeros_normal`, `kazeros_hard`, `serca_normal`, `serca_hard`, `serca_nightmare`. |
| `status` | ✅ | **autocomplete** — mặc định hiện `Complete` (cả raid xong), `Process` (1 gate xong), `Reset` (xoá về 0). Khi raid đã `done/done` cho character đã chọn thì dropdown chỉ còn `Reset (raid đã hoàn thành — chỉ có thể reset)` để tránh click nhầm. |
| `gate` | ❌ | **autocomplete**, chỉ active khi `status = Process`. Dropdown đọc `getGatesForRaid(raidKey)` từ `src/models/Raid.js` nên luôn khớp đúng số gate thực tế của raid (Act 4/Kazeros/Serca hiện tại = G1, G2). Với `Complete`/`Reset` thì gate trả empty để tín hiệu "không cần chọn" — hai action này luôn tác động lên toàn bộ gate. `Process` bắt buộc phải có `gate`, nếu thiếu thì bot reject. |

Ví dụ: `/raid-set character:Clauseduk raid:kazeros_hard status:complete gate:G1`

### `/raid-check`

**Chỉ dành cho role `raid leader`** (case-insensitive). Scan tất cả characters đủ item level nhưng chưa hoàn thành raid ở difficulty được chọn.

Output là **embed ephemeral** với:
- Color động theo difficulty: đỏ = Nightmare, vàng = Hard, blurple = Normal
- Grouped by Discord user — nhiều char pending nhất hiển thị trên cùng; trong mỗi user, char sắp theo iLvl desc
- Multi-embed pagination khi > 25 fields hoặc > 5500 chars — follow-up messages ephemeral
- Empty state (mọi người đã xong): embed xanh lá `✅ All eligible characters have completed...`

### `/remove-roster`

Xóa 1 roster (account) đã lưu hoặc 1 character cụ thể trong roster.

| Option | Required | Description |
|--------|----------|-------------|
| `roster` | ✅ | Roster (account) cần xóa — **autocomplete** từ roster đã lưu |
| `action` | ✅ | `Remove entire roster` hoặc `Remove a single character` |
| `character` | ❌ (required nếu action = remove char) | Character cần xóa — **autocomplete** theo roster đã chọn |

Ví dụ:
- Xóa cả roster: `/remove-roster roster:Qiylyn action:Remove entire roster`
- Xóa 1 char: `/remove-roster roster:Qiylyn action:Remove a single character character:Zywang`

Reply là ephemeral embed confirm xoá. Muốn refresh roster → `/remove-roster` rồi `/add-roster` lại.

### `/raid-help`

Bilingual (EN + VN) help command. Gửi 1 overview embed liệt kê cả 4 command raid-management, kèm dropdown để xem chi tiết từng command (options, example, notes). Reply là ephemeral — chỉ mình cậu thấy.

Dùng khi: cần tra cú pháp nhanh, onboard member mới, hoặc forget option name.

### `/raid-channel` + text monitor

Admin-only command (`Manage Server` permission) để đăng ký 1 text channel làm **raid-clear monitor channel**. Tất cả actions gộp vào subcommand duy nhất `config` với option `action`:

- `/raid-channel config action:show` — xem channel + health check permissions + deploy-flag warnings
- `/raid-channel config action:set channel:#raid-clears` — đăng ký channel + post/pin welcome
- `/raid-channel config action:clear` — tắt monitor + reset schedule
- `/raid-channel config action:cleanup` — xóa thủ công non-pinned messages (giữ welcome)
- `/raid-channel config action:repin` — refresh welcome (delete stale + post+pin mới)
- `/raid-channel config action:schedule-on` — bật auto-cleanup mỗi 00:00 VN
- `/raid-channel config action:schedule-off` — tắt auto-cleanup daily

Sau khi đăng ký, bất kỳ ai post message vào channel đó dạng `<raid> <difficulty> <character> [gate]` sẽ được bot parse và update raid cho char của **chính người post**. Thành công → bot DM user embed xác nhận + xóa message gốc. Lỗi phục hồi được (char không có, iLvl thiếu, v.v.) → bot ping user persistent hint, tự dọn khi user post lại hoặc sau 5 phút.

**Flow chi tiết:**
- **Set subcommand**: bot kiểm tra permission trong channel đích, nếu OK thì save config + post welcome embed công khai + pin luôn. Thiếu quyền → reply lỗi, config không đổi.
- **Show subcommand**: hiển thị channel đang monitor + health check bot's permissions real-time (fallback `channels.fetch` nếu cache cold).
- **Clear subcommand**: tắt monitor ngay, luôn write-through Mongo bất kể cache state.

**Format:**
- `Serca Nightmare Clauseduk` → mark Serca Nightmare của Clauseduk là DONE (cả raid)
- `Serca Nor Soulrano G1` → mark Serca Normal G1 của Soulrano là done (single gate, status=process)

**Aliases** (case-insensitive):
- Raid: `act 4` / `act4` / `armoche` · `kazeros` / `kaz` · `serca` (accept typo `secra`)
- Difficulty: `normal` / `nor` · `hard` · `nightmare` / `nm`
- Gate: `G1`, `G2`, ... (validate theo raid's actual gate list)

**Separator**: space, `+`, hoặc `,` đều được (`Serca + Nor + Soulrano + G1`).

**Error UX:**
| Trường hợp | Bot action |
|-----------|-----------|
| Parse fail (không phải raid intent) | Silent ignore |
| Per-user cooldown hit (<2s kể từ tin nhắn trước, duplicate content hoặc không có pending hint) | Delete message luôn + spam ≥3 hit trong 10s → post 1 warning kitsune-style, dedup 60s. Typo → fix với content khác khi có pending hint được exception pass-through **1 lần duy nhất mỗi cooldown window** (không spam-bypass được bằng cách liên tục thay đổi content). |
| Lỗi phục hồi được (char not found, iLvl thấp, combo sai, multi-raid/diff/gate) | Ping user persistent hint — auto-dọn khi user post lại hoặc sau 5 phút TTL |
| Raid đã DONE từ trước (hoặc gate đã DONE khi post với gate) | DM user notice "Raid đã DONE rồi" + xóa message gốc. Không re-stamp timestamp, không ghi DB. Muốn reset phải dùng `/raid-set status:reset`. |
| Internal error (DB/Discord fail) | Reply transient tự xóa 10s |
| Success | DM user embed xác nhận + xóa message gốc + dọn hint cũ của user đó (nếu có) |

**DM confirmation**: Discord chỉ hỗ trợ ephemeral (chỉ tác giả thấy) cho interactions — không có trên `MessageCreate`. Workaround là DM. Nếu user tắt "Allow direct messages from server members" → DM fail, bot **fallback post 1 tin nhắn công khai ngắn** mention user + raid + char, tự xóa sau 15 giây, để user vẫn biết update đã thành công thay vì thấy message biến mất không phản hồi. Log warn chỉ ở server, user được thông báo cách bật lại DM để nhận confirm private lần sau.

**Prerequisites deploy:**
1. Bật `MESSAGE CONTENT INTENT` trong Discord Developer Portal → Bot → Privileged Gateway Intents. Nếu không bật, bot **sẽ không start được** (Discord reject login với "Used disallowed intents") — dùng env `TEXT_MONITOR_ENABLED=false` để deploy slash-command-only mà không cần privileged intent.
2. Invite bot với scope `bot applications.commands` + permissions trong channel đã config: `View Channel`, `Send Messages`, `Manage Messages`, `Read Message History`, `Embed Links`. `/raid-channel config action:set` giờ tự check và từ chối nếu thiếu bất kỳ quyền nào. (`Read Message History` cần cho `clearPendingHint` fetch/delete tin cũ; `Embed Links` cần cho welcome + DM confirm embeds — thiếu là Discord strip embed).
3. Intents trong `src/bot.js`: `Guilds` luôn có; `GuildMessages` + `MessageContent` chỉ add khi `TEXT_MONITOR_ENABLED !== "false"`.

**Cache behavior:** monitor channel ID được cache in-memory per-guild, load on boot từ `guildconfigs` Mongo collection. `/raid-channel config action:set|clear` update cache in-place — không có Mongo round-trip cho mỗi message đi qua channel. Single-process bot nên không cần invalidation cross-instance.

Config lưu trong collection `guildconfigs` của MongoDB, per-guild.

## Raid Catalog

| Raid Key | Hiển thị | Normal | Hard | Nightmare | Gates |
|----------|----------|--------|------|-----------|-------|
| `armoche` | Act 4 | 1700 | 1720 | — | G1, G2 |
| `kazeros` | Kazeros | 1710 | 1730 | — | G1, G2 |
| `serca` | Serca | 1710 | 1730 | 1740 | G1, G2 |

Gate count được lấy từ `RAID_REQUIREMENTS[raidKey].gates` trong `src/models/Raid.js`. Helper `getGatesForRaid(raidKey)` dùng ở mọi chỗ cần list gates — không còn hardcode `["G1", "G2"]` ở đâu.

Thêm raid mới: sửa `RAID_REQUIREMENTS` trong `src/models/Raid.js` (kèm `gates` array), chạy lại `npm run deploy:commands`.

## Data Model

### User document (MongoDB)

```json
{
  "discordId": "string (unique, indexed)",
  "weeklyResetKey": "2026-W16",
  "accounts": [
    {
      "accountName": "string",
      "lastRefreshedAt": 1775977000000,
      "characters": [
        {
          "id": "uuid",
          "name": "Clauseduk",
          "class": "Paladin",
          "itemLevel": 1730,
          "combatScore": "~4234.35",
          "isGoldEarner": false,
          "assignedRaids": {
            "armoche": {
              "G1": { "difficulty": "Hard", "completedDate": 1775977578808 },
              "G2": { "difficulty": "Hard", "completedDate": 1775977578947 }
            },
            "kazeros": { "G1": {...}, "G2": {...} },
            "serca":   { "G1": {...}, "G2": {...} }
          },
          "tasks": []
        }
      ]
    }
  ],
  "tasks": []
}
```

### Gate System

- Mỗi raid có nhiều gates (mặc định G1, G2; có thể mở rộng G3+).
- Mỗi gate có `difficulty` (string) và `completedDate` (timestamp ms, hoặc `null`).
- Raid được coi là **hoàn thành** khi **tất cả gates** đều có `completedDate > 0` **và** cùng `difficulty` với difficulty đang chọn.
- `assignedRaids.<raidKey>` dùng schema `strict: false` để cho phép thêm gate tự do mà không cần migration.

### Character Class Mapping

30+ classes được map từ `lostark.bible` internal IDs sang display names trong `src/models/Class.js`. Nếu ID không có trong map, fallback: title-case của ID (ví dụ `new_class_name` → `New Class Name`).

## Architecture

```
LostArk_RaidManage/
├── src/
│   ├── bot.js              # Discord client + interaction router
│   ├── index.js            # Wrapper require("./bot")
│   ├── deploy-commands.js  # REST slash command registration (guild-scoped)
│   ├── raid-command.js     # All 4 commands + business logic
│   ├── weekly-reset.js     # Weekly reset scheduler (30-min tick)
│   ├── models/
│   │   ├── Raid.js         # Raid requirements + command choice helpers
│   │   └── Class.js        # lostark.bible class ID → display name map
│   └── schema/
│       └── user.js         # Mongoose User / Account / Character schema
├── db.js                   # Lazy MongoDB connect với DNS fallback
├── Dockerfile              # Railway production image (node:20-slim)
├── railway.toml            # Railway deploy config
├── .env.example            # Environment variable template
└── package.json            # CommonJS, Node 20+, discord.js 14 / mongoose 8
```

### Interaction Flow

1. Discord user gửi slash command
2. `bot.js` lọc `interaction.commandName` ∈ `{add-roster, raid-check, raid-set, raid-status}`
3. Route sang `handleRaidManagementCommand` trong `raid-command.js`
4. Command handler query MongoDB → compute → reply (ephemeral hoặc public tuỳ command)
5. Lỗi không bắt được → generic error ephemeral reply

### Weekly Reset Flow

- `setInterval` chạy mỗi 30 phút (`startWeeklyResetJob()`).
- Skip nếu `getDay() !== 3` (Wed) hoặc `getHours() < 6`.
- Mỗi user chỉ reset 1 lần/tuần thông qua `weeklyResetKey` (ISO week string, ví dụ `2026-W16`).
- Reset: mọi gate `completedDate = null`; mọi task `completions = 0` + `completionDate = null`.

✅ Timing hoàn toàn UTC-based: trigger dùng `getUTCDay()` / `getUTCHours()`, cursor `weeklyResetKey` là ISO week key (cũng UTC). Reset happen Wed 10:00 UTC (= Wed 17:00 giờ Việt Nam, UTC+7) bất kể server timezone.

✅ Catch-up: nếu bot offline qua Wed 10:00 UTC, tick tiếp theo (bất kỳ ngày nào) sẽ so stored `weeklyResetKey` với `getTargetResetKey()` hiện tại — nếu stale, chạy reset ngay.

✅ Race-safe: mỗi user được reset trong `saveWithRetry()` wrapper, nên nếu `/raid-set` commit giữa lúc reset đang process, reset sẽ re-fetch doc fresh và retry thay vì silently overwrite.

### Data Ingestion (`/add-roster`)

1. Fetch `https://lostark.bible/character/NA/<name>/roster` (User-Agent = Windows Chrome, timeout 15s).
2. Dùng regex `/name:"(...)",class:"(...)"/g` trên HTML raw để extract character name + class ID (trích từ inline JSON embedded trong script).
3. Dùng `jsdom` parse DOM, lấy item level + combat score từ `<span>` bên trong `.text-lg.font-semibold > a[href^="/character/NA/"]`.
4. Sort theo combat score desc → item level desc → lấy top `total`.

## Environment Variables

| Variable | Required | Mặc định | Mô tả |
|----------|----------|----------|-------|
| `DISCORD_TOKEN` | ✅ | — | Bot token từ Discord Developer Portal |
| `CLIENT_ID` | ✅ (deploy) | — | Application ID — dùng khi chạy `npm run deploy:commands` |
| `GUILD_ID` | ✅ (deploy) | — | Server ID để register slash commands (guild-scoped) |
| `MONGO_URI` | ✅ | — | MongoDB connection string |
| `MONGO_DB_NAME` | ❌ | `manage` | Tên database |
| `DNS_SERVERS` | ❌ | `8.8.8.8,1.1.1.1` | DNS fallback khi Atlas bị `ECONNREFUSED` (SRV lookup fail) |

Setup local: `cp .env.example .env` rồi điền giá trị thật.

Runtime-only (bot.js) cần: `DISCORD_TOKEN` + MongoDB vars. `CLIENT_ID` / `GUILD_ID` chỉ cần khi register commands.

## Run Local

```bash
npm install
npm run deploy:commands   # lần đầu hoặc khi đổi command schema
npm start                 # hoặc: npm run dev (watch mode)
```

Nếu chỉ sửa logic bên trong command (không đổi option/name) thì **không cần** chạy lại `deploy:commands`.

Script `deploy-commands.js` sẽ tự extract Client ID nếu `CLIENT_ID` vô tình được paste dưới dạng full OAuth2 URL.

## Railway Deploy

1. Push code lên GitHub.
2. Tạo Railway service → link GitHub repo.
3. Trong tab **Variables**, set tất cả env vars (tối thiểu `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `MONGO_URI`).
4. Railway tự build bằng `Dockerfile` (node:20-slim, `npm install --omit=dev`) và start bằng `node src/bot.js`.
5. Restart policy: `ON_FAILURE`, tối đa 3 lần retry (xem `railway.toml`).

Mỗi Railway redeploy bot sẽ **tự đăng ký slash command schema** khi boot (pattern giống `LostArk_LoaLogs` — `bot.js` gọi `rest.put(applicationGuildCommands, ...)` trong `client.once('ready', ...)` handler). Điều đó có nghĩa là:

- Thêm/sửa command → push lên main → Railway redeploy → schema tự sync.
- Registration fail (Discord API down, token sai...) chỉ log warning; bot vẫn boot bình thường với schema cũ → fail-soft.
- `deploy-commands.js` vẫn giữ lại cho trường hợp muốn force register từ dev machine (ví dụ: test schema mới mà không cần Railway).

## Known Limitations

- `/raid-check` chỉ nhận role có tên **exactly** `raid leader` (case-insensitive). Role name khác sẽ bị từ chối.
- `/add-roster` phụ thuộc HTML/inline-JS structure của `lostark.bible`. Nếu site thay layout, regex + DOM selectors cần update.
- Weekly reset dùng UTC cho cả trigger và week-key — không còn phụ thuộc container timezone.
- Slash commands register theo **guild-scoped**, không phải global. Muốn enable ở nhiều server → cần chạy `deploy-commands.js` riêng cho mỗi `GUILD_ID`.

## Legacy Files (Safe to Ignore)

Repo hiện có 2 file leftover từ template copy-paste, **không được import bởi bot**:

- `config.js` — ESM config cho LoaLogs bot (officer approvers, Gemini, ScraperAPI). Env vars mismatch với `db.js` (`MONGODB_URI` vs `MONGO_URI`).
- `src/models/GuildConfig.js` — Schema cho `/lasetup` / `/laremote` / blacklist — không có command nào trong bot này dùng.

Có thể xoá cả 2 file nếu muốn repo sạch hơn.
