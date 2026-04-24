# Lost Ark Raid Management Bot

Discord bot tracking weekly raid progress for a small Lost Ark roster. Syncs characters from `lostark.bible`, parses raid-clear posts, and auto-manages weekly reset on Wednesday 17:00 VN.

## Features

- Slash commands for roster sync (`/add-roster`), progress view (`/raid-status`), per-char update (`/raid-set`), and manager scan (`/raid-check`)
- Text-channel monitor: post `<raid> <difficulty> <character> [gate]` in the configured channel, bot parses + updates + DM confirms
- Auto-sync from lostark.bible logs (opt-in via `/raid-auto-manage`) with 30-minute passive scheduler
- Weekly reset Wed 17:00 VN with per-guild announcement
- Auto-cleanup of the monitor channel every 30 minutes, with Artist quiet hours 03:00-08:00 VN (bedtime + morning catch-up sweep)
- Bilingual help (`/raid-help`) with dropdown drill-down

## Commands

| Command | Who | What |
|---|---|---|
| `/add-roster` | anyone | Sync top-N characters (by combat score) from `lostark.bible` into one account |
| `/raid-status` | anyone (self) | View your raid progress, paginated 1 roster/page; lazy-refreshes iLvl from bible (2h cache) |
| `/raid-set` | anyone (self) | Update one character's raid: `complete` / `process <gate>` / `reset` |
| `/raid-check` | Raid Manager | Scan every roster for pending chars in a raid; Sync button (bible pull), Edit button (manager-only cascading edit) |
| `/raid-auto-manage` | anyone (self) | `on` / `off` / `sync` / `status` for automated bible log reconciliation |
| `/raid-channel` | admin | Register monitor channel, cleanup schedule, repin welcome |
| `/raid-announce` | admin | List / enable / disable / redirect per-guild announcement types |
| `/raid-help` | anyone | Drill-down help (dropdown lists all commands + details) |
| `/remove-roster` | anyone (self) | Remove a roster or one character from it |

Raid Manager = Discord user IDs listed in `RAID_MANAGER_ID` env var (comma-separated). Manager privileges: shorter 30s auto-manage sync cooldown (vs 15m default), `👑` header icon on their rosters in `/raid-check` / `/raid-status`, and exclusive access to the `/raid-check` Edit button.

## Text-monitor format

Post into the channel registered via `/raid-channel`:

```
Serca Nightmare Clauseduk            → mark all Serca Nightmare gates done
Kazeros Hard Soulrano G1             → mark G1 only (cumulative: G_N also marks G1..G_{N-1})
Act4 Hard Priscilladuk, Nailaduk     → multi-char in one post
```

**Aliases** (case-insensitive):

- Raid: `act 4` / `act4` / `armoche` · `kazeros` / `kaz` · `serca` (typo `secra`)
- Difficulty: `normal` / `nor` / `nm` · `hard` / `hm` · `nightmare` / `9m` (note: `nm` is Normal, Nightmare uses `9m`)
- Gate: `G1`, `G2`, ...
- Separator: space, `+`, or `,`

## Setup

```bash
npm install
cp .env.example .env    # then edit
npm start               # runs src/bot.js
npm test                # runs node --test on test/
```

### Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_TOKEN` | ✅ | - | Bot token from Developer Portal |
| `CLIENT_ID` | ✅ | - | Application ID, used to register guild slash commands |
| `GUILD_ID` | ✅ | - | Target guild for per-guild slash command registration |
| `MONGO_URI` | ✅ | - | MongoDB connection string |
| `MONGO_DB_NAME` | ❌ | `manage` | Database name |
| `MONGO_ENSURE_INDEXES` | ❌ | `true` | Skip index ensure at boot if you manage indexes in Atlas |
| `DNS_SERVERS` | ❌ | `8.8.8.8,1.1.1.1` | Fallback DNS resolution list |
| `TEXT_MONITOR_ENABLED` | ❌ | `true` | Set `false` to skip the privileged MessageContent intent + the `MessageCreate` listener |
| `RAID_MANAGER_ID` | ❌ (recommended) | empty | Comma-separated Discord user IDs allowed to invoke `/raid-check` + granted manager privileges. Empty/missing means `/raid-check` rejects everyone and the bot warns at boot |
| `AUTO_MANAGE_DAILY_DISABLED` | ❌ | `false` | Killswitch for the 24-hour passive auto-sync scheduler without a redeploy |

To enable the text monitor, flip `Bot → Privileged Gateway Intents → Message Content Intent` on in the Discord Developer Portal. Otherwise set `TEXT_MONITOR_ENABLED=false` to run slash-command-only.

## Architecture

- **`src/bot.js`** - process entry point: connect DB, warm monitor cache, register slash commands, wire listeners
- **`src/raid-command.js`** - compose root: builds command handlers + services + shared helpers via dependency injection
- **`src/commands/*.js`** - one file per slash command, each exports a `create<Name>Command(deps)` factory
- **`src/services/*.js`** - cross-command concerns (auto-manage bible sync, roster refresh, channel monitor, schedulers, RAID_MANAGER_ID allowlist)
- **`src/schema/*.js`** - Mongoose schemas with indexes declared inline
- **`src/raid/*.js`** - pure helpers: shared string/time utils, raid/announcement registries
- **`test/*.test.js`** - `node --test`, no mocks for DB or Discord; exercises pure functions exposed via `__test` blocks

Raid Manager allowlist is single-sourced in `src/services/manager.js`. Auto-manage sync cooldown is per-user (30s for managers, 15m for everyone else). Auto-cleanup + bedtime + wake-up share one 30-minute scheduler tick that branches on the current VN hour.

## Development

- `npm test` - unit tests
- `npm run dev` - local run with `node --watch`
- `npm run deploy:commands` - standalone slash-command registration (the bot also registers on boot)

Railway auto-deploys on push to `main`. No CI required.

## License

Private project, no license.
