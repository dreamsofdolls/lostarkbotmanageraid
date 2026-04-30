function createRaidHelpCommand(deps) {
  const {
    EmbedBuilder,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    MessageFlags,
    UI,
  } = deps;

const HELP_SECTIONS = [
    {
      key: "getting-started",
      label: "🚀 Mới vào - Bắt đầu ở đây",
      icon: "🚀",
      short: "Quick onboarding flow for new users",
      shortVn: "3 bước để track raid lần đầu",
      options: [],
      example: "/add-roster name:<tên-char-bất-kỳ>",
      notes: [
        "EN: First time meeting Artist? Here's the 3-step starter flow.",
        "VN: Mới gặp Artist lần đầu? Đây là 3 bước để bắt đầu nha~",
        "",
        "EN: **1️⃣ Register a roster**: type `/add-roster name:<any-char-from-the-roster>`. Artist fetches your full character list from lostark.bible and opens a picker so you tick the chars you want to track, then click **Confirm**.",
        "VN: **1️⃣ Đăng ký roster**: gõ `/add-roster name:<bất-kỳ-char-trong-roster>`. Artist fetch toàn bộ char từ lostark.bible, hiện picker để cậu tick chọn char muốn track rồi bấm **Confirm**.",
        "EN: **2️⃣ View progress**: type `/raid-status` any time to see which char cleared which raid this week.",
        "VN: **2️⃣ Xem progress**: gõ `/raid-status` bất cứ lúc nào để xem char nào đã clear raid gì tuần này.",
        "EN: **3️⃣ Update progress**: 2 ways - (a) `/raid-set` for manual edits, or (b) `/raid-auto-manage action:on` to let Artist auto-sync from lostark.bible every 24h.",
        "VN: **3️⃣ Update tiến độ**: 2 cách - (a) gõ `/raid-set` chỉnh tay, hoặc (b) gõ `/raid-auto-manage action:on` để Artist tự sync từ lostark.bible mỗi 24h.",
        "",
        "EN: **Bonus**: post text like `<raid> <difficulty> <character>` in the raid channel (admin sets via `/raid-channel`) - Artist auto-parses + updates + DMs you a confirmation. Example: `Serca Hard Clauseduk`.",
        "VN: **Bonus**: post text dạng `<raid> <difficulty> <character>` vào channel raid (admin set qua `/raid-channel`) - Artist tự đọc + update + DM xác nhận. Ví dụ: `Serca Hard Clauseduk`.",
        "",
        "EN: Advanced commands: `/raid-task` (track daily/weekly chores), `/edit-roster` (modify saved roster), `/remove-roster` (delete). Each has its own section in the dropdown below.",
        "VN: Lệnh nâng cao: `/raid-task` (track chore daily/weekly), `/edit-roster` (sửa roster đã có), `/remove-roster` (xoá). Mỗi lệnh có section riêng ở dropdown phía dưới~",
      ],
    },
    {
      key: "add-roster",
      label: "/add-roster",
      icon: "📥",
      short: "Sync roster from lostark.bible",
      shortVn: "Đăng ký roster từ lostark.bible",
      options: [
        { name: "name", required: true, desc: "Tên 1 character bất kỳ trong roster muốn add / Any character name in the roster" },
        { name: "target", required: false, desc: "(Raid Manager) Add roster giúp 1 user khác / Add a roster on behalf of another user" },
      ],
      example: "/add-roster name:Clauseduk",
      notes: [
        "EN: Type any character name from your roster - Artist fetches the full account from lostark.bible and opens a picker so you choose which chars to keep.",
        "VN: Gõ tên 1 char, Artist fetch toàn bộ roster từ lostark.bible rồi mở picker để cậu tick chọn char muốn track.",
        "",
        "EN: **When to use**: first time joining the server, or when you add a new alt account.",
        "VN: **Khi nào dùng**: lần đầu vào server, hoặc khi cậu thêm account mới (alt account).",
        "EN: **Flow**: click **Confirm** after ticking → Artist saves the roster to DB. **Cancel** or 5-min timeout → discard.",
        "VN: **Cách Artist xử lý**: bấm **Confirm** sau khi tick → Artist lưu roster vào DB. Bấm **Cancel** hoặc đợi 5 phút → bỏ qua.",
        "EN: **Cap 20 char/roster** (plenty for any player). If a char in the roster is already saved under another account → Artist refuses; use `/edit-roster` instead.",
        "VN: **Cap 20 char/roster** (đủ cho mọi player). Nếu char trong roster đã saved sẵn ở account khác → Artist từ chối, dùng `/edit-roster` để sửa thay.",
        "EN: **Manager tip**: the `target:` option lets a Raid Manager add a roster on behalf of a lazy member. The reply embed pings the target user.",
        "VN: **Mẹo Manager**: option `target:` cho Manager add giúp member lười tự gõ. Reply embed sẽ ping user kia.",
      ],
    },
    {
      key: "edit-roster",
      label: "/edit-roster",
      icon: "📁",
      short: "Add new chars or remove saved chars from a roster",
      shortVn: "Thêm char mới / bỏ char trong roster đã có",
      options: [
        { name: "roster", required: true, desc: "Roster cần edit / The saved roster to edit (autocomplete)" },
      ],
      example: "/edit-roster roster:Clauseduk",
      notes: [
        "EN: Opens a merged picker - tick `🆕` to add new chars, untick saved ones to remove them. Raid progress on surviving chars is preserved.",
        "VN: Artist mở picker merged - tick char `🆕` để add char mới, bỏ tick char đã saved để xoá. Tiến độ raid của char survive được giữ nguyên.",
        "",
        "EN: **When to use**: you just made a new char that isn't tracked yet, or you want to drop an alt you don't play anymore.",
        "VN: **Khi nào dùng**: cậu vừa tạo char mới chưa được track, hoặc muốn bỏ alt không chơi nữa.",
        "EN: **Icons**: `🆕` = new char on bible · `📦` = saved char no longer on bible (renamed / private log).",
        "VN: **Icon**: `🆕` = char mới có ở bible · `📦` = char đã saved nhưng không còn ở bible (rename / private log).",
        "EN: **Tip**: if bible is temporarily offline, you can still enter but only remove. Wait until bible is back to add new chars.",
        "VN: **Mẹo**: nếu bible offline tạm, vẫn vào được nhưng chỉ remove được. Đợi bible up rồi add char mới sau.",
        "EN: **Difference vs `/add-roster`**: edit-roster modifies an existing roster. To add a brand new roster (different account) → use `/add-roster`.",
        "VN: **Khác `/add-roster`**: edit-roster sửa roster đã có. Muốn add roster mới hoàn toàn (account khác) → dùng `/add-roster`.",
      ],
    },
    {
      key: "raid-status",
      label: "/raid-status",
      icon: "📊",
      short: "View your raid progress",
      shortVn: "Xem tiến độ raid + chore phụ của cậu",
      options: [],
      example: "/raid-status",
      notes: [
        "EN: Per-account per-character view of this week's raid clears. Two views: 📋 Raid + 📝 Side tasks.",
        "VN: Hiển thị mỗi character + raid nào đã clear tuần này. Có 2 view: 📋 Tiến độ raid + 📝 Side tasks.",
        "",
        `EN: **Icons**: ${UI.icons.done} done all gates · ${UI.icons.partial} partial · ${UI.icons.pending} pending · ${UI.icons.lock} not eligible (iLvl too low).`,
        `VN: **Icons**: ${UI.icons.done} done hết gate · ${UI.icons.partial} partial · ${UI.icons.pending} pending · ${UI.icons.lock} chưa đủ iLvl.`,
        "EN: **When to use**: often - check which char still has raids pending this week.",
        "VN: **Khi nào dùng**: thường xuyên - kiểm tra char nào còn pending tuần này.",
        "EN: **Auto-refresh**: roster data (iLvl/class) auto-updates every 2h. If you opt-in via `/raid-auto-manage`, raid progress also auto-syncs from bible.",
        "VN: **Auto-refresh**: roster (iLvl/class) tự update mỗi 2h. Nếu cậu opt-in `/raid-auto-manage` thì progress raid cũng auto-sync luôn từ bible.",
        "EN: **🔄 Sync ngay button**: only visible when you've enabled `/raid-auto-manage action:on`. Click to pull bible logs immediately (cooldown 15s for Raid Managers, 10 min for regular users).",
        "VN: **🔄 Sync ngay button**: chỉ hiện khi đã `/raid-auto-manage action:on`. Bấm để pull bible logs ngay (cooldown 15s cho Raid Manager, 10 phút cho user thường).",
        "EN: **Filters**: raid filter dropdown to zoom into one specific raid. Toggle `📝 Side tasks` to view daily/weekly chores registered via `/raid-task`.",
        "VN: **Filter**: dropdown raid filter để zoom 1 raid cụ thể. Toggle `📝 Side tasks` để xem checklist chore daily/weekly đã đăng ký qua `/raid-task`.",
        "EN: **Real-time countdown**: the `Last updated`, `Last synced`, `Sync ready` lines tick down automatically (Discord native timestamp), no need to refresh the embed.",
        "VN: **Real-time countdown**: dòng `Last updated`, `Last synced`, `Sync ready` đếm ngược tự động (Discord native timestamp), không cần refresh embed.",
      ],
    },
    {
      key: "raid-task",
      label: "/raid-task",
      icon: "📝",
      short: "Track per-character and roster-level side tasks",
      shortVn: "Tracker chore phụ theo char và task chung của roster",
      options: [
        { name: "subcommand", required: true, desc: "`add` · `remove` · `clear` · `shared-add` · `shared-remove`" },
        { name: "action", required: false, desc: "(add) `single` 1 char hoặc `all` cả roster / `single` for one char or `all` for every char" },
        { name: "roster", required: true, desc: "Roster chứa character / The roster containing the character" },
        { name: "character", required: false, desc: "(add single / remove / clear) char muốn gắn task / The char to attach a task to" },
        { name: "name", required: false, desc: "(add) tên task, autocomplete gợi ý từ task cũ / Task name, autocomplete from your past tasks" },
        { name: "reset", required: false, desc: "(add) `daily` hoặc `weekly`" },
        { name: "preset", required: false, desc: "(shared-add) `event_shop` · `chaos_gate` · `field_boss` · `custom`" },
        { name: "expires_at", required: false, desc: "(shared-add) ngày hết hạn event shop, format `YYYY-MM-DD`" },
        { name: "all_rosters", required: false, desc: "(shared-add) bật `true` để áp dụng task chung cho toàn bộ roster đã đăng ký" },
        { name: "task", required: false, desc: "(remove/shared-remove) task cần xoá - autocomplete / Task to remove" },
      ],
      example: "/raid-task add action:single roster:Clauseduk character:Frostmourne name:Una Dailies reset:daily",
      notes: [
        "EN: Track per-character side chores (Una dailies, Chaos, Guardian...). Toggle complete in /raid-status's 📝 Side tasks view.",
        "VN: Đăng ký chore phụ ngoài raid (Una dailies, Chaos, Guardian...) gắn từng char. Toggle complete ở `/raid-status` view 📝 Side tasks.",
        "",
        "EN: **Cap**: 3 daily + 5 weekly per character.",
        "VN: **Cap**: 3 daily + 5 weekly mỗi character.",
        "EN: **Auto-reset**: daily 17:00 VN every day · weekly 17:00 VN Wednesday. Automatic, nothing to do.",
        "VN: **Auto-reset**: daily 17:00 VN mỗi ngày · weekly 17:00 VN thứ 4. Tự động, không cần làm gì.",
        "EN: **Action `all`**: adds the same task to every char in a roster (saves 6 commands). Chars already at cap or with the same task get skipped, and their names are listed in the reply.",
        "VN: **Action `all`**: thêm cùng task cho mọi char trong roster (đỡ gõ 6 lần). Char đã có task / đầy cap được skip kèm tên trong reply.",
        "EN: **Shared tasks**: `shared-add` adds roster-level checks like Event Shop, Chaos Gate, and Field Boss. Event shops can use `expires_at` so they disappear after the event.",
        "VN: **Task chung**: `shared-add` thêm checklist cấp roster như Event Shop, Chaos Gate, Field Boss. Event shop có thể dùng `expires_at` để tự ẩn sau khi hết event.",
        "VN: **Task chung toàn bộ roster**: dùng `all_rosters:true` để thêm cùng preset cho mọi roster đã đăng ký; roster nào đã có sẵn hoặc đầy slot sẽ được skip trong reply.",
        "EN: **NA West schedule presets**: Chaos Gate = Mon/Thu/Sat/Sun 11 AM-5 AM PT · Field Boss = Tue/Fri/Sun 11 AM-5 AM PT.",
        "VN: **Preset lịch NA West**: Chaos Gate = T2/T5/T7/CN 11 AM-5 AM PT · Field Boss = T3/T6/CN 11 AM-5 AM PT.",
        "EN: **Toggle**: open `/raid-status` → dropdown `📝 Side tasks` → pick a char (or `🌐 Tất cả character` for bulk) → click a task to flip 🟢/⚪.",
        "VN: **Toggle**: vào `/raid-status` → dropdown `📝 Side tasks` → chọn char (hoặc `🌐 Tất cả character` để bulk) → bấm task để flip 🟢/⚪.",
        "EN: **Subcommand `clear`**: deletes every task on a single char (ephemeral confirm before delete).",
        "VN: **Subcommand `clear`**: xoá toàn bộ task của 1 char (ephemeral confirm trước khi xoá).",
        "EN: **Each player has their own list**: side tasks attach to your own characters. Every user has the same feature.",
        "VN: **Mỗi người có list riêng**: side tasks gắn với character của bản thân. Mọi user đều có cùng feature.",
      ],
    },
    {
      key: "raid-set",
      label: "/raid-set",
      icon: "✏️",
      short: "Manually update one character's raid progress",
      shortVn: "Update tay tiến độ raid cho 1 character",
      options: [
        { name: "roster", required: true, desc: "Roster chứa character / Roster containing the character (autocomplete)" },
        { name: "character", required: true, desc: "Character cần update / Character to update (autocomplete by roster)" },
        { name: "raid", required: true, desc: "Raid + difficulty (autocomplete kèm icon tiến độ / autocomplete with progress icons)" },
        { name: "status", required: true, desc: "`complete` / `process` / `reset`" },
        { name: "gate", required: false, desc: "Gate cụ thể - chỉ active khi status = process / Specific gate - only active when status = process" },
      ],
      example: "/raid-set roster:Clauseduk character:Nailaduk raid:kazeros_hard status:process gate:G1",
      notes: [
        "EN: Manual progress update when you don't use auto-sync. `complete`/`reset` act on every gate; `process gate:G1` marks one specific gate.",
        "VN: Update progress tay khi không dùng auto-sync. `complete`/`reset` tác động cả raid; `process gate:G1` chỉ mark 1 gate.",
        "",
        "EN: **When to use**: posting text in the channel went wrong, or you don't have auto-sync on but need a quick update.",
        "VN: **Khi nào dùng**: post text trong channel sai format, hoặc cậu không bật auto-sync nhưng cần update nhanh.",
        "EN: **Tip**: pick `roster:` first - the `character:` autocomplete only lists chars in that roster (avoids picking the wrong char when 2 rosters share a name).",
        "VN: **Mẹo**: pick `roster:` trước - autocomplete `character:` chỉ list char trong roster đó (đỡ chọn nhầm khi 2 roster cùng tên char).",
        "EN: **Mode switch**: e.g. Serca Nightmare → Hard wipes the old progress because each weekly entry is mode-scoped.",
        "VN: **Đổi mode**: ví dụ Serca Nightmare → Hard sẽ wipe progress cũ vì raid weekly entry là mode-scoped.",
        "EN: **Faster alternative**: post text `Kazeros Hard Nailaduk G1` in the raid channel - auto-updates without typing a slash command.",
        "VN: **Alternative nhanh hơn**: post text `Kazeros Hard Nailaduk G1` vào channel raid - tự update không cần gõ slash command.",
      ],
    },
    {
      key: "raid-check",
      label: "/raid-check",
      icon: "🔍",
      short: "[Raid Manager] Cross-raid overview of guild progress",
      shortVn: "[Raid Manager] Overview tiến độ raid của cả guild",
      options: [],
      example: "/raid-check",
      notes: [
        "EN: Pulls the cross-raid overview across every member's roster. Restricted to Raid Managers (env `RAID_MANAGER_ID`).",
        "VN: Lấy overview cross-raid trên mọi roster của member. Chỉ Raid Manager (env `RAID_MANAGER_ID`) mới gọi được.",
        "",
        "EN: **When to use**: before rolling a raid, the Manager checks who needs to come along.",
        "VN: **Khi nào dùng**: trước khi roll raid, Manager check ai cần đi cùng nhóm.",
        "EN: **Filter dropdowns**: user + raid filters inside the embed zoom into one member or one raid×mode without re-running the command. Picking 1 user reveals `Edit progress` / `Bật/Tắt auto-sync hộ`. The `📝 Xem tasks` toggle reads chore progress (read-only).",
        "VN: **Filter dropdown**: dropdown user + raid trong embed để zoom 1 member hay 1 raid×mode mà không phải gõ lại lệnh. Pick 1 user → button `Edit progress` / `Bật/Tắt auto-sync hộ`. Toggle `📝 Xem tasks` để xem chore (read-only).",
        "EN: **🔄 Sync button**: force-syncs bible logs ONLY for opted-in users in the pending list. Non-opted-in users are not touched (privacy-respecting).",
        "VN: **🔄 Sync button**: force-sync bible logs CHỈ cho user đã opt-in auto-sync trong list pending. Non-opted-in user không bị động đến (privacy-respecting).",
        "EN: **✏️ Edit button**: cascading select to fix another member's progress. Chars opted into auto-sync with bible visible are hidden (sync would overwrite manual edits). Private-log chars are still editable.",
        "VN: **✏️ Edit button**: cascading select để fix progress của member khác. Char đã opt-in auto-sync + bible visible bị ẩn (sync sẽ ghi đè manual edit). Char private log → vẫn edit được.",
        "EN: **Session timeout 5 minutes** - components disable when expired; type `/raid-check` again to reopen.",
        "VN: **Session timeout 5 phút** - hết hạn disable mọi component, gõ lại `/raid-check` để mở lại.",
      ],
    },
    {
      key: "remove-roster",
      label: "/remove-roster",
      icon: "🗑️",
      short: "Remove a roster or one character from it",
      shortVn: "Xoá roster hoặc 1 character",
      options: [
        { name: "roster", required: true, desc: "Roster name (autocomplete)" },
        { name: "action", required: true, desc: "`Remove entire roster` hoặc `Remove a single character`" },
        { name: "character", required: false, desc: "Char cần xoá - required khi action = Remove a single character / Char to remove - required when action = Remove a single character" },
      ],
      example: "/remove-roster roster:Qiylyn action:Remove a single character character:Zywang",
      notes: [
        "EN: Delete an entire roster, or just one character from it.",
        "VN: Xoá toàn bộ account roster, hoặc chỉ 1 char trong đó.",
        "",
        "EN: **When to use**: an account or character you don't play anymore.",
        "VN: **Khi nào dùng**: account/char cũ không chơi nữa.",
        "EN: **Tip**: to refresh a roster → `/remove-roster` then `/add-roster` again to pull fresh data from bible.",
        "VN: **Mẹo**: muốn refresh 1 roster → `/remove-roster` rồi `/add-roster` lại để pull data mới từ bible.",
        "EN: **Difference vs `/edit-roster`**: edit-roster modifies via tick/untick. Remove-roster deletes outright.",
        "VN: **Khác `/edit-roster`**: edit-roster sửa picker tick/untick. Remove-roster xoá hẳn.",
      ],
    },
    {
      key: "raid-channel",
      label: "/raid-channel",
      icon: "📢",
      short: "[Admin] Configure the raid-clear monitor channel",
      shortVn: "[Admin] Set channel để bot tự đọc message clear raid",
      options: [
        { name: "config action:<x>", required: true, desc: "Action: `show` / `set` / `clear` / `cleanup` / `repin` / `schedule-on` / `schedule-off`" },
        { name: "channel", required: false, desc: "Text channel - cần khi action:set / Required when action:set" },
      ],
      example: "/raid-channel config action:set channel:#raid-clears",
      notes: [
        "EN: Pick a channel where members post raid clears as text. Artist parses, updates DB, deletes the source message, DMs a private confirmation.",
        "VN: Set 1 channel làm nơi member post text dạng `<raid> <difficulty> <character>`. Artist tự parse, update DB, xoá tin nhắn, DM xác nhận.",
        "",
        "EN: **Text format**:",
        "VN: **Format text**:",
        "• `Serca Hard Clauseduk` (mark whole raid done)",
        "• `Kazeros Hard Soulrano G1` (mark G1 only - cumulative đến G_N)",
        "• Multi-char: `Act4 Hard A, B, C`",
        "EN: **Aliases**: act4/armoche · kazeros/kaz · serca · normal/nor/nm · hard/hm · nightmare/9m. Note: `nm` = Normal (NOT Nightmare).",
        "VN: **Aliases**: act4/armoche · kazeros/kaz · serca · normal/nor/nm · hard/hm · nightmare/9m. Lưu ý `nm` = Normal (không phải Nightmare).",
        "EN: **Auto-cleanup every 30 min** (VN time, 8am-3am): bot deletes non-pinned + posts a tone-shifting notice based on cleanup volume. Quiet hours 3am-8am VN: no sweeping, no noise.",
        "VN: **Auto-cleanup mỗi 30 phút** (giờ VN, từ 8h-3h sáng): bot xoá non-pinned + post biển báo tone đổi theo lượng rác. Quiet hours 3h-8h sáng VN: không dọn, không ồn.",
        "EN: **Permissions required**: View Channel, Send Messages, Manage Messages, Read Message History, Embed Links. Missing any of the 5 → action:set rejects.",
        "VN: **Permissions cần**: View Channel, Send Messages, Manage Messages, Read Message History, Embed Links. Thiếu 1 trong 5 → action:set reject.",
        "EN: **Admin-only**: requires `Manage Server` permission.",
        "VN: **Admin-only**: cần permission `Manage Server`.",
      ],
    },
    {
      key: "raid-auto-manage",
      label: "/raid-auto-manage",
      icon: "🤖",
      short: "Auto-sync raid progress from lostark.bible",
      shortVn: "Tự động sync tiến độ raid từ bible (opt-in)",
      options: [
        { name: "action:on", required: false, desc: "Bật + probe roster (warn nếu char chưa Public Log) + sync ngay / Enable + probe + immediate sync" },
        { name: "action:off", required: false, desc: "Tắt auto-sync / Disable" },
        { name: "action:sync", required: false, desc: "Manual sync ngay / Manual sync now" },
        { name: "action:status", required: false, desc: "Xem state on/off + last sync time" },
      ],
      example: "/raid-auto-manage action:on",
      notes: [
        "EN: When enabled, Artist pulls clear logs from lostark.bible daily AND on each /raid-status open (cooldown-protected to spare bible).",
        "VN: Khi bật, Artist tự pull clear logs từ lostark.bible mỗi ngày + mỗi lần cậu gõ /raid-status (cooldown protect bible).",
        "",
        "EN: **When to use**: too lazy to post text + too lazy to type `/raid-set`. Enable once, the bot handles the rest.",
        "VN: **Khi nào dùng**: lười post text + lười gõ `/raid-set`. Bật 1 lần, bot tự lo.",
        "EN: **Requirement**: enable **Show on Profile** at https://lostark.bible/me/logs for every char you want synced (so bible exposes the data to Artist). Private-log chars are unreachable.",
        "VN: **Yêu cầu**: bật **Show on Profile** ở https://lostark.bible/me/logs cho mỗi char muốn sync (để bible cho phép Artist đọc). Char Private log → Artist không reach được.",
        "EN: **Cooldown**: 15s for Raid Managers, 10 min for everyone else - protects bible from spam.",
        "VN: **Cooldown**: 15s cho Raid Manager, 10 phút cho user thường - protect bible khỏi spam.",
        "EN: **`action:on` flow**: probes the roster first, and if any char is private-log → warning embed with `Vẫn bật` / `Huỷ` buttons. Confirm kicks off an immediate sync.",
        "VN: **`action:on` flow**: probe roster trước, nếu có char private log → warn embed kèm nút `Vẫn bật` / `Huỷ`. Confirm thì kickstart 1 lần sync ngay.",
        "EN: **Background tick**: opted-in users who haven't synced in 24h get auto-pulled by a 30-min scheduler (batch of 3 users/tick, fair rotation).",
        "VN: **Auto-tick background**: opted-in user nào chưa sync 24h → background scheduler tự pull mỗi 30 phút (batch 3 user/tick fair rotation).",
        "EN: **`action:status`**: shows last success vs last attempt - easy to spot when sync is failing repeatedly (Cloudflare / private log).",
        "VN: **`action:status`**: show last success vs last attempt - dễ thấy khi sync đang fail liên tục (Cloudflare/private log).",
        "EN: **Mode-switch**: if a bible log reports a Serca NM clear but the DB tracks Serca Hard for that char, bible wins - Artist wipes the old progress and rewrites at the new mode.",
        "VN: **Mode-switch**: nếu bible log báo clear Serca NM nhưng DB đang track Serca Hard cho char đó, bible-wins - Artist wipe progress cũ rồi ghi theo mode mới.",
      ],
    },
    {
      key: "raid-announce",
      label: "/raid-announce",
      icon: "📣",
      short: "[Admin] Configure Artist's channel announcements",
      shortVn: "[Admin] Tắt/bật + redirect channel cho từng loại thông báo",
      options: [
        { name: "type", required: true, desc: "Loại thông báo (dropdown 9 loại) / Announcement type (9 dropdown options)" },
        { name: "action", required: true, desc: "`show` / `on` / `off` / `set-channel` / `clear-channel`" },
        { name: "channel", required: false, desc: "Channel đích - cần khi action:set-channel / Destination channel - required when action:set-channel" },
      ],
      example: "/raid-announce type:maintenance-early action:set-channel channel:#announcements",
      notes: [
        "EN: 9 announcement types Artist posts to channels, each with on/off toggle. 4 types support channel override (#announcements / dedicated #maintenance, etc).",
        "VN: 9 loại thông báo Artist post vào channel, mỗi loại tắt/bật được. 4 loại còn redirect được sang channel khác (#announcements / #maintenance riêng).",
        "",
        "EN: **9 types**:",
        "VN: **9 loại**:",
        "• `weekly-reset` - Wed 17 VN reset tuần / weekly reset",
        "• `stuck-nudge` - tag user toàn char private log / nudge users with all-private-log rosters",
        "• `set-greeting` - chào sau /raid-channel set / greeting after /raid-channel set",
        "• `hourly-cleanup` - notice sau cleanup / cleanup notice",
        "• `artist-bedtime` - 3h sáng VN Artist đi ngủ / 3am VN bedtime",
        "• `artist-wakeup` - 8h sáng VN Artist dậy / 8am VN wakeup",
        "• `whisper-ack` - whisper khi parse clear thành công / whisper on successful parse",
        "• `maintenance-early` - T-3h/2h/1h trước bảo trì / pre-maintenance reminder",
        "• `maintenance-countdown` - T-15m/10m/5m/1m countdown",
        "EN: **Channel-overridable** (4 types): `weekly-reset`, `stuck-nudge`, `maintenance-early`, `maintenance-countdown`. The rest are bound to the monitor channel because their content references it specifically.",
        "VN: **Channel-overridable** (4 loại): `weekly-reset`, `stuck-nudge`, `maintenance-early`, `maintenance-countdown`. Còn lại bound với monitor channel vì content refer cụ thể.",
        "EN: **When to use**: the /raid-channel pin getting too noisy → turn off `hourly-cleanup` / `artist-bedtime`. Or redirect maintenance reminders to a dedicated #announcements channel.",
        "VN: **Khi nào dùng**: pin /raid-channel hơi nhiều noise → tắt `hourly-cleanup` / `artist-bedtime`. Hoặc redirect maintenance reminder sang #announcements riêng.",
        "EN: **Admin-only**: requires `Manage Server`.",
        "VN: **Admin-only**: cần `Manage Server`.",
      ],
    },
  ];
  // Language toggle: pick "en" or "vi" (default). Each render builder
  // takes the resolved lang and emits monolingual content. Notes
  // pre-tagged with "EN: " / "VN: " filter accordingly; un-tagged lines
  // (technical bullets, code refs) render in both languages.
  const LANG_DEFAULT = "vi";
  function pickLang(value) {
    return value === "en" ? "en" : "vi";
  }
  function pickShortText(section, lang) {
    return lang === "en" ? section.short : section.shortVn;
  }
  function filterNotesByLang(notes, lang) {
    const PREFIX_EN = /^EN:\s*/;
    const PREFIX_VN = /^VN:\s*/;
    return notes
      .filter((line) => {
        if (PREFIX_EN.test(line)) return lang === "en";
        if (PREFIX_VN.test(line)) return lang === "vi";
        return true; // shared technical notes
      })
      .map((line) => line.replace(PREFIX_EN, "").replace(PREFIX_VN, ""));
  }

  function buildHelpOverviewEmbed(lang = LANG_DEFAULT) {
    const titleSuffix = lang === "en" ? "EN" : "VI";
    const desc = lang === "en"
      ? "Lost Ark raid progress tracker for Discord. Pick a command below for details."
      : "Bot quản lý tiến độ raid Lost Ark. Chọn command ở dropdown để xem chi tiết.";
    const footer = lang === "en"
      ? "Switch language: /raid-help language:vi"
      : "Đổi ngôn ngữ: /raid-help language:en";
    const embed = new EmbedBuilder()
      .setTitle(`🎯 Raid Management Bot - Help (${titleSuffix})`)
      .setDescription(desc)
      .setColor(UI.colors.neutral)
      .setFooter({ text: footer })
      .setTimestamp();
    for (const section of HELP_SECTIONS) {
      embed.addFields({
        name: `${section.icon} ${section.label}`,
        value: pickShortText(section, lang),
        inline: false,
      });
    }
    return embed;
  }
  const HELP_FIELD_VALUE_LIMIT = 1024; // Discord rejects embed field values above this.
  function splitHelpFieldValue(value, limit = HELP_FIELD_VALUE_LIMIT) {
    const chunks = [];
    let current = "";
    for (const rawLine of String(value || "").split("\n")) {
      const lineParts = [];
      let remaining = rawLine;
      while (remaining.length > limit) {
        let cutAt = remaining.lastIndexOf(" ", limit);
        if (cutAt < Math.floor(limit * 0.6)) cutAt = limit;
        lineParts.push(remaining.slice(0, cutAt).trimEnd());
        remaining = remaining.slice(cutAt).trimStart();
      }
      lineParts.push(remaining);
      for (const part of lineParts) {
        const next = current ? `${current}\n${part}` : part;
        if (next.length > limit && current) {
          chunks.push(current);
          current = part;
        } else {
          current = next;
        }
      }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : ["_No details_"];
  }
  function addChunkedHelpField(embed, name, value) {
    const chunks = splitHelpFieldValue(value);
    chunks.forEach((chunk, index) => {
      embed.addFields({
        name: index === 0 ? name : `${name} (${index + 1})`,
        value: chunk,
        inline: false,
      });
    });
  }
  function buildHelpDetailEmbed(sectionKey, lang = LANG_DEFAULT) {
    const section = HELP_SECTIONS.find((item) => item.key === sectionKey);
    if (!section) return buildHelpOverviewEmbed(lang);
    const noOptionsLabel = lang === "en" ? "_No options_" : "_Không có options_";
    const embed = new EmbedBuilder()
      .setTitle(`${section.icon} ${section.label}`)
      .setDescription(pickShortText(section, lang))
      .setColor(UI.colors.neutral);
    if (section.options.length > 0) {
      const optionLines = section.options.map((opt) => {
        const req = opt.required ? "✅" : "⚪";
        return `${req} \`${opt.name}\` - ${opt.desc}`;
      });
      addChunkedHelpField(embed, "Options", optionLines.join("\n"));
    } else {
      embed.addFields({ name: "Options", value: noOptionsLabel, inline: false });
    }
    embed.addFields({ name: "Example", value: `\`${section.example}\``, inline: false });
    const filteredNotes = filterNotesByLang(section.notes, lang);
    addChunkedHelpField(embed, "Notes", filteredNotes.join("\n"));
    return embed;
  }
  function buildHelpDropdown(lang = LANG_DEFAULT) {
    const placeholder = lang === "en"
      ? "📖 Pick a command for details..."
      : "📖 Chọn command để xem chi tiết...";
    // Lang baked into the customId so dropdown selections after a
    // language switch render the detail in the user's chosen language
    // without re-running the slash command. selectRoutes prefix-match
    // in bot.js dispatches `raid-help:select:<lang>` to the same
    // handler.
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`raid-help:select:${lang}`)
      .setPlaceholder(placeholder)
      .addOptions(
        HELP_SECTIONS.map((section) => ({
          label: section.label,
          value: section.key,
          description: pickShortText(section, lang).slice(0, 100),
          emoji: section.icon,
        }))
      );
    return new ActionRowBuilder().addComponents(menu);
  }
  async function handleRaidHelpCommand(interaction) {
    const lang = pickLang(interaction.options.getString("language"));
    await interaction.reply({
      embeds: [buildHelpOverviewEmbed(lang)],
      components: [buildHelpDropdown(lang)],
      flags: MessageFlags.Ephemeral,
    });
  }
  async function handleRaidHelpSelect(interaction) {
    // CustomId shape: `raid-help:select:<lang>` - lang baked in by the
    // dropdown builder so the detail embed stays monolingual.
    const lang = pickLang(interaction.customId.split(":")[2]);
    const sectionKey = interaction.values?.[0];
    await interaction.update({
      embeds: [buildHelpDetailEmbed(sectionKey, lang)],
      components: [buildHelpDropdown(lang)],
    });
  }
  return {
    handleRaidHelpCommand,
    handleRaidHelpSelect,
  };
}

module.exports = {
  createRaidHelpCommand,
};
