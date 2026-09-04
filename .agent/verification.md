# Verification

Chạy trong root checkout RaidManage với Node.js 20 (cùng major với Dockerfile) và
dependency đã cài:

```powershell
git status --short --branch
npm test
git diff --check
```

| Thay đổi | Test liên quan |
| --- | --- |
| In-flight/autocomplete | `node --test test/in-flight-loader.test.js test/raid-autocomplete-choices.test.js` |
| Manual/Bible sync | `node --test test/auto-manage-runtime-sync.test.js test/raid-status.test.js` |
| Local Sync | `node --test test/local-sync-apply.test.js test/local-sync-http-server.test.js test/local-sync-tokens.test.js` |
| Schedule | `node --test test/raid-schedule-auto-clear.test.js test/raid-announce-schedule.test.js` |
| i18n | `node --test test/i18n.test.js` |

Khi di chuyển module, dùng `rg` để tìm mọi require/import cũ và `node --check` để
kiểm tra syntax. `web/package.json` phải được giữ khi kiểm tra frontend ES modules.
Từ workspace cha có thể chạy `.agent/verify.ps1 -Repo RaidManage -Full` để kiểm tra
syntax toàn bộ JavaScript rồi chạy đúng `npm test`.

Không dùng `npm run deploy:commands` để kiểm tra module loading: script gửi REST
request thay slash schema thật. Không khởi động thêm bot consumer để smoke-test local.

Docker chạy `npm ci --omit=dev` và `node bot.js`; giữ `web/`, `assets/`, `bot/` cùng
production dependencies trong build. `.agent/`, local scratch, test và công cụ
phát triển bị `.dockerignore` loại khỏi image.

Sau publish, so `git rev-parse HEAD` với remote branch thực tế bằng `git ls-remote`.
Remote ref chỉ chứng minh publication. Railway deployment, HTTP health và Discord
interaction là những lớp kiểm tra riêng; nói rõ lớp nào chưa được kiểm tra.
