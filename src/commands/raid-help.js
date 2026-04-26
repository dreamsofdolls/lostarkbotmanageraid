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
      key: "add-roster",
      label: "/add-roster",
      icon: "📥",
      short: "Sync roster from lostark.bible",
      shortVn: "Đồng bộ roster từ lostark.bible",
      options: [
        { name: "name", required: true, desc: "Tên 1 character trong roster / Name of a character in the roster" },
        { name: "total", required: false, desc: "Số characters muốn lưu (1-6, default 6) / Number of characters to save" },
        { name: "target", required: false, desc: "(Raid Manager) Add roster giúp 1 user khác - bypass cho member quá lười tự gõ" },
      ],
      example: "/add-roster name:Clauseduk total:6",
      notes: [
        "EN: Saves top-N characters ranked by combat score; falls back to item level for ties.",
        "VN: Lưu top-N nhân vật theo combat score; nếu bằng điểm thì xếp theo item level.",
        "• Nếu roster/character đã tồn tại trong account khác của cùng Discord user, bot sẽ từ chối.",
        "• **Option `target` (Raid Manager only)**: chỉ định 1 user khác, roster sẽ lưu dưới Discord ID của user đó (không phải caller). Use case: member quá lười tự gõ → Manager add giúp. Reply embed sẽ ping user kia + ghi rõ \"Roster này được Raid Manager X add giúp Y\". Non-Manager dùng option này → ephemeral reject.",
      ],
    },
    {
      key: "raid-status",
      label: "/raid-status",
      icon: "📊",
      short: "View your raid completion status",
      shortVn: "Xem tiến độ raid của mình",
      options: [],
      example: "/raid-status",
      notes: [
        `EN: ${UI.icons.done} done all gates · ${UI.icons.partial} partial · ${UI.icons.pending} pending · ${UI.icons.lock} not eligible.`,
        "VN: Hiển thị per-account per-character, mỗi raid có count `done/total`.",
        "• Embed color động: xanh lá = xong hết, vàng = đang tiến triển, xanh dương = chưa bắt đầu.",
        "• Ở iLvl 1740+: Serca Hard VÀ Nightmare hiển thị riêng biệt để cậu chọn mode.",
        "• **Lazy refresh**: account nào quá 2h chưa update thì Artist scrape bible roster page để sync itemLevel/combatScore/class - match bible cadence ~2h. Share `bibleLimiter` với `/raid-auto-manage`. Mỗi HTTP fetch gắn `AbortSignal.timeout(15s)` chống bible treo connection.",
        "• **Failure cooldown**: nếu seed list của một account fail hết (wrong accountName + stale char names), Artist stamp `lastRefreshAttemptAt` và skip refresh account đó trong **5 phút** tiếp theo. Spam `/raid-status` trong lúc failing không còn queue N seed × bible fetch mỗi lần - tự heal khi hết cooldown hoặc khi user sửa roster qua `/add-roster`.",
        "• **Gather/apply split**: bible fetch chạy OUTSIDE `saveWithRetry` một lần duy nhất; apply phase (mutate fresh doc + save) mới ở trong retry loop. VersionError retry không re-fire bible HTTP call.",
        "• **Auto-manage piggyback (Phase 2)**: nếu user đã bật `/raid-auto-manage action:on` (`autoManageEnabled = true`), `/raid-status` cũng sẽ tự pull bible logs **song song** với roster refresh (Promise.all, share `bibleLimiter`) trước khi render. Re-check `autoManageEnabled` trên fresh doc trong save phase nên user bấm `action:off` giữa gather và save sẽ không bị apply thừa 1 sync. Save fail (mongo blip) → stamp attempt qua `stampAutoManageAttempt` để cooldown vẫn protect bible. Cooldown chưa hết / gather throw → render cached, không vỡ command.",
        "• **Sync button với cooldown countdown trong label** (chỉ hiện cho opted-in user): nút `🔄 Sync ngay` ngồi cùng row với `◀ Previous` / `Next ▶` (hoặc tự đứng 1 row khi user single-account). Khi đang trong cooldown, label đổi thành `🔄 Sync (Xm)` hoặc `🔄 Sync (Xs)` - user thấy ngay còn bao lâu mới sync được, không phải đoán. Cooldown hết → label collapse về `🔄 Sync ngay`. Bấm khi cooldown chưa hết → ephemeral báo wait time. Bấm khi ready → re-pull bible + apply + embed update tại chỗ không cần re-issue lệnh. Cùng cooldown gate với piggyback (`15s` Manager, `10 phút` user thường).",
        "• **Raid filter dropdown role legend**: option label theo format `<raid> (<N> pending · <X>🛡️ <Y>⚔️)` - 🛡️ = Support (Bard/Paladin/Artist/Valkyrie), ⚔️ = DPS (mọi class còn lại). Ví dụ `Aegir Hard (3 pending · 1🛡️ 2⚔️)` = caller còn 3 char chưa clear, trong đó 1 sup + 2 DPS. Khi N=0 collapse thành `(DONE)` để giảm noise. Note giải thích full pin trong tin nhắn ghim của raid-channel.",
        "• **Freshness + countdown line**: mỗi account embed có dòng `📥 Last updated Nh ago · ⏳ Next refresh in Xh · 🔄 Last synced Nm ago · ⏳ Next sync in Ym` ở description (cộng thêm dòng `🌐 All accounts: X chars · Y/Z raids done` phía trên nếu user có >1 account). Khi cooldown đã hết show `✅ Refresh ready` / `✅ Sync ready` để user biết chạy lại `/raid-status` sẽ thực sự fetch data mới thay vì đoán mò. `📥` = roster metadata (iLvl/class) gate 2h. `🔄` = auto-manage bible log sync gate **per-user** (`15s` cho Raid Manager, `10 phút` cho user thường) - chỉ hiện khi user đã opt-in.",
        "• **Footer legend với counts + page**: `🟢 N done · 🟡 M partial · ⚪ K pending · Page X/Y` - subject-scoped rollup (caller's entire roster) ở footer thay vì per-account summary trong description (bỏ vì duplicate data). Page indicator append cuối khi >1 account, move từ title xuống đây để parity với `/raid-check`. Title giờ chỉ còn `{status icon} {📁|👑} {accountName}`.",
        "• **Raid-filter dropdown**: `Filter by raid / Lọc theo raid...` narrow char cards + footer counts xuống 1 raid cụ thể trong roster của chính cậu. Options format `{Raid Label} ({N} pending)` với N = self-scoped count (chars trong roster cậu mà raid đó chưa fully cleared), sort pending desc. Labels compute 1 lần lúc init → backlog reference stable khi cậu toggle filter. Dropdown ẩn nếu roster không có eligible raid nào (0 char đủ iLvl). Cả single-account lẫn multi-account đều có filter - không cần flip page nếu chỉ muốn zoom vào 1 raid. Không reset `currentPage` khi đổi filter (page structure không đổi, raid filter chỉ rewrite nội dung hiển thị per page).",
      ],
    },
    {
      key: "raid-set",
      label: "/raid-set",
      icon: "✏️",
      short: "Update raid completion per character",
      shortVn: "Cập nhật tiến độ raid cho character",
      options: [
        { name: "roster", required: true, desc: "Roster (account) chứa character - autocomplete list các account đã đăng ký với char count suffix. Required để narrow down character autocomplete khi user có nhiều roster (Discord autocomplete cap 25 entries, 5+ rosters × 6 chars = overflow). Pick roster trước thì character autocomplete chỉ show char trong roster đó." },
        { name: "character", required: true, desc: "Tên character - autocomplete filter theo roster đã chọn (chỉ show char trong roster đó). Nếu roster chưa pick, autocomplete show chars across all accounts (legacy fallback). Same-named chars across rosters không còn collide nhờ chained roster filter." },
        { name: "raid", required: true, desc: "Raid + difficulty - autocomplete filter theo character đã chọn, kèm icon tiến độ (🟢/🟡/⚪). Raid đã hoàn thành hiển thị suffix DONE." },
        { name: "status", required: true, desc: "complete | process | reset - autocomplete. `process` đánh dấu 1 gate cụ thể; khi raid đã DONE thì dropdown tự thu còn `reset` thôi." },
        { name: "gate", required: false, desc: "Gate cụ thể - autocomplete **chỉ active khi status = Process**, dropdown đọc số gate thực tế của raid (G1/G2 cho Act 4/Kazeros/Serca hiện tại)" },
      ],
      example: "/raid-set roster:Clauseduk character:Nailaduk raid:kazeros_hard status:process gate:G1",
      notes: [
        "EN: `complete` / `reset` act on every gate. Use `process` + `gate` to touch a single gate.",
        "VN: `complete`/`reset` luôn tác động toàn bộ gate; dùng `process` + `gate` để chỉ update 1 gate.",
        "• **Roster field chained autocomplete**: pick roster trước → character autocomplete sẽ chỉ show char trong roster đó. Fix issue cũ là Discord autocomplete cap 25 entries: user với 5+ rosters × 6 char (=30+ chars) bị cut off ở top-25 by iLvl desc, lower-iLvl chars không chọn được. Giờ mỗi roster max 6 char nên luôn visible đầy đủ.",
        "• **Same-named chars disambiguation**: nếu 2 roster cùng user có char cùng tên (e.g. 'Clauseduk' tồn tại cả main lẫn alt), trước đây apply path chỉ mark char đầu tiên (first-by-iteration). Giờ với roster field, `findCharacterInUser(doc, char, rosterName)` scope lookup vào roster đã chọn - update đúng char user muốn.",
        "• **Text-monitor parser vẫn OK**: kênh `/raid-channel` parse `Act4 Hard Clauseduk` không có roster context, `applyRaidSetForDiscordId` nhận `rosterName=null` và fallback first-by-iteration. Không breaking change cho text path.",
        "• Đổi mode (ví dụ Serca Nightmare → Hard) sẽ wipe progress cũ vì raid weekly entry là mode-scoped.",
      ],
    },
    {
      key: "raid-check",
      label: "/raid-check",
      icon: "🔍",
      short: "[Raid Leader] Scan uncompleted characters",
      shortVn: "[Raid Leader] Scan nhân vật chưa hoàn thành",
      options: [
        { name: "raid", required: true, desc: "Raid + difficulty to scan / Raid + difficulty cần scan" },
      ],
      example: "/raid-check raid:kazeros_hard",
      notes: [
        "EN: Restricted to Discord user IDs configured in the `RAID_MANAGER_ID` env var (comma-separated).",
        "VN: Chỉ Discord user IDs được liệt kê trong env `RAID_MANAGER_ID` (cách nhau bằng dấu phẩy) được phép gọi. Operator config qua deploy env, không qua Discord role.",
        "• **Header**: title embed hiện `⚠️ Raid Check · <raid label> (<minItemLevel>)` - gọn, chỉ command + raid + threshold (ví dụ `Act 4 Normal (1700)`). Description đã bỏ hoàn toàn - info đều ở title, per-roster headers, và footer. Page indicator + 3-state counts đều dưới footer.",
        "• **Per-char card (inline field)**: mỗi char = 1 Discord inline field mirroring `/raid-status`'s pattern. Field name `<charName> · <iLvl>` được Discord auto-bold = scan anchor. Field value `<icon> <done>/<total>` (ví dụ `⚪ 0/2`) - value line có content nên không waste height (earlier attempt pack everything vào name line + ZWS value tạo gap 'cách nhau quá'). Aggregate 3-state icon qua `pickProgressIcon` (🟢 done all / 🟡 partial / ⚪ none). Raid label nằm ở title không lặp trong value.",
        "• **2-column layout via inline fields + spacer**: Discord default pack 3 inline field/row; chèn zero-width-space spacer field giữa mỗi cặp char để force 2-per-row - y hệt kỹ thuật `/raid-status`. Odd char cuối cùng cặp với 1 spacer để không bị Discord stretch full-width.",
        "• **2 rosters per page (chunked)**: mỗi embed page chứa tối đa 2 roster sections stacked. Roster section = non-inline header field với explicit value line. Name = `📁 accountName (displayName)` (clean label). Value = state breakdown trên dòng 1, refresh + sync trên 2 dòng riêng biệt phía dưới. **📥 Last updated** (dòng riêng) = roster data refresh (iLvl/class từ bible qua `/raid-status` lazy refresh HOẶC pre-scan refresh của `/raid-check`) - applies to ALL users, 2h cooldown. **🔄 Last synced** (dòng riêng dưới refresh) = auto-manage bible log sync (raid progress) - chỉ opted-in user, `Never synced` nếu chưa có data, cooldown **per-user** (`15s` cho Raid Manager, `10 phút` cho user thường). **⏳ Next X in Ym** countdown pairs với mỗi badge - khi cooldown còn active show thời gian còn lại, khi expired show `✅ Refresh ready` / `✅ Sync ready` để user không phải đoán mò tại sao Sync button bấm xong data không đổi. Ví dụ:\n  `4 ⚪ · 1 🟡 · 1 🟢`\n  `📥 Last updated 30m ago · ⏳ Next refresh in 1h30m`\n  `🔄 Last synced 3m ago · ⏳ Next sync in 7m`\nPer roster cost: 1 header + N char + ceil(N/2) spacer fields. 2 × 6-char rosters = 20 fields, fit 25-cap.",
        "• **All-mode raid-filter dropdown** (action row 3, chỉ xuất hiện trong `raid:all`): `Filter by raid / Lọc theo raid...` narrow char cards + footer counts xuống 1 raid cụ thể. Options format `{Raid Label} ({N} pending)`, sort pending desc. **Dynamic aggregation**: labels reactive với user-filter (và ngược lại) - pick user → raid labels show pending count của user đó; pick raid → user labels show pending count cho raid đó. Cả 2 dropdown dùng chung helper `computePendingAggregate` walk pagesData × chars × raids 1 pass per render. `currentLocalPage` không reset khi đổi raid filter (page structure không đổi).",
        "• **User filter dropdown** (action row 2): `StringSelectMenuBuilder` cho phép Raid Manager lọc pages theo Discord user. First option `🌐 All users (N pending)` reset filter. Tiếp theo top-24 users sort theo pending desc (`👤 displayName (N pending)`). Discord cap 25 options total. Selection → recompute pages chỉ chứa rosters của user đó, reset currentPage=0. `default: true` preserve selected state qua Prev/Next clicks. Rosters cùng user group consecutive, sort theo tổng pending user desc rồi per-roster pending desc. **Avatar in embed author**: khi filter = specific user, resolve Discord avatar cache-first (`client.users.cache` fallback to `fetch` via `discordUserLimiter`) và `setAuthor({name, iconURL})` trên mỗi page - visual confirmation filter đang active. Discord StringSelectMenu options không support per-option avatars (API limitation) nên embed author là compromise.",
        "• **Pagination buttons + session**: `◀ Previous` / `Next ▶` (shared helper `buildPaginationRow`) cycle giữa các roster-chunk pages. Title stable `⚠️ Raid Check · <raid> (<minItemLevel>)` không đổi theo page. Footer append page indicator. Collector locked theo người chạy, session timeout **5 phút** (`RAID_CHECK_PAGINATION_SESSION_MS`), hết hạn disable all components + swap footer legend.",
        "• **Sync badge trong roster header**: opted-in user có sync data hiện `🔄 Last synced Nm/h/d ago`. Opted-in nhưng chưa sync lần nào → `🔄 Never synced`. Non-opted-in → không hiện segment này. Kèm countdown `⏳ Next sync in Xm` (cooldown gate bởi `lastAutoManageAttemptAt`) hoặc `✅ Sync ready` khi expired. Cooldown per-user: Raid Manager (env `RAID_MANAGER_ID`) = **15s**, everyone else = **10 phút** - 2 người operators reconcile nhanh sau clear, member thường không flood bible.lostark.",
        "• **👑 Manager crown ở roster header**: roster thuộc Raid Manager (ID trong `RAID_MANAGER_ID`) swap icon header từ 📁 sang 👑 (1 crown duy nhất per roster, không prefix từng character). Scan-friendly khi roster nhiều char, và không conflict với kế hoạch thay charName bằng class-icon sau này. Non-manager roster giữ 📁. Không phân tier Owner vs Manager riêng - với 2-người deployment, cả 2 manager đều thân nhau nên single tier đủ.",
        "• **Footer legend với counts + page**: `🟢 N done · 🟡 M partial · ⚪ K pending · Page X/Y` - icon + count + English label merged, page indicator append cuối khi > 1 roster (move từ title xuống đây). Dynamic per page (page index thay đổi) compute inline trong `buildRaidCheckPage`. Discord render timestamp (`Today at HH:MM`) sau footer text tự động.",
        "• **Sort order**: users có nhiều pending tổng nhất lên top; trong mỗi user rosters sort theo pending count desc; trong mỗi roster chars sort theo iLvl desc.",
        "• **Mode bucket + actual clear**: `/raid-check` đặt char vào bucket mặc định theo iLvl trước (Serca Normal `[1710,1730)`, Hard `[1730,1740)`, Nightmare `1740+`). Nếu DB/log có clear thật ở mode khác, char vẫn hiện ở mode đã clear và ở bucket iLvl tự nhiên, kèm suffix như `2/2 (Normal Clear)` để leader biết họ đã dùng lockout ở mode nào. Hard clear không tự lọt vào Normal nếu char đã out-grown Normal.",
        "• **🔄 Sync button**: Raid Manager bấm → force-sync CHỈ cho opted-in user trong list pending (privacy-respecting - non-opted-in user KHÔNG bị force-sync). Operate trên ALL opted-in pending users (không chỉ current page), nhưng chỉ pull Bible logs cho pending char của raid đang check để giảm HTTP load. Reuse Phase 3 gather/apply pattern + `acquireAutoManageSyncSlot` in-flight guard. User nào có char update mới sẽ nhận DM riêng (skip nếu sync chạy nhưng không có data mới). Disabled nếu không có opted-in user nào trong list.",
        "• **Button customId routing**: Pagination buttons dùng prefix `raid-check-page:prev` / `raid-check-page:next` (KHÔNG `raid-check:*`) để bot.js's global `handleRaidCheckButton` dispatcher bỏ qua - collector trên reply message handle pagination locally. Sync vẫn dùng `raid-check:sync:<raidKey>` qua global router.",
        "• **Remind button removed** (Apr 2026): nút 🔔 Remind đã bỏ theo Traine's cleanup request. Raid Manager ping user manual qua Discord @mention hoặc hướng dẫn họ dùng `/raid-auto-manage action:on` / `/raid-set` tự update.",
        "• **✏️ Edit button** (Apr 2026): Raid Manager mở cascading select follow-up ephemeral để chỉnh progress của member khác (full `/raid-set` parity: Complete / Process + gate / Reset). **Auth rule**: char thuộc user đã bật auto-sync AND `publicLogDisabled=false` → ẩn khỏi dropdown vì bible sẽ ghi đè. Char `publicLogDisabled=true` (bible báo 'Logs not enabled' lần sync gần nhất) → vẫn cho edit vì bible không reach được. Non-auto-sync user → full edit. Cascade flow: user select → char select (icon 🔒 cho log-off) → raid select (filter theo iLvl) → status buttons (Complete ✅ / Process 📝 / Reset 🔄) → gate buttons (khi Process). Session timeout 5 phút collector + 15 phút Discord interaction token. Token expired hoặc UI refresh fail → bot post public tag trong channel báo leader 'session hết hạn, gõ lại /raid-check' auto-delete 30s, không để click im lặng. Apply path reuse `applyRaidSetForDiscordId` (cùng helper `/raid-set` + text-monitor), zero write logic mới.",
        "• **Discord username resolution**: cache-first (discord.js users cache). Cache miss đi qua `discordUserLimiter` (max 5 in-flight) để server đông không burst `client.users.fetch` parallel - bảo vệ khỏi Discord 50 req/s global ceiling.",
      ],
    },
    {
      key: "remove-roster",
      label: "/remove-roster",
      icon: "🗑️",
      short: "Remove a roster or a single character from it",
      shortVn: "Xóa roster hoặc 1 character trong roster",
      options: [
        { name: "roster", required: true, desc: "Roster name - autocomplete từ roster đã lưu" },
        { name: "action", required: true, desc: "`Remove entire roster` hoặc `Remove a single character`" },
        { name: "character", required: false, desc: "Character cần xóa - autocomplete theo roster đã chọn (required nếu action = Remove a single character)" },
      ],
      example: "/remove-roster roster:Qiylyn action:Remove a single character character:Zywang",
      notes: [
        "EN: Delete an entire account, or just one character from it. The account stays even if all characters are removed.",
        "VN: Xóa cả account roster, hoặc chỉ 1 character trong đó. Account vẫn giữ lại dù không còn character nào.",
        "• Dùng kết hợp với `/add-roster`: muốn refresh 1 roster → `/remove-roster` rồi `/add-roster` lại.",
      ],
    },
    {
      key: "raid-channel",
      label: "/raid-channel",
      icon: "📢",
      short: "[Admin] Configure the raid-clear monitor channel",
      shortVn: "[Admin] Config channel để bot tự parse text → update raid",
      options: [
        { name: "config action:<x> [channel:<y>]", required: true, desc: "Single subcommand `config` - all admin actions dispatched via the `action` option" },
        { name: "action:show", required: false, desc: "Hiển thị channel + health check permissions + deploy-flag warnings" },
        { name: "action:set channel:<channel>", required: false, desc: "Đăng ký 1 text channel làm monitor + post & pin welcome embed" },
        { name: "action:clear", required: false, desc: "Tắt monitor + reset schedule" },
        { name: "action:cleanup", required: false, desc: "Xóa thủ công mọi message không pin (giữ welcome pinned)" },
        { name: "action:repin", required: false, desc: "Delete stale welcomes + post & pin 1 welcome mới" },
        { name: "action:schedule-on", required: false, desc: "Bật auto-cleanup mỗi 30 phút (slot :00 và :30 giờ VN)" },
        { name: "action:schedule-off", required: false, desc: "Tắt auto-cleanup 30 phút" },
      ],
      example: "/raid-channel config action:set channel:#raid-clears",
      notes: [
        "EN: Users post short messages like `Serca Nightmare Clauseduk` or `Serca Nor Soulrano G1`; bot parses, deletes the source message, and DMs the author a private confirmation embed.",
        "VN: Post message dạng `<raid> <difficulty> <character> [gate]` vào channel đã config - bot tự update raid, xóa message, và DM xác nhận riêng cho chính người post.",
        "• **Whisper acknowledgement trước khi xóa** (Apr 2026): khi parse thành công + DM gửi được, Artist post 1 dòng whisper tag user trong channel (`*thì thầm* @user ...Artist nhận được rồi nha~ Chờ 5 giây gửi DM...`) rồi mới xóa tin nhắn gốc + whisper sau 5 giây. User có visual confirmation trước khi tin vanish, không bị nhầm với rejection silent. Nếu DM fail → fallback public message hiện tại đảm nhận confirm (không kèm whisper để không double-post).",
        "• **Aliases**: `act 4` / `act4` / `armoche` · `kazeros` / `kaz` · `serca` (accept typo `secra`) · `normal` / `nor` / `nm` · `hard` / `hm` · `nightmare` / `9m` · gates `G1` / `G2`. Lưu ý: `nm` hiện là alias của **Normal** (không phải Nightmare), Nightmare chỉ còn `9m` shorthand.",
        "• Không có gate = đánh dấu cả raid done (complete). Có gate `G_N` = **cumulative: mark G1 đến G_N đều done** (Lost Ark sequential progression - đi tới G2 nghĩa là G1 đã qua).",
        "• Chỉ poster tự update char của mình (cần có roster đã đăng ký qua `/add-roster`).",
        "• **Multi-char trong 1 post**: liệt kê nhiều tên cách nhau bằng space/comma/+ - ví dụ `Act4 Hard Priscilladuk, Nailaduk`. Bot apply raid update cho từng char, DM 1 embed aggregated (done/already-done/not-found/iLvl-thiếu grouped).",
        "• Nếu trong post có char gõ sai, Artist sẽ ping user trong channel với tên char không tìm thấy - các char hợp lệ khác vẫn được update bình thường.",
        "• **Set**: kiểm tra bot permission trong channel đích, **post + pin welcome fresh trước**, rồi mới unpin welcome cũ (safe-order - partial failure giữ welcome cũ để channel không mất guidance). Sau khi welcome post success, Artist post thêm 1 **greeting ephemeral** vào channel (giọng Dusk, signed Artist, TTL 2 phút) để members đang online thấy Artist vừa 'đến trông coi' - welcome pin là long-lived documentation, greeting là ceremonial moment. Greeting dùng `postChannelAnnouncement` helper shared với hourly-cleanup notice + weekly-reset + private-log nudge.",
        "• **Show**: hiển thị channel + health check permissions + deploy-flag warnings.",
        "• **Clear**: tắt monitor ngay, luôn write-through Mongo; cũng reset `autoCleanupEnabled` để schedule không tự kích lại khi admin `/set` channel mới.",
        "• **Cleanup**: xóa thủ công mọi message không pin trong monitor channel (giữ welcome pinned). Paginate đến hết channel. Messages > 14 ngày Discord không cho bulk-delete, bot sẽ report `skipped (>14 ngày)` để admin xóa tay nếu cần.",
        "• **Repin**: safe-order như Set - post + pin fresh trước, unpin stale sau. `welcomeMessageId` tracked trong DB để unpin đúng message cũ, không ảnh hưởng bot pins khác trong channel.",
        "• **Schedule on/off**: toggle auto-cleanup 30 phút. Bật → mỗi slot :00 và :30 giờ VN, bot tự xóa non-pinned trong channel. **Cleanup chạy trước**, sau đó post 1 biển báo 4-bucket tone (sạch sẵn / trivial 1-5 / normal 6-20 / heavy 21+) với 3 variant random pick mỗi bucket để không bị đơn điệu, signed Artist, giọng Dusk không stage-direction. Cả 4 bucket đều tự xóa sau 5 phút (`AUTO_CLEANUP_NOTICE_TTL_MS`). Reason vẫn nói khi idle: silence trong scheduled window đọc giống 'bot offline/broken'; content-tone notice double làm heartbeat + idle marker. Key format: `lastAutoCleanupKey = 'YYYY-MM-DDTHH:MM'` với MM ∈ {00, 30} trong VN time (đổi từ hourly 'YYYY-MM-DDTHH' → 30-min resolution, legacy hour-keys không match → 1 lần re-sweep sau deploy, harmless). Enable stamp current slot key ngay nên tick đầu tiên sau enable chờ đến slot kế, không catch-up ngay. Bot-offline catch-up chỉ hoạt động khi schedule đã enable continuous. Tick cadence 30 phút align 1-1 với slot boundary. Tắt → chỉ cleanup thủ công (manual cleanup KHÔNG post biển báo, user đã biết đang chạy).",
        "• **Artist quiet hours 3:00-8:00 VN + ceremonial bedtime/wake-up**: cùng scheduler tick với auto-cleanup nhưng dispatch 3 nhánh: (1) **quiet branch** - hour ∈ [3, 8) → skip sweep + skip hourly notice; tick đầu tiên post 1 bedtime embed (3 variants pool, TTL 5 phút, dedup `lastArtistBedtimeKey = YYYY-MM-DD` VN calendar), các tick sau silent no-op. (2) **wake-up branch** - tick đầu ≥ 8:00 VN trong ngày chưa wake-up → sweep 1 lần catch-up toàn bộ non-pinned tích đêm qua + post combined wake-up embed (4-bucket pool riêng như cleanup nhưng tone 'vừa ngủ dậy', TTL 10 phút, dedup `lastArtistWakeupKey = YYYY-MM-DD`); cũng stamp `lastAutoCleanupKey` slot 8:00 nên tick 8:30 không double-sweep. (3) **normal branch** - hour ≥ 8 AND wake-up đã fire hôm nay → hourly-cleanup path hiện có. Message parsing (raid clear post) vẫn active 24/7, chỉ scheduler-side ngủ. Admin `/raid-channel config action:schedule-off` tắt luôn cả 3 branch. Per-guild disable bedtime/wake-up cá nhân qua `/raid-announce artist-bedtime action:off` hoặc `artist-wakeup action:off` (schema subdoc `announcements.artistBedtime/artistWakeup`).",
        "• Parse fail (không phải raid intent) → bot im lặng.",
        "• Lỗi phục hồi được (char không có, iLvl thiếu, combo sai, nhiều raid/difficulty/gate) → bot ping user reply persistent, tự dọn khi user post lại hoặc sau 5 phút TTL. Hint và message gốc của user cùng bị dọn để channel heal về clean state.",
        "• **Raid đã clear từ trước** → bot DM user embed `Raid đã DONE rồi~` thay vì re-stamp timestamp + fresh success DM. Không update DB, tránh nhầm lẫn. Muốn reset thì chạy `/raid-set status:reset`.",
        "• **Per-user cooldown 2 giây** content-aware: duplicate content trong cooldown → drop + delete message. Different content khi có pending hint (đang fix lỗi) → **1 exception duy nhất/cooldown window** (không spam-bypass). Spam ≥3 hit trong 10s → kitsune warning, dedup 60s.",
        "• Deploy: bật `Message Content Intent` ở Discord Developer Portal, hoặc set `TEXT_MONITOR_ENABLED=false` để chạy slash-command-only.",
        "• **Permissions bot cần trong channel đích**: `View Channel`, `Send Messages`, `Manage Messages`, `Read Message History`, `Embed Links`. Thiếu 1 trong 5 là `/raid-channel config action:set` reject.",
        "• Admin-only command (yêu cầu `Manage Server` permission).",
      ],
    },
    {
      key: "raid-auto-manage",
      label: "/raid-auto-manage",
      icon: "🤖",
      short: "Auto-sync raid progress from lostark.bible",
      shortVn: "Tự động sync tiến độ raid từ lostark.bible logs",
      options: [
        { name: "action:on", required: false, desc: "Bật auto-sync + **probe roster trước** → nếu có char chưa bật Public Log, Artist hiện warning với nút `Vẫn bật` / `Huỷ` (60s timeout). Pass thì kickstart 1 lần sync ngay." },
        { name: "action:off", required: false, desc: "Tắt auto-sync" },
        { name: "action:sync", required: false, desc: "Manual sync - pull logs từ bible ngay và reconcile vào DB" },
        { name: "action:status", required: false, desc: "Xem state on/off + **Last success** (lần sync có ≥1 char thành công) + **Last attempt** (lần gọi gần nhất - hiện `- fail` khi các attempt sau success đều lỗi)" },
      ],
      example: "/raid-auto-manage action:sync",
      notes: [
        "EN: Pulls clear logs from `lostark.bible/api/character/logs` for every character in your roster, maps each boss → raid/gate, and updates `assignedRaids` for this week (filtering by weekly-reset boundary).",
        "VN: Kéo clear logs từ lostark.bible cho tất cả char trong roster, map boss → raid/gate rồi update progress tuần này.",
        "• **Boss mapping**: Armoche G1 = Brelshaza Ember / G2 = Armoche Sentinel · Kazeros G1 = Abyss Lord / G2 = Archdemon (Normal) hoặc Death Incarnate (Hard) · Serca G1 = Witch of Agony / G2 = Corvus Tul Rak.",
        "• **Bus clears** (`isBus: true`) vẫn được count làm clear - theo decision của chủ git.",
        "• **Filter theo weekly reset**: chỉ logs `timestamp >= 5h chiều thứ 4 (17:00 VN = 10:00 UTC)` gần nhất mới được apply, cũ hơn skip.",
        "• **Pagination**: logs API được gọi lặp `page: 1, 2, …` (25 entries/page) cho tới khi gặp entry ra khỏi tuần HOẶC page partial HOẶC cap `maxPages=10` (=250 entries safety). Char nhiều clear trong tuần (practice, bus) không bị miss.",
        "• **Sort ASC trước reconcile**: bible trả newest-first nhưng Artist sort oldest→newest để latest-mode luôn thắng khi có mode-switch wipe.",
        "• **Mode-switch**: nếu bible log báo clear Serca NM nhưng DB đang track Serca Hard cho char đó, bible-wins - Artist wipe raid progress cũ rồi ghi theo mode mới.",
        "• **Cached meta**: lần đầu sync phải scrape HTML page `/roster` để lấy `characterSerial + cid + rid`; các lần sau dùng cache trong DB → chỉ tốn 1 API call per char.",
        "• **Rate limit + timeout**: cả meta-scrape (HTML `/roster` page) lẫn logs API đều đi qua `bibleLimiter` (max 2 request concurrent) - share với `/raid-status` refresh. Cold-cache sync (roster mới, cần meta+logs per char) không bypass được cap 2-in-flight. Mỗi HTTP call gắn `AbortSignal.timeout(15s)` - bible treo connection sẽ auto-abort thay vì giữ slot + inFlight guard vô hạn.",
        "• **Gather/apply split**: bible HTTP chạy trong **gather phase OUTSIDE `saveWithRetry`**, rồi apply phase trong retry loop chỉ mutate in-memory. VersionError retry KHÔNG re-fire bible call nữa. Probe + commit share cùng `collected` array → chi phí giảm từ 2× bible run xuống 1×.",
        "• **Last success vs Last attempt**: nếu Cloudflare block hoặc bible trả `Logs not enabled` cho TẤT CẢ char, `lastAutoManageSyncAt` không được stamp (chỉ `lastAutoManageAttemptAt`). `action:status` surface cả 2 để admin thấy rõ khi sync đang fail liên tục.",
        "• **Private logs → `Logs not enabled` body match**: chỉ phân loại char là private khi bible response body chứa chuỗi `Logs not enabled` (confirmed payload). Generic HTTP 403 (Cloudflare block, rate-limit, IP deny) KHÔNG bị misclassify thành private nữa - những case đó hiện ở bucket Fail với raw error message, bật `Show on Profile` sẽ không cứu được. Bot không auth thay user được (cookie HTTP-only, upload token write-only - đã test 2026-04-21).",
        "• **Probe-before-enable**: khi gõ `action:on`, Artist chạy 1 lần sync **in memory** (không save) để phân loại char visible vs private. Nếu có char private → hiện warn embed với 2 nút `Vẫn bật` / `Huỷ`, timeout 60s = default Huỷ. Confirm thì re-run sync trên fresh doc rồi save; Cancel/timeout thì flag giữ OFF, không save gì **nhưng `lastAutoManageAttemptAt` vẫn được stamp** - probe HTTP đã tốn bible quota, cooldown phải phản ánh điều đó (không thì user spam `on` + Huỷ bypass được sync cooldown per-user).",
        "• **Per-user sync throttle**: cooldown + in-flight guard. Cooldown **per-user**: Raid Manager (env `RAID_MANAGER_ID`) = 15s, mọi user khác = 10 phút - operators reconcile nhanh sau clear, member thường không spam bible. `action:sync` spam → reject ephemeral với remaining time. `action:on` đang in-flight thì reject; đang cooldown thì vẫn flip flag nhưng skip cả probe lẫn sync, báo user chờ X phút/giây rồi gõ `sync` sau.",
        "• **Dynamic action dropdown**: dropdown autocomplete hide option dư thừa theo state - đang ON thì không show `on`, đang OFF thì không show `off`. Typed-paste `on`/`off` khi redundant → ephemeral reject. Action lạ (paste arbitrary string không thuộc `on/off/sync/status`) → ephemeral reject ngay đầu handler, không fall-through Discord-timeout.",
        "• **Phase 2 - auto-sync piggyback vào `/raid-status`**: khi `autoManageEnabled = true` + cooldown per-user cho phép (`15s` cho Raid Manager, `10 phút` cho user thường), mỗi lần user gõ `/raid-status` Artist sẽ pull bible logs **song song** với roster refresh (Promise.all, share `bibleLimiter`) trước khi render embed. Reuse cùng `acquireAutoManageSyncSlot` nên spam `/raid-status` không spam bible. Race-safe: re-check `autoManageEnabled` trên fresh doc trong `saveWithRetry`, nếu user bấm `action:off` giữa gather và save → skip apply nhưng vẫn stamp `lastAutoManageAttemptAt` (bible quota đã tốn). Save fail (mongo blip) → catch stamp attempt qua `stampAutoManageAttempt` để cooldown vẫn kick in. Cooldown chưa hết / in-flight → render cached, silent skip. Gather throw (Cloudflare/timeout) → swallow + log + render cached, không vỡ `/raid-status`.",
        "• **Phase 3 - 24h passive auto-sync background scheduler**: opted-in user nào chưa sync trong 24h sẽ được background tick (mỗi 30 phút) tự pull bible logs, batch tối đa **3 user/tick** sort theo `lastAutoManageAttemptAt` ascending (chứ KHÔNG phải `lastAutoManageSyncAt`) - đảm bảo stuck user (perma-fail Cloudflare/private log) không monopolize batch forever, mọi user đều có rotation fair. Reuse cùng `acquireAutoManageSyncSlot` nên không double-fire với Phase 2 piggyback / manual `action:sync`. Filter ở DB level (`lastAutoManageSyncAt < now - 24h`) → user active đã sync gần đây tự bypass tick. **Tick overlap guard**: nếu tick trước chưa xong khi 30 phút mới đến (bible outage worst case), tick mới skip để không double traffic. **Summary log honesty**: tick log split 4 bucket (`synced` / `attempted-only` / `skipped` / `failed`) - chỉ count `synced` khi có ≥1 char success, tránh false-positive metric. **Killswitch**: env `AUTO_MANAGE_DAILY_DISABLED=true` skip mọi tick - flip nhanh nếu bible block, không cần redeploy. Bible HTTP load: batch 3 × 5 chars × ~6 HTTP avg = ~90 HTTP/tick max, spread qua 48 ticks/day cover được ~144 user-syncs/day capacity.",
        "• **Stuck private-log channel nudge (Apr 2026)**: khi tick detect user có `report.perChar` toàn `isPublicLogDisabledError` (tất cả char trả `Logs not enabled`), Artist post 1 channel announcement tag user trong guild đầu tiên user là member, đích resolve qua `announcements.stuckPrivateLogNudge.channelId || raidChannelId`, TTL 30 phút, dedup 7 ngày qua `User.lastPrivateLogNudgeAt`. Giọng Dusk (signed Artist, no stage-direction) hướng user vào `lostark.bible/me/logs` bật **Show on Profile**. Chỉ post khi bot cache có member record (cache-first, skip nếu cold members cache - không force fetch). Channel thay vì DM: Traine chọn tone nhẹ nhàng công khai, tránh DM áp lực. Reuse `postChannelAnnouncement` helper shared với hourly-cleanup notice + weekly-reset + /raid-channel set greeting.",
      ],
    },
    {
      key: "raid-announce",
      label: "/raid-announce",
      icon: "📣",
      short: "[Admin] Configure Artist's channel announcements",
      shortVn: "[Admin] Tắt/bật + override channel cho từng loại announcement",
      options: [
        { name: "type", required: true, desc: "Loại announcement - dropdown 7 giá trị: `weekly-reset` / `stuck-nudge` / `set-greeting` / `hourly-cleanup` / `artist-bedtime` / `artist-wakeup` / `whisper-ack`. Hai loại đầu là CHANNEL_OVERRIDABLE (chấp nhận `set-channel`), 5 loại sau là CHANNEL_BOUND (chỉ toggle on/off được)." },
        { name: "action", required: true, desc: "`show` xem config · `on`/`off` toggle enabled · `set-channel` override destination (cần option `channel`, chỉ overridable types) · `clear-channel` xóa override (revert về monitor channel mặc định)" },
        { name: "channel", required: false, desc: "Channel đích - chỉ cần khi action:set-channel. Phải là text channel trong cùng guild." },
      ],
      example: "/raid-announce type:weekly-reset action:set-channel channel:#raid-announcements",
      notes: [
        "• **Override resolution note**: 2 type overridable (`weekly-reset`, `stuck-nudge`) resolve đích qua `announcements.<type>.channelId || raidChannelId`, nên `/raid-announce ... action:set-channel` vẫn chạy kể cả khi monitor channel chưa set.",
        "EN: Manage Artist's 7 channel-announcement surfaces per guild. Two axes: enabled toggle + channel override (overrideable types only).",
        "VN: Quản lý 7 loại announcement Artist đang post vào channel, per-guild. 2 trục config: enabled + channel override.",
        "• **7 announcement types**: `weekly-reset` (Wed 17 VN tuần mới), `stuck-nudge` (phase 3 tick tag user toàn char private log), `set-greeting` (greeting ephemeral sau /raid-channel action:set), `hourly-cleanup` (notice sau cleanup mỗi slot 30 phút ban ngày), `artist-bedtime` (3h sáng VN Artist đi ngủ), `artist-wakeup` (8h sáng VN Artist dậy + catch-up sweep), `whisper-ack` (tag user trong channel khi /raid-channel post clear DM success).",
        "• **Channel-overridable vs channel-bound**: `weekly-reset` + `stuck-nudge` là pure announcements/tags có thể redirect sang #announcements riêng. 5 loại còn lại (`set-greeting` / `hourly-cleanup` / `artist-bedtime` / `artist-wakeup` / `whisper-ack`) bound với monitor channel vì content refer cụ thể tới channel đó (\"channel này vừa dọn xong\" / \"Artist được mời đến channel này\" / bedtime-wakeup đều nói về channel này / whisper reply tin gốc) - `set-channel`/`clear-channel` sẽ reject với 5 loại bound này.",
        "• **Fallback chain**: mỗi fire resolve channel qua `announcements.<type>.channelId || raidChannelId`. Override null = revert về monitor channel mặc định (set qua `/raid-channel config action:set`). Nếu cả 2 null → guild chưa setup monitor → announcement silent skip không crash.",
        "• **Defaults**: mỗi type `enabled=true` + `channelId=null` khi schema default chạy. Legacy guild không có `announcements` subdoc → `getAnnouncementsConfig` normalize về defaults nên backward-compatible, không breaking.",
        "• **Mongo path**: `GuildConfig.announcements.<subdocKey>.enabled|channelId`. Subdoc key map: `weekly-reset`→`weeklyReset`, `stuck-nudge`→`stuckPrivateLogNudge`, `set-greeting`→`setGreeting`, `hourly-cleanup`→`hourlyCleanupNotice`, `artist-bedtime`→`artistBedtime`, `artist-wakeup`→`artistWakeup`, `whisper-ack`→`whisperAck`. Keys sống trong central `ANNOUNCEMENT_REGISTRY` object (raid-command.js) - single source of truth cho label + subdocKey + channelOverridable flag. Adding a new type: 1 registry entry + 1 schema subdoc + firing site code (không cần edit command builder hay helper vì tất cả derived).",
        "• **Redundant-state guard**: `action:on` khi đang ON → ephemeral reject \"đã on rồi\", không tạo Mongo write thừa. Tương tự `action:off` khi đã OFF. `clear-channel` khi đã không có override → ephemeral info.",
        "• **Require Manage Guild**: same as `/raid-channel` config. Server owner + admin only.",
      ],
    },
  ];
  function buildHelpOverviewEmbed() {
    const embed = new EmbedBuilder()
      .setTitle("🎯 Raid Management Bot - Help")
      .setDescription(
        [
          "**EN:** Lost Ark raid progress tracker for Discord. Pick a command below for details.",
          "**VN:** Bot quản lý tiến độ raid Lost Ark. Chọn command ở dropdown để xem chi tiết.",
        ].join("\n")
      )
      .setColor(UI.colors.neutral)
      .setFooter({ text: "Type /raid-help anytime · Soạn /raid-help bất cứ lúc nào" })
      .setTimestamp();
    for (const section of HELP_SECTIONS) {
      embed.addFields({
        name: `${section.icon} ${section.label}`,
        value: `${section.short}\n_${section.shortVn}_`,
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
  function buildHelpDetailEmbed(sectionKey) {
    const section = HELP_SECTIONS.find((item) => item.key === sectionKey);
    if (!section) return buildHelpOverviewEmbed();
    const embed = new EmbedBuilder()
      .setTitle(`${section.icon} ${section.label}`)
      .setDescription(`**EN:** ${section.short}\n**VN:** ${section.shortVn}`)
      .setColor(UI.colors.neutral);
    if (section.options.length > 0) {
      const optionLines = section.options.map((opt) => {
        const req = opt.required ? "✅" : "⚪";
        return `${req} \`${opt.name}\` - ${opt.desc}`;
      });
      addChunkedHelpField(embed, "Options", optionLines.join("\n"));
    } else {
      embed.addFields({ name: "Options", value: "_No options_", inline: false });
    }
    embed.addFields({ name: "Example", value: `\`${section.example}\``, inline: false });
    addChunkedHelpField(embed, "Notes", section.notes.join("\n"));
    return embed;
  }
  function buildHelpDropdown() {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("raid-help:select")
      .setPlaceholder("📖 Pick a command for details... / Chọn command để xem chi tiết...")
      .addOptions(
        HELP_SECTIONS.map((section) => ({
          label: section.label,
          value: section.key,
          description: section.short.slice(0, 100),
          emoji: section.icon,
        }))
      );
    return new ActionRowBuilder().addComponents(menu);
  }
  async function handleRaidHelpCommand(interaction) {
    await interaction.reply({
      embeds: [buildHelpOverviewEmbed()],
      components: [buildHelpDropdown()],
      flags: MessageFlags.Ephemeral,
    });
  }
  async function handleRaidHelpSelect(interaction) {
    const sectionKey = interaction.values?.[0];
    await interaction.update({
      embeds: [buildHelpDetailEmbed(sectionKey)],
      components: [buildHelpDropdown()],
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
