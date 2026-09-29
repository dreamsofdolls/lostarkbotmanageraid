// Local Reader locale dictionaries. Mirror of the bot-side
// bot/locales/{vi,jp,en}.js but ESM-shaped for browser consumption.
// Same key namespacing convention - nested objects, dotted access via t().
//
// The active language is passed in via the URL token (encoded by
// mintToken on the bot side based on the user's /raid-language pref);
// web/js/core/i18n.js reads it at boot. Default falls back to "vi" matching
// User.language schema default.
//
// Strings render as text except `done.title`, which carries <em> markup and
// is only ever interpolated with a number. `\n` in well titles is a line
// break (the prompt title uses white-space: pre-line).

"use strict";

const VI = {
  meta: {
    pageTitle: "Artist · Local Reader",
  },
  header: {
    h1: "Local Reader",
  },
  identity: {
    noToken: "Link thiếu mã đăng nhập",
    noTokenHint: "Mở /raid-status → 🗃️ Local Sync trên Discord để lấy link mới.",
    malformed: "Link không hợp lệ",
    malformedHint: "Mở /raid-status → 🗃️ Local Sync trên Discord để lấy link mới.",
    expired: "Link đã hết hạn",
    expiredHint: "Lấy link mới ở /raid-status → 🗃️ Local Sync. File cậu đã chọn vẫn được nhớ.",
    revoked: "Link này đã được thay",
    revokedHint: "Dùng link mới nhất ở /raid-status → 🗃️ Local Sync nhé.",
    disabled: "Local Sync đang tắt",
    disabledHint: "Bật lại bằng /raid-auto-manage action:local-on rồi lấy link mới.",
    linkValid: "link còn {n} phút",
    linkValidSec: "link còn {n} giây",
    linkedAnonymous: "Đã liên kết",
  },
  well: {
    drop: "Thả encounters.db\nvào đây",
    dropHint: "hoặc bấm để chọn file",
    dragging: "Thả ra là được",
    restore: "Mở lại\nencounters.db",
    restoreHint: "bấm để cho phép đọc lại file lần trước",
    reading: "Đang đọc\nencounters.db",
    readingHint: "chỉ đọc trên máy cậu",
    unit: "clear mới",
    nothing: "Chưa có\nclear mới",
    nothingHint: "clear tiếp theo sẽ tự hiện ở đây",
  },
  problem: {
    openFailed: "Không mở được file",
    openFailedHint: "Chọn lại encounters.db của LOA Logs. Chi tiết lỗi nằm trong Console (F12).",
    notLoaLogs: "Không phải file LOA Logs",
    notLoaLogsHint: "Chọn encounters.db trong %localappdata%\\LOA Logs\\ nhé.",
    schema: "LOA Logs đã đổi cấu trúc file",
    schemaHint: "Artist chưa đọc được bản LOA Logs này. Báo lại trên Discord giúp tớ nhé.",
    soloDifficulty: "Không nhận ra clear Solo",
    soloDifficultyHint: "Bản LOA Logs này thiếu cột độ khó, nên Artist không đoán clear nào là Solo.",
  },
  file: {
    path: "%localappdata%\\LOA Logs\\encounters.db",
    change: "Đổi file",
    updated: "cập nhật {time}",
    invalidExt: "Chỉ nhận file .db (encounters.db của LOA Logs).",
    fsaUnavailable: "Trình duyệt này không chọn file kiểu này được. Dùng Chrome, Edge hoặc Opera GX, hoặc kéo thả file vào vòng tròn.",
    pickFailed: "Chọn file lỗi: {error}",
    restoreDenied: "Trình duyệt chưa cho đọc lại file. Bấm vào vòng tròn để thử lại, hoặc kéo thả file vào đây.",
    liveStatic: "Trình duyệt này không theo dõi được file. Có clear mới thì chọn lại file nhé.",
    liveRetrying: "Theo dõi file bị gián đoạn, Artist đang tự thử lại.",
    liveWalWarning: "LOA Logs đang giữ dữ liệu trong encounters.db-wal. Tắt LOA Logs một lát rồi Artist sẽ đọc lại.",
  },
  sync: {
    btn: "Đồng bộ",
    syncing: "Đang ghi...",
    retry: "Thử lại",
    fileBusy: "LOA Logs vẫn đang ghi dữ liệu. Artist sẽ tự đọc lại ngay khi file ổn định.",
    walUnsafe: "Chưa đồng bộ được khi LOA Logs còn giữ dữ liệu trong encounters.db-wal.",
    rosterRetrying: "Chưa đọc được roster, Artist đang thử lại.",
    partial: "Ghi được {done}/{total} clear. Phần đã ghi được giữ nguyên, thử lại chỉ ghi nốt phần còn thiếu.",
    retryable: "Lần này chưa ghi được. Bấm Thử lại, phần nào đã ghi sẽ không bị ghi lặp.",
    failed: "Chưa ghi được (HTTP {status}). Thử lại nhé.",
    busy: "Tài khoản này đang được đồng bộ ở nơi khác. Đợi chút rồi thử lại nhé.",
    stale: "Bản đọc này đã cũ, Artist đang đọc lại file.",
    networkError: "Mất kết nối tới Artist. Thử lại nhé.",
    conflict: "{char} · {raid}: ghi {to} sẽ xoá tiến độ {from} tuần này.",
    conflictMore: "Còn {n} raid khác cũng đổi độ khó.",
  },
  done: {
    stamp: "ĐÃ GHI",
    title: "Đã đồng bộ <em>{n} clear</em>",
    rejected: "{n} clear không ghi được, xem lý do trong /raid-status.",
    hint: "Chi tiết từng nhân vật xem trong /raid-status trên Discord",
  },
  solo: {
    meta: {
      pageTitle: "Artist · Solo Local Reader",
    },
    header: {
      h1: "Solo Local Reader",
    },
    identity: {
      noTokenHint: "Mở /raid-status → 🗃️ Local Sync trên Discord để lấy link Solo mới.",
      malformedHint: "Mở /raid-status → 🗃️ Local Sync trên Discord để lấy link Solo mới.",
      disabledHint: "Bật lại Bible Auto-sync rồi lấy link Solo mới ở /raid-status → 🗃️ Local Sync.",
    },
    well: {
      unit: "clear Solo mới",
      nothingHint: "Trang này chỉ đọc clear Solo. Raid đi party đã có Auto-sync lo.",
    },
    done: {
      title: "Đã đồng bộ <em>{n} clear Solo</em>",
    },
  },
  raidLabels: {
    armoche: "Act 4",
    kazeros: "Kazeros",
    serca: "Serca",
    horizon: "Horizon",
  },
  modeLabels: {
    normal: "Normal",
    solo: "Solo",
    hard: "Hard",
    nightmare: "Nightmare",
  },
  raidModeLabels: {
    horizon: {
      normal: "Level 1",
      hard: "Level 2",
      nightmare: "Level 3",
    },
  },
};

const JP = {
  meta: {
    pageTitle: "Artist · ローカルリーダー",
  },
  header: {
    h1: "ローカルリーダー",
  },
  identity: {
    noToken: "リンクにトークンがありませんわ",
    noTokenHint: "Discord の /raid-status → 🗃️ ローカル同期 から新しいリンクを開いてくださいませ。",
    malformed: "リンクが無効ですわ",
    malformedHint: "Discord の /raid-status → 🗃️ ローカル同期 から新しいリンクを開いてくださいませ。",
    expired: "リンクの有効期限が切れましたわ",
    expiredHint: "/raid-status → 🗃️ ローカル同期 で新しいリンクを取得してくださいませ。選んだファイルは覚えていますの。",
    revoked: "このリンクは新しいリンクに置き換えられましたわ",
    revokedHint: "/raid-status → 🗃️ ローカル同期 の最新リンクを使ってくださいませ。",
    disabled: "ローカル同期がオフになっていますわ",
    disabledHint: "/raid-auto-manage action:local-on で有効にしてから、新しいリンクを開いてくださいませ。",
    linkValid: "リンク残り {n} 分",
    linkValidSec: "リンク残り {n} 秒",
    linkedAnonymous: "リンク済み",
  },
  well: {
    drop: "encounters.db を\nここへドロップ",
    dropHint: "またはクリックしてファイルを選択",
    dragging: "そのまま離してくださいませ",
    restore: "encounters.db を\n開き直す",
    restoreHint: "クリックして前回のファイルの読み取りを許可",
    reading: "encounters.db を\n読み込み中",
    readingHint: "この端末の中だけで読みますの",
    unit: "新規クリア",
    nothing: "新しいクリアは\nまだありません",
    nothingHint: "次のクリアはここに自動で表示されますわ",
  },
  problem: {
    openFailed: "ファイルを開けませんでした",
    openFailedHint: "LOA Logs の encounters.db を選び直してくださいませ。詳細は Console (F12) にありますわ。",
    notLoaLogs: "LOA Logs のファイルではありませんわ",
    notLoaLogsHint: "%localappdata%\\LOA Logs\\ の encounters.db を選んでくださいませ。",
    schema: "LOA Logs のファイル構造が変わりましたわ",
    schemaHint: "このバージョンの LOA Logs はまだ読めませんの。Discord で教えてくださいませ。",
    soloDifficulty: "Solo クリアを判別できませんわ",
    soloDifficultyHint: "この LOA Logs には難易度の列がないため、Solo を推測しませんの。",
  },
  file: {
    path: "%localappdata%\\LOA Logs\\encounters.db",
    change: "ファイル変更",
    updated: "{time} 更新",
    invalidExt: ".db ファイル（LOA Logs の encounters.db）だけ受け付けますわ。",
    fsaUnavailable: "このブラウザではこの方法でファイルを選べませんの。Chrome / Edge / Opera GX を使うか、円の中へファイルをドロップしてくださいませ。",
    pickFailed: "ファイル選択に失敗しました: {error}",
    restoreDenied: "ブラウザがファイルの再読み取りを許可しませんでしたわ。円をもう一度クリックするか、ファイルをここへドロップしてくださいませ。",
    liveStatic: "このブラウザではファイルを監視できませんの。新しいクリアがあればファイルを選び直してくださいませ。",
    liveRetrying: "ファイル監視が途切れましたわ。自動で再試行しています。",
    liveWalWarning: "LOA Logs が encounters.db-wal にデータを保持していますわ。LOA Logs を少し閉じると読み直しますの。",
  },
  sync: {
    btn: "同期",
    syncing: "書き込み中...",
    retry: "もう一度",
    fileBusy: "LOA Logs がまだ書き込み中ですわ。ファイルが落ち着いたらすぐ読み直しますの。",
    walUnsafe: "LOA Logs が encounters.db-wal にデータを持っている間は同期できませんわ。",
    rosterRetrying: "ロスターを読めませんでしたわ。再試行しています。",
    partial: "{done}/{total} 件のクリアを書き込みましたわ。書き込み済みの分はそのまま、もう一度で残りだけ書き込みますの。",
    retryable: "今回は書き込めませんでしたわ。「もう一度」を押しても、書き込み済みの分が重複することはありませんの。",
    failed: "書き込めませんでした (HTTP {status})。もう一度お試しくださいませ。",
    busy: "このアカウントは別の場所で同期中ですわ。少し待ってからもう一度どうぞ。",
    stale: "この読み取り結果は古くなりましたわ。ファイルを読み直しています。",
    networkError: "Artist に接続できませんでしたわ。もう一度お試しくださいませ。",
    conflict: "{char} · {raid}：{to} を書き込むと、今週の {from} の進捗が消えますわ。",
    conflictMore: "ほかに {n} 件のレイドも難易度が変わりますの。",
  },
  done: {
    stamp: "記録済",
    title: "<em>{n} 件</em>を同期しましたわ",
    rejected: "{n} 件は書き込めませんでしたわ。理由は /raid-status で確認できますの。",
    hint: "キャラごとの詳細は Discord の /raid-status で見られますわ",
  },
  solo: {
    meta: {
      pageTitle: "Artist · Solo Local Reader",
    },
    header: {
      h1: "Solo Local Reader",
    },
    identity: {
      noTokenHint: "Discord の /raid-status → 🗃️ ローカル同期 から新しい Solo リンクを開いてくださいませ。",
      malformedHint: "Discord の /raid-status → 🗃️ ローカル同期 から新しい Solo リンクを開いてくださいませ。",
      disabledHint: "Bible 自動同期を有効に戻してから、/raid-status → 🗃️ ローカル同期 で新しい Solo リンクを開いてくださいませ。",
    },
    well: {
      unit: "新規 Solo クリア",
      nothingHint: "このページが読むのは Solo クリアだけですの。パーティ攻略は Auto-sync の担当ですわ。",
    },
    done: {
      title: "<em>Solo {n} 件</em>を同期しましたわ",
    },
  },
  raidLabels: {
    armoche: "アクト4",
    kazeros: "カゼロス",
    serca: "セルカ",
    horizon: "Horizon",
  },
  modeLabels: {
    normal: "ノーマル",
    solo: "ソロ",
    hard: "ハード",
    nightmare: "ナイトメア",
  },
  raidModeLabels: {
    horizon: {
      normal: "Level 1",
      hard: "Level 2",
      nightmare: "Level 3",
    },
  },
};

const EN = {
  meta: {
    pageTitle: "Artist · Local Reader",
  },
  header: {
    h1: "Local Reader",
  },
  identity: {
    noToken: "This link has no token",
    noTokenHint: "Open /raid-status → 🗃️ Local Sync in Discord for a fresh link.",
    malformed: "This link is not valid",
    malformedHint: "Open /raid-status → 🗃️ Local Sync in Discord for a fresh link.",
    expired: "This link has expired",
    expiredHint: "Get a fresh one from /raid-status → 🗃️ Local Sync. Your file stays remembered.",
    revoked: "This link was replaced",
    revokedHint: "Use the newest link from /raid-status → 🗃️ Local Sync.",
    disabled: "Local Sync is off",
    disabledHint: "Turn it on with /raid-auto-manage action:local-on, then open a fresh link.",
    linkValid: "link valid for {n} min",
    linkValidSec: "link valid for {n} sec",
    linkedAnonymous: "Linked",
  },
  well: {
    drop: "Drop encounters.db\nhere",
    dropHint: "or click to choose the file",
    dragging: "Let go to drop it",
    restore: "Reopen\nencounters.db",
    restoreHint: "click to allow reading last time's file",
    reading: "Reading\nencounters.db",
    readingHint: "read only on this device",
    unit: "new clears",
    nothing: "No new\nclears yet",
    nothingHint: "the next clear shows up here by itself",
  },
  problem: {
    openFailed: "Couldn't open the file",
    openFailedHint: "Pick the LOA Logs encounters.db again. Details are in the Console (F12).",
    notLoaLogs: "Not a LOA Logs file",
    notLoaLogsHint: "Pick encounters.db from %localappdata%\\LOA Logs\\.",
    schema: "LOA Logs changed its file layout",
    schemaHint: "Artist can't read this LOA Logs version yet. Please report it in Discord.",
    soloDifficulty: "Can't tell Solo clears apart",
    soloDifficultyHint: "This LOA Logs version has no difficulty column, so Artist won't guess which clears are Solo.",
  },
  file: {
    path: "%localappdata%\\LOA Logs\\encounters.db",
    change: "Change file",
    updated: "updated {time}",
    invalidExt: "Only .db files (the LOA Logs encounters.db).",
    fsaUnavailable: "This browser can't pick files this way. Use Chrome, Edge or Opera GX, or drop the file into the circle.",
    pickFailed: "Picking the file failed: {error}",
    restoreDenied: "The browser didn't allow reading the file again. Click the circle to try again, or drop the file here.",
    liveStatic: "This browser can't watch the file. Pick it again after new clears.",
    liveRetrying: "File watching was interrupted; Artist is retrying.",
    liveWalWarning: "LOA Logs is holding data in encounters.db-wal. Close LOA Logs for a moment and Artist will read it again.",
  },
  sync: {
    btn: "Sync",
    syncing: "Writing...",
    retry: "Retry",
    fileBusy: "LOA Logs is still writing. Artist will read the file again as soon as it settles.",
    walUnsafe: "Can't sync while LOA Logs holds data in encounters.db-wal.",
    rosterRetrying: "Couldn't read your roster; retrying.",
    partial: "Wrote {done}/{total} clears. What was written stays; Retry writes only the rest.",
    retryable: "Nothing was written this time. Retry won't write anything twice.",
    failed: "Nothing was written (HTTP {status}). Please retry.",
    busy: "This account is syncing somewhere else. Wait a moment, then retry.",
    stale: "This read is out of date; Artist is reading the file again.",
    networkError: "Couldn't reach Artist. Please retry.",
    conflict: "{char} · {raid}: writing {to} clears this week's {from} progress.",
    conflictMore: "{n} more raid(s) also change difficulty.",
  },
  done: {
    stamp: "SYNCED",
    title: "Synced <em>{n} clears</em>",
    rejected: "{n} clear(s) couldn't be written; see why in /raid-status.",
    hint: "Per-character details are in /raid-status on Discord",
  },
  solo: {
    meta: {
      pageTitle: "Artist · Solo Local Reader",
    },
    header: {
      h1: "Solo Local Reader",
    },
    identity: {
      noTokenHint: "Open /raid-status → 🗃️ Local Sync in Discord for a fresh Solo link.",
      malformedHint: "Open /raid-status → 🗃️ Local Sync in Discord for a fresh Solo link.",
      disabledHint: "Turn Bible auto-sync back on, then open a fresh Solo link from /raid-status → 🗃️ Local Sync.",
    },
    well: {
      unit: "new Solo clears",
      nothingHint: "This page reads Solo clears only. Party clears are Auto-sync's job.",
    },
    done: {
      title: "Synced <em>{n} Solo clears</em>",
    },
  },
  raidLabels: {
    armoche: "Act 4",
    kazeros: "Kazeros",
    serca: "Serca",
    horizon: "Horizon",
  },
  modeLabels: {
    normal: "Normal",
    solo: "Solo",
    hard: "Hard",
    nightmare: "Nightmare",
  },
  raidModeLabels: {
    horizon: {
      normal: "Level 1",
      hard: "Level 2",
      nightmare: "Level 3",
    },
  },
};

export const TRANSLATIONS = { vi: VI, jp: JP, en: EN };
export const DEFAULT_LANG = "vi";
export const SUPPORTED_LANGS = ["vi", "jp", "en"];
