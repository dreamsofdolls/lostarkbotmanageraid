# RaidManage maintenance guide

RaidManage quản lý roster, raid progress, lịch đăng ký, Bible Auto-manage và Local
Reader. Backend CommonJS khởi động từ `bot.js`; frontend `web/` là ES modules.

- [Repository map](repository-map.md): module ownership và các contract cần giữ.
- [Verification](verification.md): lệnh kiểm tra và giới hạn của bằng chứng.
- [Product README](../README.md) và [repo instructions](../AGENTS.md).

## Quy trình ngắn

1. Kiểm tra branch/dirty state và xác định handler/service đúng domain.
2. Tái hiện lỗi bằng test có dependency injection khi cần sửa hành vi.
3. Giữ composition root gọn, tái sử dụng write path hiện có và cập nhật mọi caller
   nếu đổi vị trí module.
4. Chạy test liên quan, toàn bộ suite, syntax/whitespace và đọc lại diff.
5. Publish trong phạm vi đã được ủy quyền; xác nhận remote ref rồi báo riêng trạng
   thái runtime nếu có kiểm tra trực tiếp.

`.agent/` được version control và bị loại khỏi Docker image. `.agent/local/` dành
cho ghi chú/log không version control. `web/`, assets và production dependencies
vẫn thuộc runtime; không bỏ chúng khi làm gọn build context.
