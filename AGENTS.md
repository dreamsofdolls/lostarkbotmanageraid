# RaidManage repository instructions

- Đọc [.agent/README.md](.agent/README.md) và bản đồ module trước khi sửa.
- Đây là checkout độc lập. `bot/` và `scripts/` dùng **CommonJS**; `web/` dùng
  **ES modules** theo `web/package.json`. Không đổi toàn repo sang một module system.
- Giữ `bot.js` tại root và `web/` đúng đường dẫn mà Local Sync HTTP server dùng.
- Xem `git status --short --branch` trước khi sửa; giữ nguyên thay đổi ngoài phạm vi.
- `bot/commands.js` là composition root: tái sử dụng factory/service hiện có thay
  vì thêm business logic vào wiring. Helper async dùng chung ở `bot/utils/async/`.
- `bot/domain/` giữ catalog; `bot/handlers/` giữ UI; `bot/services/` giữ I/O và luồng
  ghi; `bot/utils/raid/` giữ tính toán raid dùng chung. Không tạo thêm `bot/shared/`
  cho cùng loại helper đã có trong utils.
- Công cụ phát triển ở `scripts/`; tài liệu agent ở `.agent/`; scratch/log ở
  `.agent/local/` (Git ignore). Không sửa hay di chuyển `docs/`/`.claude/` ngoài phạm vi.
- Giữ shared write path, permission checks, weekly-reset semantics và Local Reader
  preview/apply boundary; xem [.agent/repository-map.md](.agent/repository-map.md).
- Comments và console logs bằng English; UI strings qua i18n vi/en/jp. Giải thích
  invariant/race bằng comment; exported API mới/sửa có JSDoc hữu ích.
- Theo [.agent/verification.md](.agent/verification.md): test liên quan trước,
  toàn bộ `npm test` trước khi chốt. Đổi vị trí file cùng import, test và README.
- Không in `.env`/credentials. Không dùng `npm start` hay `deploy:commands` làm
  local verification: chúng có thể kết nối và thay đổi Discord/MongoDB thật.
- Commit/push thông thường sau khi hoàn tất và kiểm tra tuân theo phạm vi/thỏa
  thuận hiện có. Force-push, reset, xóa dữ liệu hay mở rộng triển khai cần ủy quyền
  riêng. Báo Git publication riêng với Railway health và Discord smoke test.
