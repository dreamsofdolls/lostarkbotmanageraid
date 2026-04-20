# Lost Ark Raid Management Bot

Discord bot quản lý tiến độ raid cho roster Lost Ark, sử dụng slash commands và MongoDB. Tự động sync roster từ `lostark.bible`, theo dõi progress theo từng gate, và reset weekly vào thứ 4.

## Tính Năng Chính

- Sync roster từ `lostark.bible` theo combat score (top 1-6 characters)
- Theo dõi tiến độ raid theo từng gate (`G1`, `G2`, có thể mở rộng `G3`)
- Gán difficulty (Normal/Hard/Nightmare) độc lập per-raid per-character
- Raid Leader có thể scan roster để tìm character chưa hoàn thành raid
- Weekly reset tự động vào thứ 4 sau 06:00 (server local time)
- Hỗ trợ 3 raid: Act 4, Kazeros, Serca (với Nightmare mode cho Serca 1740+)

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

Hiển thị tiến độ raid của tất cả characters, nhóm theo account.

Ký hiệu trong output:

- `✅` — Raid hoàn thành tất cả gates
- `G1` hoặc `G1/G2` — Partial progress (chỉ xong các gate được liệt kê)
- `❓` — Chưa xong gate nào
- `No eligible raids for current iLvl` — Character chưa đủ item level cho raid nào

Đặc biệt Serca: Characters ở item level 1740+ sẽ thấy Serca Hard **và** Nightmare là hai lựa chọn riêng biệt trong cùng status line.

### `/raid-set`

Update trạng thái raid cho 1 character cụ thể.

| Option | Required | Choices |
|--------|----------|---------|
| `character` | ✅ | Tên character trong roster |
| `raid` | ✅ | `armoche_normal`, `armoche_hard`, `kazeros_normal`, `kazeros_hard`, `serca_normal`, `serca_hard`, `serca_nightmare` |
| `status` | ✅ | `complete` hoặc `reset` |
| `gate` | ❌ | `G1`, `G2`, `G3` — bỏ trống để update mọi gate |

Ví dụ: `/raid-set character:Clauseduk raid:kazeros_hard status:complete gate:G1`

### `/raid-check`

**Chỉ dành cho role `raid leader`** (case-insensitive). Scan tất cả characters đủ item level nhưng chưa hoàn thành raid ở difficulty được chọn.

Output được paginate tự động thành các chunks ≤ 1900 ký tự để tránh vượt limit Discord.

## Raid Catalog

| Raid Key | Hiển thị | Normal | Hard | Nightmare |
|----------|----------|--------|------|-----------|
| `armoche` | Act 4 | 1700 | 1720 | — |
| `kazeros` | Kazeros | 1710 | 1730 | — |
| `serca` | Serca | 1710 | 1730 | 1740 |

Thêm raid mới: sửa `RAID_REQUIREMENTS` trong `src/models/Raid.js` và chạy lại `npm run deploy:commands`.

## Data Model

### User document (MongoDB)

```json
{
  "discordId": "string (unique, indexed)",
  "weeklyResetKey": "2026-W16",
  "accounts": [
    {
      "accountName": "string",
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

⚠️ `getDay()` / `getHours()` dùng **local time** của Node process. Trên Railway (mặc định UTC) → reset diễn ra Wed 06:00 UTC. Container khác timezone sẽ reset theo giờ tương ứng.

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

Lần đầu deploy, chạy `deploy:commands` một lần để register slash commands với guild target.

## Known Limitations

- `/raid-check` chỉ nhận role có tên **exactly** `raid leader` (case-insensitive). Role name khác sẽ bị từ chối.
- `/add-roster` phụ thuộc HTML/inline-JS structure của `lostark.bible`. Nếu site thay layout, regex + DOM selectors cần update.
- Weekly reset dùng local time → cần đảm bảo Railway container ở UTC (mặc định đã là vậy).
- Slash commands register theo **guild-scoped**, không phải global. Muốn enable ở nhiều server → cần chạy `deploy-commands.js` riêng cho mỗi `GUILD_ID`.

## Legacy Files (Safe to Ignore)

Repo hiện có 2 file leftover từ template copy-paste, **không được import bởi bot**:

- `config.js` — ESM config cho LoaLogs bot (officer approvers, Gemini, ScraperAPI). Env vars mismatch với `db.js` (`MONGODB_URI` vs `MONGO_URI`).
- `src/models/GuildConfig.js` — Schema cho `/lasetup` / `/laremote` / blacklist — không có command nào trong bot này dùng.

Có thể xoá cả 2 file nếu muốn repo sạch hơn.
