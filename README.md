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
- `/raid-channel` + text monitor: post message ngắn `<raid> <difficulty> <character> [gate]` vào channel đã config - bot tự parse, update raid, xóa message

## Commands

### `/add-roster`

Sync roster từ `lostark.bible` và lưu top-N characters theo combat score.

| Option | Required | Mặc định | Mô tả |
|--------|----------|----------|-------|
| `name` | ✅ | - | Tên 1 character trong roster muốn sync |
| `total` | ❌ | 6 | Số characters muốn lưu (1-6) |

Ví dụ: `/add-roster name:Clauseduk total:6`

Lưu ý: Nếu character/account đã tồn tại trong roster khác của cùng Discord user, bot sẽ từ chối với cảnh báo ephemeral.

### `/raid-status`

Hiển thị tiến độ raid của tất cả characters, **paginated 1 roster = 1 page**, 2 characters per row.

**Ký hiệu trong output:**

- `🟢` - Raid hoàn thành tất cả gates (`done/total` khớp)
- `🟡` - Partial progress (ít nhất 1 gate đã xong, nhưng chưa full)
- `⚪` - Chưa xong gate nào
- `🔒` - Character chưa đủ item level cho raid nào

Mỗi dòng raid hiển thị dạng `{icon} {raid name} · {done}/{total}` - ví dụ `🟢 Kazeros Hard · 2/2` hoặc `🟡 Serca Hard · 1/2`. Raid order per character: **Act 4 → Kazeros → Serca**, top-to-bottom (Serca Hard trước Serca Nightmare).

**Embed color động** theo tổng thể per-account: **xanh lá** nếu tất cả raid đã xong, **vàng** nếu đang có tiến triển, **blurple** nếu chưa bắt đầu gì.

**Pagination:** Nếu có nhiều hơn 1 roster, xuất hiện `◀ Previous` / `Next ▶` buttons (Secondary style). Chỉ người chạy command mới điều khiển được. Session timeout **2 phút** - hết hạn thì buttons disable + footer đổi thành `⏱️ Session đã hết hạn (120s) · Dùng /raid-status để xem lại`.

**Lazy auto-refresh iLvl từ lostark.bible:**
- Mỗi account có 2 timestamp: `lastRefreshedAt` (success) + `lastRefreshAttemptAt` (attempt - success OR all-seeds-failed).
- Khi `/raid-status` chạy: account nào có `lastRefreshedAt` > **2 tiếng** (hoặc chưa bao giờ) → background fetch lostark.bible, update `itemLevel` + `combatScore` + `class` cho các char match theo name.
- Trong window 2h → zero API calls, dùng cache.
- Raid progress (`assignedRaids`), `weeklyResetKey`, `tasks` **được bảo toàn** - refresh chỉ đụng roster-shape fields.
- Cooldown 2h align với upstream cadence của lostark.bible (họ cũng update mỗi char ~2h).
- **Failure cooldown 5 phút**: nếu seed list (accountName + mọi char name) đều fail hoặc no-overlap với saved roster, stamp `lastRefreshAttemptAt` để skip account đó **5 phút** trước khi retry. Không stamp thì spam `/raid-status` trong lúc failing sẽ queue N seed × bible fetch mỗi lần. Tự heal khi hết cooldown hoặc user sửa roster qua `/add-roster` (re-stamp success).
- **Timeout 15s per fetch**: mỗi HTTP call gắn `AbortSignal.timeout(15000)` - bible treo connection sẽ auto-abort thay vì giữ `bibleLimiter` slot vô hạn.
- **Gather/apply split**: phase A (read seed doc + bible fetches) chạy OUTSIDE `saveWithRetry`; phase B (apply vào fresh doc + save) trong retry loop là pure in-memory mutation. VersionError retry KHÔNG re-fire bible HTTP call nữa - tiết kiệm được full roster scrape khi có concurrent save race với `/raid-set`.
- **Auto-manage piggyback (Phase 2)**: nếu `User.autoManageEnabled = true`, gather phase pull thêm bible logs cho toàn roster (gate bởi cooldown 5 phút + in-flight guard của `/raid-auto-manage` - share cùng `acquireAutoManageSyncSlot`). Apply phase merge cả refresh data lẫn auto-manage report vào cùng fresh doc, lưu trong 1 save → atomic. Nếu cooldown chưa hết hoặc gather throw → silent skip auto-manage, vẫn render với cached data. User opt-in chỉ cần gõ `/raid-status` để vừa xem progress vừa auto-pull bible - không cần `action:sync` riêng.
- Fetch failure (Bible down, rate limit) → log warning + skip account đó, command vẫn render cached data.

Đặc biệt Serca: Characters ở item level 1740+ sẽ thấy Serca Hard **và** Nightmare là hai lựa chọn riêng biệt.

### `/raid-set`

Update trạng thái raid cho 1 character cụ thể.

| Option | Required | Choices |
|--------|----------|---------|
| `roster` | ✅ | Roster (account) chứa character - **autocomplete** list các account đã đăng ký với suffix char count (`📁 Clauseduk · 6 chars`). Required để narrow down character autocomplete khi user có nhiều roster (Discord autocomplete cap 25 entries; 5+ rosters × 6 chars = overflow, lower-iLvl chars bị cut). Chained: pick roster → character autocomplete filter theo roster đó. |
| `character` | ✅ | Tên character - **autocomplete** filter theo roster đã chọn (chỉ show char trong roster đó), format `name · class · iLvl`. Mỗi roster max 6 char nên luôn fit 25-cap. Nếu roster chưa pick (autocomplete fires per-keystroke), fallback show chars across all accounts (legacy top-25 by iLvl desc). |
| `raid` | ✅ | Raid + difficulty - **autocomplete** filter theo character đã chọn: chỉ show raids đủ iLvl, kèm icon tiến độ (`🟢 done · 🟡 partial · ⚪ pending · x/y`). Thứ tự luôn `Act 4 → Kazeros → Serca`, và trong từng raid thì `Normal → Hard → Nightmare` (khớp thứ tự card trong `/raid-status`). Raid đã hoàn thành hiển thị thêm suffix ` · DONE` để nổi bật. Values: `armoche_normal`, `armoche_hard`, `kazeros_normal`, `kazeros_hard`, `serca_normal`, `serca_hard`, `serca_nightmare`. |
| `status` | ✅ | **autocomplete** - mặc định hiện `Complete` (cả raid xong), `Process` (1 gate xong), `Reset` (xoá về 0). Khi raid đã `done/done` cho character đã chọn thì dropdown chỉ còn `Reset (raid đã hoàn thành - chỉ có thể reset)` để tránh click nhầm. |
| `gate` | ❌ | **autocomplete**, chỉ active khi `status = Process`. Dropdown đọc `getGatesForRaid(raidKey)` từ `src/models/Raid.js` nên luôn khớp đúng số gate thực tế của raid (Act 4/Kazeros/Serca hiện tại = G1, G2). Với `Complete`/`Reset` thì gate trả empty để tín hiệu "không cần chọn" - hai action này luôn tác động lên toàn bộ gate. `Process` bắt buộc phải có `gate`, nếu thiếu thì bot reject. |

Ví dụ: `/raid-set roster:Clauseduk character:Nailaduk raid:kazeros_hard status:complete`

**Same-named chars disambiguation**: nếu 2 roster của cùng user có char trùng tên (main + alt `Clauseduk` chẳng hạn), roster field scope lookup vào roster đã chọn nên `findCharacterInUser(doc, charName, rosterName)` trả đúng char thay vì first-by-iteration.

**Text-monitor parser** (`/raid-channel` text post như `Act4 Hard Clauseduk`) không có roster context - `applyRaidSetForDiscordId` nhận `rosterName=null` và fallback first-by-iteration. Không breaking change cho text path.

### `/raid-check`

**Chỉ dành cho Discord user IDs liệt kê trong env `RAID_MANAGER_ID`** (cách nhau bằng dấu phẩy). Scan tất cả characters đủ item level nhưng chưa hoàn thành raid ở difficulty được chọn.

Output là **embed ephemeral** với pagination (1 roster = 1 page), mirror pattern của `/raid-status`:
- Color động theo difficulty: đỏ = Nightmare, vàng = Hard, blurple = Normal
- **Title**: `⚠️ Raid Check · <raid label> (<minItemLevel>)` - gọn, chỉ command + raid + threshold trong parens (ví dụ `Act 4 Normal (1700)`). Page indicator đã move xuống footer.
- **Description (2 dòng)**: line 1 = global summary ngắn gọn `<pending>/<eligible> pending (<pct>%)`, line 2 = current page's roster header `📁 <accountName> (<displayName>) · N pending · 🔄<relative>`. Char cards bắt đầu sát dưới description - không có wasted spacer row.
- **Per-char card (inline field)**: mỗi character = 1 Discord inline field mirroring `/raid-status`'s 2-col card pattern. Field name `<charName> · <iLvl>` auto-bold = scan anchor. Field value `<icon> <done>/<total>` (ví dụ `⚪ 0/2`) - value line có content nên không waste height (earlier attempt pack everything vào name + ZWS value tạo gap "cách nhau quá"). **Aggregate 3-state icon** qua helper `pickProgressIcon`: 🟢 (all gates done), 🟡 (partial - ít nhất 1 gate done), ⚪ (none done). iLvl round integer (`1744` thay `1744.17`). Raid label nằm ở title không lặp trong value.
- **2-column layout via Discord inline fields**: Discord default pack 3 inline fields/row; chèn zero-width-space spacer field giữa mỗi cặp char để force 2-per-row - kỹ thuật y hệt `buildAccountPageEmbed` của `/raid-status`. Odd char cuối cùng cặp với 1 spacer để không stretch full-width.
- **Pagination buttons + session**: `◀ Previous` / `Next ▶` (từ shared helper `buildPaginationRow` - `/raid-status` cũng dùng cùng helper, chỉ khác customId prefix) cycle giữa roster pages. Session timeout **2 phút** (shared constant `PAGINATION_SESSION_MS`), hết hạn thì disable buttons + footer đổi thành `⏱️ Session đã hết hạn (120s) · Dùng /raid-check để xem lại`. Collector lock theo người chạy command - user khác click prev/next sẽ nhận ephemeral reject.
- **Sync badge trong roster header**: opted-in user có sync data hiện `🔄5m` / `🔄2h` / `🔄3d` (relative time tự compute, English units để giữ segment ngắn). Opted-in chưa sync lần nào → `🔄never`. Non-opted-in → không hiện segment.
- **Action row 3 buttons**: `◀ Prev` + `Next ▶` + `🔄 Sync N opted-in`. Pagination customId prefix `raid-check-page:*` (deliberately khác `raid-check:*` để bot.js's global dispatcher bỏ qua, collector handle pagination locally). Sync vẫn dùng customId `raid-check:sync:<raidKey>` routing qua global handler. **Sync operate trên ALL opted-in pending users** (không chỉ current page) - pagination chỉ là viewing surface, action là bulk.
- **Footer legend với counts + page**: `🟢 N done · 🟡 M partial · ⚪ K pending · Page X/Y` - icon + count + English label merged per-state, page indicator append cuối khi roster > 1 (moved từ title xuống). Dynamic per page (page index thay đổi), compute inline trong `buildRaidCheckPage`. Discord tự render timestamp (`Today at HH:MM`) sau footer text.
- **🔄 Sync button**: bấm → trigger bible auto-sync CHỈ cho user opted-in (`User.autoManageEnabled = true`) trong list pending. Reuse Phase 3 gather/apply + `acquireAutoManageSyncSlot` (share cooldown với /raid-auto-manage, không double-fire bible). User nào sync xong có char update mới sẽ nhận DM riêng với delta (skip nếu sync không có data mới để tránh spam). Button tự disable nếu không có opted-in user trong list - tránh click-then-reject confusion.
- **Remind button removed** (Apr 2026): nút 🔔 Remind đã bỏ theo Traine's cleanup request. Raid Manager ping user manual qua Discord @mention hoặc hướng dẫn họ dùng `/raid-auto-manage action:on` / `/raid-set` để tự update.
- Empty state (mọi người đã xong): embed xanh lá `✅ All eligible characters have completed...`
- **Discord username resolution**: cache-first (`client.users.cache.get`) - phần lớn user có trong cache từ các gateway events trước đó, không cần REST round-trip. Cache miss đi qua `discordUserLimiter` (max 5 in-flight) thay vì `Promise.all` unbounded - server đông không burst `client.users.fetch` parallel, tránh trip Discord global 50 req/s ceiling.

### `/remove-roster`

Xóa 1 roster (account) đã lưu hoặc 1 character cụ thể trong roster.

| Option | Required | Description |
|--------|----------|-------------|
| `roster` | ✅ | Roster (account) cần xóa - **autocomplete** từ roster đã lưu |
| `action` | ✅ | `Remove entire roster` hoặc `Remove a single character` |
| `character` | ❌ (required nếu action = remove char) | Character cần xóa - **autocomplete** theo roster đã chọn |

Ví dụ:
- Xóa cả roster: `/remove-roster roster:Qiylyn action:Remove entire roster`
- Xóa 1 char: `/remove-roster roster:Qiylyn action:Remove a single character character:Zywang`

Reply là ephemeral embed confirm xoá. Muốn refresh roster → `/remove-roster` rồi `/add-roster` lại.

### `/raid-help`

Bilingual (EN + VN) help command. Gửi 1 overview embed liệt kê cả 4 command raid-management, kèm dropdown để xem chi tiết từng command (options, example, notes). Reply là ephemeral - chỉ mình cậu thấy.

Dùng khi: cần tra cú pháp nhanh, onboard member mới, hoặc forget option name.

### `/raid-channel` + text monitor

Admin-only command (`Manage Server` permission) để đăng ký 1 text channel làm **raid-clear monitor channel**. Tất cả actions gộp vào subcommand duy nhất `config` với option `action`:

- `/raid-channel config action:show` - xem channel + health check permissions + deploy-flag warnings
- `/raid-channel config action:set channel:#raid-clears` - đăng ký channel + post/pin welcome
- `/raid-channel config action:clear` - tắt monitor + reset schedule
- `/raid-channel config action:cleanup` - xóa thủ công non-pinned messages (giữ welcome)
- `/raid-channel config action:repin` - refresh welcome (delete stale + post+pin mới)
- `/raid-channel config action:schedule-on` - bật auto-cleanup mỗi 00:00 VN
- `/raid-channel config action:schedule-off` - tắt auto-cleanup daily

Sau khi đăng ký, bất kỳ ai post message vào channel đó dạng `<raid> <difficulty> <character> [gate]` sẽ được bot parse và update raid cho char của **chính người post**. Thành công → bot DM user embed xác nhận + xóa message gốc. Lỗi phục hồi được (char không có, iLvl thiếu, v.v.) → bot ping user persistent hint, tự dọn khi user post lại hoặc sau 5 phút.

**Flow chi tiết:**
- **Set subcommand**: bot kiểm tra permission trong channel đích, nếu OK thì save config + post welcome embed công khai + pin luôn. Thiếu quyền → reply lỗi, config không đổi.
- **Show subcommand**: hiển thị channel đang monitor + health check bot's permissions real-time (fallback `channels.fetch` nếu cache cold).
- **Clear subcommand**: tắt monitor ngay, luôn write-through Mongo bất kể cache state.

**Format:**
- `Serca Nightmare Clauseduk` → mark Serca Nightmare của Clauseduk là DONE (tất cả gate)
- `Kazeros Hard Soulrano G1` → mark G1 của Kazeros Hard (chưa clear tới G2)
- `Serca Nor Soulrano G2` → **cumulative**: mark cả G1 lẫn G2 của Serca Normal (Lost Ark sequential: đi tới G2 ⇒ G1 đã qua)
- `Act4 Hard Priscilladuk, Nailaduk` → **multi-char**: mark Act 4 Hard done cho cả Priscilladuk và Nailaduk trong 1 post. Bot xử lý từng char, DM 1 embed aggregated (done/already-done/not-found/iLvl-thiếu grouped). Nếu có char gõ sai, Artist vẫn update các char hợp lệ khác và ping user trong channel với tên bị sai.

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
| Lỗi phục hồi được (char not found, iLvl thấp, combo sai, multi-raid/diff/gate) | Ping user persistent hint - auto-dọn khi user post lại hoặc sau 5 phút TTL |
| Raid đã DONE từ trước (hoặc gate đã DONE khi post với gate) | DM user notice "Raid đã DONE rồi" + xóa message gốc. Không re-stamp timestamp, không ghi DB. Muốn reset phải dùng `/raid-set status:reset`. |
| Internal error (DB/Discord fail) | Reply transient tự xóa 10s |
| Success | DM user embed xác nhận + xóa message gốc + dọn hint cũ của user đó (nếu có) |

**DM confirmation**: Discord chỉ hỗ trợ ephemeral (chỉ tác giả thấy) cho interactions - không có trên `MessageCreate`. Workaround là DM. Nếu user tắt "Allow direct messages from server members" → DM fail, bot **fallback post 1 tin nhắn công khai ngắn** mention user + raid + char, tự xóa sau 15 giây, để user vẫn biết update đã thành công thay vì thấy message biến mất không phản hồi. Log warn chỉ ở server, user được thông báo cách bật lại DM để nhận confirm private lần sau.

**Prerequisites deploy:**
1. Bật `MESSAGE CONTENT INTENT` trong Discord Developer Portal → Bot → Privileged Gateway Intents. Nếu không bật, bot **sẽ không start được** (Discord reject login với "Used disallowed intents") - dùng env `TEXT_MONITOR_ENABLED=false` để deploy slash-command-only mà không cần privileged intent.
2. Invite bot với scope `bot applications.commands` + permissions trong channel đã config: `View Channel`, `Send Messages`, `Manage Messages`, `Read Message History`, `Embed Links`. `/raid-channel config action:set` giờ tự check và từ chối nếu thiếu bất kỳ quyền nào. (`Read Message History` cần cho `clearPendingHint` fetch/delete tin cũ; `Embed Links` cần cho welcome + DM confirm embeds - thiếu là Discord strip embed).
3. Intents trong `src/bot.js`: `Guilds` luôn có; `GuildMessages` + `MessageContent` chỉ add khi `TEXT_MONITOR_ENABLED !== "false"`.

**Cache behavior:** monitor channel ID được cache in-memory per-guild, load on boot từ `guildconfigs` Mongo collection. `/raid-channel config action:set|clear` update cache in-place - không có Mongo round-trip cho mỗi message đi qua channel. Single-process bot nên không cần invalidation cross-instance.

Config lưu trong collection `guildconfigs` của MongoDB, per-guild.

### `/raid-auto-manage` (Phase 3 - passive 24h scheduler + Phase 2 piggyback + Phase 1 manual)

Kéo clear logs từ `lostark.bible/api/character/logs` và reconcile tự động vào `assignedRaids`. Có 3 trigger paths cho user opted-in:

- **Phase 1 - manual**: `/raid-auto-manage action:sync` bất cứ lúc nào (5-min cooldown per user)
- **Phase 2 - `/raid-status` piggyback**: gõ `/raid-status` tự pull bible song song với roster refresh (gate bởi cùng cooldown + in-flight slot)
- **Phase 3 - 24h passive scheduler**: tick mỗi 30 phút, batch 3 user/tick (sort theo `lastAutoManageAttemptAt` ascending - fair rotation, stuck user không monopolize batch), chỉ pick user có `lastAutoManageSyncAt` cũ hơn 24h (`< now - 24h`) hoặc null. Mục đích: data fresh cho `/raid-check` ngay cả khi user inactive cả tuần. Killswitch: env `AUTO_MANAGE_DAILY_DISABLED=true`.

Subcommands (option `action`, **dynamic autocomplete** - dropdown chỉ show action khả dụng theo state hiện tại, ví dụ đang ON thì ẩn `on`):
- `on` - **probe-before-enable flow**: Artist chạy 1 lần sync in-memory (không save) để phân loại char, nếu có char private → hiện warn embed với nút `Vẫn bật` / `Huỷ` (timeout 60s = default Huỷ). Confirm thì re-run sync trên fresh doc + flip `User.autoManageEnabled = true` + save. Cancel/timeout thì flag giữ OFF, không save gì - nhưng **`lastAutoManageAttemptAt` vẫn được stamp** (probe đã tốn bible quota, cooldown phải kick in để chặn spam-cancel bypass). Không có char private → commit trực tiếp + render sync report.
- `off` - tắt flag (không đụng raid data đã sync)
- `sync` - pull logs NGAY cho tất cả char trong roster, reconcile raid progress của tuần này
- `status` - hiển thị opt-in flag + **Last success** (timestamp lần sync có ≥1 char thành công) + **Last attempt** (timestamp lần chạy gần nhất; khi `= last success` thì lần gần nhất đã thành công, khi hiện `- fail` thì các attempt sau đó đều fail)

**Flow sync:**
1. Với mỗi char chưa có bible meta cache (`bibleSerial/bibleCid/bibleRid`): scrape HTML page `lostark.bible/character/NA/<name>/roster`, extract SSR data qua regex.
2. `POST https://lostark.bible/api/character/logs` được gọi lặp qua `page: 1, 2, …` (mỗi page 25 entries) cho tới khi gặp entry `timestamp < weekResetStart` (deeper pages chỉ toàn log cũ hơn), hoặc page partial (<25), hoặc chạm cap `maxPages=10` (=250 entries safety).
3. Sort logs theo `timestamp` ASC trước reconcile - bible trả newest-first nhưng mode-switch wipe cần oldest→newest để latest mode luôn thắng (tránh log Serca Hard cũ ghi đè log Serca NM mới trong tuần).
4. Filter entries có `timestamp >= 5h chiều thứ 4 giờ Việt Nam` (17:00 VN = 10:00 UTC) gần nhất - weekly reset boundary. Chỉ apply clears thuộc tuần raid hiện tại, cũ hơn skip.
5. Map `log.boss` → `{raidKey, gate}` qua `BOSS_TO_RAID_GATE`; `log.difficulty` → modeKey.
6. Reconcile: latest-timestamp-per-gate wins. Mode-switch (Serca Hard → NM) wipe old progress theo bible-wins semantics.
7. Stamp `lastAutoManageAttemptAt` luôn; `lastAutoManageSyncAt` chỉ stamp khi có ≥1 char fetch+reconcile thành công (không phải tất cả đều throw) - `action:status` hiển thị cả hai nên admin thấy rõ khi sync đang fail liên tục.

**Boss mapping table:**
- Armoche G1 = `Brelshaza, Ember in the Ashes` · G2 = `Armoche, Sentinel of the Abyss`
- Kazeros G1 = `Abyss Lord Kazeros` · G2 = `Archdemon Kazeros` (Normal) hoặc `Death Incarnate Kazeros` (Hard+)
- Serca G1 = `Witch of Agony, Serca` · G2 = `Corvus Tul Rak`

**Đặc biệt:**
- **Bus clears** (`isBus: true`) vẫn count làm clear (theo git owner decision).
- Bible meta cache trên `character` subdoc - sync lần 2+ chỉ tốn 1 API call per char, không phải HTML scrape + API.
- Share `bibleLimiter` (max 2 concurrent) với `/raid-status` refresh để không overwhelm bible. **Cả meta scrape (HTML `/roster` page) lẫn logs API đều đi qua cùng limiter** - cold-cache sync không bypass được cap 2-in-flight khi roster mới cần meta+logs cho N char. Mỗi HTTP call gắn `AbortSignal.timeout(15s)` - bible treo connection sẽ auto-abort, không giữ limiter slot + `inFlightAutoManageSyncs` guard vô hạn.
- **Gather/apply split**: bible HTTP chạy trong **gather phase OUTSIDE `saveWithRetry`**, rồi apply phase trong retry loop chỉ là pure in-memory mutation. VersionError retry KHÔNG re-fire bible call - tiết kiệm N×M HTTP khi concurrent write (e.g. `/raid-set` đồng thời) gây race. Probe (action:on) + commit share cùng `probeCollected` array → chi phí giảm từ 2× bible run xuống 1×.
- **Phase 2 auto-sync**: `handleStatusCommand` piggybacks auto-manage sync vào lazy-refresh flow. Khi `autoManageEnabled = true` và `acquireAutoManageSyncSlot` allow (cooldown hết + không in-flight), `/raid-status` gather bible logs **song song** với roster refresh (Promise.all, share `bibleLimiter`) và apply vào cùng fresh doc trong 1 save - atomic. **Race-safe**: re-check `autoManageEnabled` trên fresh doc trong saveWithRetry (user bấm `action:off` giữa gather và save → skip apply nhưng vẫn stamp attempt). Save fail (mongo blip) → catch stamp attempt qua `stampAutoManageAttempt` để cooldown vẫn protect bible. Gather fail (Cloudflare/timeout) được swallow + log + render cached → `/raid-status` không bao giờ bị vỡ vì auto-sync.
- **Phase 3 - passive 24h scheduler**: `startAutoManageDailyScheduler()` tick mỗi 30 phút (consistent với weekly-reset + raid-channel cleanup schedulers). Mongo query filter ở DB level: `autoManageEnabled: true + accounts.0 exists + lastAutoManageSyncAt < (now - 24h)`, sort theo **`lastAutoManageAttemptAt` ascending** (NOT `lastAutoManageSyncAt` - stuck users would monopolize forever vì syncAt không advance khi fail. attemptAt advance every attempt nên rotation fair), **batch cap 3 user/tick**. Reuse cùng `acquireAutoManageSyncSlot` nên không double-fire với Phase 2 piggyback hoặc manual `action:sync`. Active user (gõ `/raid-status` thường xuyên) tự bypass tick này vì stamp gần đây. **Tick overlap guard**: `dailyTickInFlight` boolean - tick chậm > 30 min không cause overlap với tick mới (worst case: 3 users × 5 chars × 10 paginated logs × 15s timeout). **Summary log split 4 bucket**: `synced` / `attempted-only` / `skipped` / `failed` - `attempted-only` track case bible hit nhưng không có char nào success (Cloudflare 403 toàn bộ), tách khỏi `synced` để metric không lie. Bible HTTP load worst-case: ~90 HTTP/tick (3 users × ~30 HTTP each), spread qua 48 ticks/day = ~144 user-syncs/day capacity (cover 100+ users). **Killswitch**: env `AUTO_MANAGE_DAILY_DISABLED=true` skip mọi tick - flip nhanh nếu bible block, không cần redeploy.
- Nếu bible 403 do Cloudflare block (body KHÔNG chứa `Logs not enabled`) → char hiện ở bucket Fail với raw error message, KHÔNG bị misclassify thành private. Phase 2 sẽ port ScraperAPI fallback từ LoaLogs để auto-retry những case này.
- **Private logs (body `"Logs not enabled"`)**: bible trả `403 {"error":"Logs not enabled"}` cho char có `Show on Profile` UNCHECKED trong [lostark.bible/me/logs](https://lostark.bible/me/logs). Phân loại private **chỉ dựa vào body message**, không dựa vào raw status 403 (Cloudflare/rate-limit cũng trả 403 nhưng bật Public Log không cứu được). Session cookie của owner thì thấy được, nhưng cookie là HTTP-only + upload token (Generate Token ở `/me/upload`) đã test là write-only - bot không có cách auth thay user. User muốn sync char hidden phải tự bật `Show on Profile` trên bible, hoặc chấp nhận char đó skip (report hiện bucket "Fail").
- **Per-user throttle (5-min cooldown + in-flight guard)**: dựa trên `User.lastAutoManageAttemptAt` + in-memory `Set` theo `discordId`. `action:sync` spam trong 5 phút → ephemeral reject với remaining time. In-flight song song cùng user → reject ngay. `action:on` có logic mềm hơn: in-flight thì reject hard, nhưng cooldown thì vẫn flip flag (UX: "bật" không bao giờ fail), chỉ skip cả probe lẫn sync và báo user chờ X phút. Cần guard vì mỗi sync chạy scrape+paginate cho toàn roster (N-char × HTTP calls) - `bibleLimiter` chỉ cap concurrency, không chặn total queue. **Probe cancel/timeout/error cũng stamp `lastAutoManageAttemptAt`** - không thì user spam `action:on` + bấm Huỷ liên tục sẽ bypass được cooldown (probe HTTP vẫn tốn quota).
- **Redundant-state + invalid-action reject**: typed `action:on` khi đang ON, hoặc `action:off` khi đang OFF → ephemeral reject (autocomplete đã hide rồi, nhưng paste-value bypass được). Action lạ (paste string không thuộc `on/off/sync/status`) → ephemeral reject ngay đầu handler để interaction không fall-through rồi Discord timeout. Save a pointless DB write + không tạo nhiễu "đã bật rồi" trong log.

## Raid Catalog

| Raid Key | Hiển thị | Normal | Hard | Nightmare | Gates |
|----------|----------|--------|------|-----------|-------|
| `armoche` | Act 4 | 1700 | 1720 | - | G1, G2 |
| `kazeros` | Kazeros | 1710 | 1730 | - | G1, G2 |
| `serca` | Serca | 1710 | 1730 | 1740 | G1, G2 |

Gate count được lấy từ `RAID_REQUIREMENTS[raidKey].gates` trong `src/models/Raid.js`. Helper `getGatesForRaid(raidKey)` dùng ở mọi chỗ cần list gates - không còn hardcode `["G1", "G2"]` ở đâu.

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

✅ Catch-up: nếu bot offline qua Wed 10:00 UTC, tick tiếp theo (bất kỳ ngày nào) sẽ so stored `weeklyResetKey` với `getTargetResetKey()` hiện tại - nếu stale, chạy reset ngay.

✅ Race-safe: mỗi user được reset trong `saveWithRetry()` wrapper, nên nếu `/raid-set` commit giữa lúc reset đang process, reset sẽ re-fetch doc fresh và retry thay vì silently overwrite.

### Data Ingestion (`/add-roster`)

1. Fetch `https://lostark.bible/character/NA/<name>/roster` (User-Agent = Windows Chrome, timeout 15s).
2. Dùng regex `/name:"(...)",class:"(...)"/g` trên HTML raw để extract character name + class ID (trích từ inline JSON embedded trong script).
3. Dùng `jsdom` parse DOM, lấy item level + combat score từ `<span>` bên trong `.text-lg.font-semibold > a[href^="/character/NA/"]`.
4. Sort theo combat score desc → item level desc → lấy top `total`.

## Environment Variables

| Variable | Required | Mặc định | Mô tả |
|----------|----------|----------|-------|
| `DISCORD_TOKEN` | ✅ | - | Bot token từ Discord Developer Portal |
| `CLIENT_ID` | ✅ (deploy) | - | Application ID - dùng khi chạy `npm run deploy:commands` |
| `GUILD_ID` | ✅ (deploy) | - | Server ID để register slash commands (guild-scoped) |
| `MONGO_URI` | ✅ | - | MongoDB connection string |
| `MONGO_DB_NAME` | ❌ | `manage` | Tên database |
| `DNS_SERVERS` | ❌ | `8.8.8.8,1.1.1.1` | DNS fallback khi Atlas bị `ECONNREFUSED` (SRV lookup fail) |
| `RAID_MANAGER_ID` | ❌ (recommended) | empty | Discord user IDs cho phép gọi `/raid-check`, comma-separated. Empty/missing → `/raid-check` reject mọi invocation + warn ở boot |
| `AUTO_MANAGE_DAILY_DISABLED` | ❌ | `false` | Killswitch cho Phase 3 daily auto-sync scheduler. Set `true` để skip mọi tick (back off khi bible block) |
| `TEXT_MONITOR_ENABLED` | ❌ | `true` | Set `false` để chạy slash-command-only, skip privileged `MessageContent` intent |

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

Mỗi Railway redeploy bot sẽ **tự đăng ký slash command schema** khi boot (pattern giống `LostArk_LoaLogs` - `bot.js` gọi `rest.put(applicationGuildCommands, ...)` trong `client.once('ready', ...)` handler). Điều đó có nghĩa là:

- Thêm/sửa command → push lên main → Railway redeploy → schema tự sync.
- Registration fail (Discord API down, token sai...) chỉ log warning; bot vẫn boot bình thường với schema cũ → fail-soft.
- `deploy-commands.js` vẫn giữ lại cho trường hợp muốn force register từ dev machine (ví dụ: test schema mới mà không cần Railway).

## Known Limitations

- `/raid-check` chỉ nhận Discord user IDs liệt kê trong env `RAID_MANAGER_ID` (comma-separated). User ID không có trong list sẽ bị reject ephemeral. Empty/missing env → bot warn ở boot và `/raid-check` reject mọi invocation. Operator add/remove leader = update env + redeploy.
- `/add-roster` phụ thuộc HTML/inline-JS structure của `lostark.bible`. Nếu site thay layout, regex + DOM selectors cần update.
- Weekly reset dùng UTC cho cả trigger và week-key - không còn phụ thuộc container timezone.
- Slash commands register theo **guild-scoped**, không phải global. Muốn enable ở nhiều server → cần chạy `deploy-commands.js` riêng cho mỗi `GUILD_ID`.

## Legacy Files (Safe to Ignore)

Repo hiện có 2 file leftover từ template copy-paste, **không được import bởi bot**:

- `config.js` - ESM config cho LoaLogs bot (officer approvers, Gemini, ScraperAPI). Env vars mismatch với `db.js` (`MONGODB_URI` vs `MONGO_URI`).
- `src/models/GuildConfig.js` - Schema cho `/lasetup` / `/laremote` / blacklist - không có command nào trong bot này dùng.

Có thể xoá cả 2 file nếu muốn repo sạch hơn.
