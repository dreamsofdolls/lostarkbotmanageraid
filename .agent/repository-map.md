# Repository map

| Khu vực | Trách nhiệm |
| --- | --- |
| `bot.js`, `bot/app/` | Boot, Discord lifecycle/router, Local Reader wiring |
| `bot/commands.js` | Compose factories/services; không phải kho chứa business logic mới |
| `bot/domain/` | Raid catalog và dữ liệu domain chuẩn |
| `bot/handlers/` | Slash/component handlers theo raid, roster, status, check, local-sync |
| `bot/services/access/` | Manager/roster-share authorization |
| `bot/services/auto-manage/` | Bible gather, reconcile, apply và sync orchestration |
| `bot/services/local-sync/` | Signed links, HTTP, preview jobs, scope và apply |
| `bot/services/raid/` | Channel monitor, scheduling, weekly reset, snapshots |
| `bot/services/roster/`, `bot/services/discord/` | Roster I/O, identity cache và Discord services |
| `bot/utils/async/` | In-flight loader và latest-only queue |
| `bot/utils/discord/`, `bot/utils/raid/` | Component helpers, queries, schedule math, tasks |
| `bot/models/`, `bot/locales/` | Mongo schemas và i18n |
| `web/` | Local Reader ES modules, HTML/CSS và SQLite file processing |
| `scripts/` | Deploy-command và icon development tools |
| `test/`, `assets/` | Node test suite và runtime images |

## Contract cần giữ

- `applyRaidSetForDiscordId` là write path dùng chung; slash/UI, channel monitor
  và Local Sync không tự cài một cách ghi raid progress khác.
- Manual/Bible sync giữ thứ tự acquire → gather → apply → stamp → save → outcome
  → release; failure vẫn phải giải phóng lock.
- Autocomplete mới được phép dùng TTL ngắn. Command/write path cần dữ liệu mới;
  in-flight dedup không đồng nghĩa được dùng kết quả đã cache lâu.
- In-flight loader chỉ evict mục đã settled, không làm mất việc gộp request đang
  chạy. Dung lượng được thu về giới hạn khi đợt xử lý kết thúc.
- Local Reader đọc file ở browser, gửi delta preview; apply qua scope/permission
  và Discord confirmation. Solo-only mode không được suy đoán difficulty bị thiếu.
- Giữ `web/package.json` vì nó xác định module boundary riêng cho frontend.
- Weekly reset và schedule giữ UTC/reset-key/idempotency hiện có; không thay bằng
  giờ local của máy dev.
- Giữ source catalog/registry là nguồn chuẩn, không sao chép danh sách raid vào
  handler mới. Chỉ tách module khi có trách nhiệm rõ hoặc reuse thực tế.
