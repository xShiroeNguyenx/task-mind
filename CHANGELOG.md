# Changelog

## [0.1.0] — 2026-06-10

Bản đầu tiên phát hành chính thức lên **VS Code Marketplace** (và Open VSX). Nội dung tính năng
như 0.0.18; bản này bổ sung hạ tầng phát hành:

- **CI/CD bằng GitHub Actions**: mọi push/PR được build + lint + test + đóng gói thử
  (`ci.yml`); push tag `vX.Y.Z` tự tạo GitHub Release kèm `.vsix` và publish lên VS Code
  Marketplace + Open VSX (`release.yml`, có `--skip-duplicate` nếu version đã tồn tại).
- `package.json` bổ sung metadata Marketplace (`repository`, `keywords`, `homepage`, `bugs`);
  README thêm badge CI + hướng dẫn cài đặt; thêm `PUBLISHING.md` (quy trình phát hành).

## [0.0.18] — 2026-06-10 (chỉ Marketplace)

- **Thêm nút "Xuất TSV" cho báo cáo** (cạnh "Xuất Markdown") để **import/dán vào Google Sheets**.
  Bảng 5 cột `Ngày · Dự án · Task · Sub-task · Trạng thái`: mỗi task một dòng, bật "Sub-task" thì
  mỗi sub-task thêm một dòng (lặp lại cột Task để lọc/pivot được). Tôn trọng đúng bộ lọc đang chọn
  (task/dự án bị bỏ tick không xuất). File có BOM UTF-8 nên mở bằng Excel cũng không vỡ tiếng Việt.
- **Thêm checkbox include cho cả DỰ ÁN trong báo cáo.** Tiêu đề mỗi dự án giờ có checkbox (mặc định
  bật). Bỏ tick → **loại toàn bộ dự án khỏi báo cáo**: dự án mờ + gạch ngang trong webview (checkbox
  task bên trong bị khoá), **KPI/câu tóm tắt/danh sách "Đã xong · Đang làm" cập nhật lại**, và file
  **Markdown xuất ra không còn dự án đó** (kể cả heading).
- Nút "↺ Hiện lại (N)" giờ đếm cả số dự án bị loại; reset/chuyển ngày/mở lại báo cáo cũng xoá lựa
  chọn loại dự án như với task.
- *(Kỹ thuật: `computeEffective`/`reportToMarkdown` nhận thêm `excludedProjectKeys`; có test ở
  `dev-projection-test.js` mục 14.)*

## [0.0.17] — chưa phát hành

- **Format lại phần tóm tắt đầu báo cáo.** Đoạn văn in nghiêng chạy dài (nhồi mọi tên việc) được
  thay bằng **một câu tóm tắt số liệu** + **hai danh sách gạch đầu dòng** "✓ Đã xong (N)" và
  "◷ Đang làm (N)" cho dễ đọc.
- **Thêm bộ lọc chọn việc cho báo cáo.** Mỗi việc trong danh sách chi tiết theo dự án có **checkbox
  include** (mặc định bật). Bỏ tick để **loại việc khỏi báo cáo** (việc bị mờ + gạch ngang nhưng vẫn
  hiện để tick lại). Khi đó **tổng (KPI), phần tóm tắt và file Markdown xuất ra đều cập nhật theo**.
- **Tùy chọn ẩn/hiện sub-task.** Checkbox "Sub-task" trên thanh tiêu đề báo cáo bật/tắt hiển thị
  sub-task ở cả webview lẫn khi xuất Markdown.
- **Nút "↺ Hiện lại (N)"** để khôi phục nhanh các việc đã loại. Danh sách việc bị loại là **bộ lọc
  xem tạm thời** (không ghi vào lịch sử), tự reset khi mở báo cáo mới hoặc chuyển ngày; riêng tùy
  chọn "Sub-task" được giữ lại.
- *(Kỹ thuật: tổng sau lọc tính qua `computeEffective` — một nguồn dùng chung cho KPI/tóm tắt/Markdown
  để không lệch nhau; có test bất biến khoá với `buildDailyReport`.)*

## [0.0.16] — chưa phát hành

- **Dọn nốt dấu vết "Epic" trong phần báo cáo.** Báo cáo ngày đã gom theo **Dự án → Task** từ
  0.0.15; lần này bỏ chỗ còn sót:
  - **Chi tiết task** (mở một việc) không còn dòng `**Epic:** …`; thay bằng `**Dự án:** …` (tên dự
    án suy từ `cwd`) cho khớp cách gom của báo cáo và cây checklist.
  - **README** sửa lại mô tả "Báo cáo ngày … theo Epic" → "theo **Dự án → Task**" cho khớp code.
  - *(Backend Epic phần phân loại/cây vẫn dormant như cũ — chỉ động vào phần báo cáo theo yêu cầu.)*
- **Gộp 2 nút báo cáo thành 1.** Trước đây thanh tiêu đề có "Tạo báo cáo hôm nay" và "Mở báo cáo" —
  thực chất cùng mở một panel, chỉ khác nút đầu ép về hôm nay còn nút sau giữ ngày đang xem. Nay chỉ
  còn **một nút "Mở báo cáo"** (icon `$(graph)`) mở báo cáo **hôm nay**; vẫn điều hướng ngày bằng
  ◀ Hôm trước / Hôm sau ▶ trong panel. Bỏ lệnh `taskMind.generateReport`.

## [0.0.15] — chưa phát hành

- **Báo cáo ngày gom theo Dự án** (khớp với cây checklist), thay cho gom theo Epic trước đây. Mỗi
  mục báo cáo giờ là một dự án (tên dự án từ `cwd`), dự án có việc mới nhất lên đầu; áp cho cả
  webview báo cáo lẫn xuất Markdown. *(Báo cáo theo từng ngày nên tương đương cấp "Dự án" của
  checklist.)*
- **Nhóm cây 2 cấp.** `taskMind.tree.groupBy` giờ chỉ còn 2 chế độ: **`project-day`** (Dự án → Ngày,
  mặc định) và **`day-project`** (Ngày → Dự án). Bỏ 2 chế độ phẳng cũ (`project`/`day` tự ánh xạ sang
  chế độ 2 cấp tương ứng). Nút title-bar "Đổi cách nhóm" đảo qua lại giữa 2 chế độ.
- **Toàn bộ phần Cài đặt sang tiếng Anh.** Cấu hình trong Settings gốc VS Code (`contributes.configuration`)
  và panel **Settings** (webview trong sidebar) đã đổi nhãn/mô tả sang tiếng Anh; panel cũng đổi tên từ
  "Cài đặt" → "Settings". *(Tiêu đề/tóm tắt task do AI sinh vẫn theo ngôn ngữ nội dung.)*
- **Ẩn mọi lệnh Task Mind khỏi Command Palette (Ctrl+Shift+P).** Mọi thao tác giờ truy cập qua sidebar
  (nút title-bar, menu chuột phải, panel Settings). *Lưu ý: `taskMind.createEpic` và
  `taskMind.exportReportMarkdown` trước chỉ vào được từ palette → giờ chỉ gọi được bằng lệnh; báo nếu
  cần thêm nút. Các mục "Focus on … View" / "Show Task Mind" do VS Code tự sinh, không ẩn được.*
- **"Dựng lại toàn bộ task" không còn xoá mất các việc đã check.** Trước đây thao tác này bỏ mọi
  correction (gồm trạng thái hoàn thành) và cắt dữ liệu theo `backfillDays`, nên dễ mất sạch tick
  của nhiều ngày. Nay:
  - **Khôi phục trạng thái check tự động.** Sau khi dựng lại, trạng thái `done`/`abandoned` của việc
    và `done` của subtask được map sang task mới qua `lineUuid` của lượt (id task/subtask đổi nhưng
    lượt ổn định). Bảo thủ: chỉ đặt lại trạng thái khi MỌI lượt của task mới cùng thuộc một trạng thái
    cũ (gộp done + đang-làm → giữ in_progress, tránh báo "xong" nhầm). Subtask khớp theo tiêu đề.
  - **Hộp xác nhận cảnh báo trước khi chạy** (áp cho cả lệnh lẫn nút trong panel Cài đặt). Cảnh báo
    nêu **số việc các ngày trước sẽ bị xoá vĩnh viễn** theo `backfillDays`, và cho chọn **"Giữ toàn
    bộ lịch sử"** (bỏ cắt cửa sổ ngày để không mất task cũ và khôi phục được check) hoặc **"Chỉ N ngày
    gần nhất"**.
  - Thông báo kết quả báo rõ số việc/subtask đã khôi phục và số việc bị cắt theo cửa sổ.

## [0.0.14] — chưa phát hành

- **Nhóm cây theo Dự án thay cho Epic.** Setting `taskMind.tree.groupBy` giờ là `project` (mặc định)
  hoặc `day`; các việc cùng một dự án (theo `cwd`) gom chung một node (icon `repo`, tooltip là
  đường dẫn). Nút title-bar đổi thành **"Đổi cách nhóm (Dự án/Ngày)"**. Giá trị cũ `epic` tự được
  ánh xạ sang `project`. *Backend Epic (phân loại AI, lệnh Epic) vẫn giữ nguyên, chỉ ẩn khỏi giao
  diện nhóm.*
- **Panel Cài đặt (webview) trong sidebar.** Thêm view `taskMind.settingsView` cho phép chỉnh mọi
  setting ngay trong sidebar Task Mind: bật/tắt bắt việc, ngưỡng gộp, engine AI, cách nhóm, ngôn
  ngữ, báo cáo… kèm **nhập/xoá API key**, nút **Kiểm tra AI** và **Dựng lại toàn bộ task**. Lệnh
  **Task Mind: Mở cài đặt** giờ mở panel này; vẫn còn **Mở cài đặt gốc (VS Code)** để dùng UI gốc.

## [0.0.13] — chưa phát hành

- **Tự động xoá task "thiếu thông tin"** (setting mới `taskMind.autoDeleteFailedTasks`, mặc định bật).
  Khi AI đã trả lời bình thường nhưng không đặt được tên (nội dung quá mỏng) → task tự bị xoá thay
  vì gắn ⚠️. Áp dụng cả ở luồng live lẫn "Dựng lại toàn bộ task".
  - **An toàn:** chỉ xoá khi AI thật sự trả lời. Nếu lỗi gọi AI tạm thời (mạng/429/sai key) hoặc AI
    không khả dụng (rơi heuristic) → KHÔNG xoá, vẫn gắn ⚠️ để bạn thử lại.
  - **Không** auto-xoá khi bạn bấm "Dựng lại task này (AI)" — giữ quyền retry/xoá cho bạn.
  - Hardening client `vscode-lm`: clear `lastError` mỗi lần gọi + báo lỗi khi không chọn được model/
    trả rỗng (để phân biệt "AI lỗi" với "nội dung mỏng" cho chuẩn).

## [0.0.12] — chưa phát hành

- **Sửa task bị trùng** (1 prompt đẻ ra nhiều task ⚠️ giống hệt). Nguyên nhân: dữ liệu gốc bị
  nạp lặp (cùng `lineUuid`, khác `eventId`) khiến một lượt bị gán vào nhiều task.
  - `Dựng lại toàn bộ task` giờ **khử trùng lượt theo `lineUuid`** (giữ bản sớm nhất) và rút gọn
    `session_meta`/`agent_todo` (chỉ giữ bản mới nhất mỗi session) → log gọn lại.
  - Projection thêm **bất biến idempotency**: một lượt chỉ thuộc đúng MỘT task (chống event gom
    nhóm lặp tạo task trùng khi replay). Trên dữ liệu sạch là no-op.

## [0.0.11] — chưa phát hành

- **Không tạo task rác từ lượt không phải việc**: lời chào ("Hi/Hí"), cảm ơn, câu xác nhận lẻ
  ("ok", "tiếp đi") hoặc lượt không có chữ (toàn emoji/dấu câu) sẽ **không sinh task mới**.
  Bộ lọc chạy cả khi AI tắt; lượt nối tiếp trong task đang mở KHÔNG bị ảnh hưởng; câu hỏi/thảo
  luận có nội dung vẫn được giữ (gắn ⚠️ nếu AI không đặt được tên).
- **Nút xoá trực tiếp (inline)** trên task ⚠️ — không cần chuột phải nữa.
- **Đổi publisher** `rcvn` → `shiroenguyen` (ID extension giờ là `shiroenguyen.task-mind`). Dữ liệu
  globalStorage đổi thư mục theo ID mới — đã có hướng dẫn chép dữ liệu cũ sang để không mất.
- **Thêm icon extension** (`media/icon.png`, 256×256): nền gradient indigo→violet, **bộ não** (nếp gấp)
  + huy hiệu ✓ + sparkle — gợi đúng tinh thần "Task Mind".

## [0.0.10] — chưa phát hành

- **Bỏ tự gom** task thiếu thông tin (gây sụp số lượng task). Reprocess giờ **giữ nguyên** task,
  task nào AI không đặt được tên thì gắn ⚠️ và **để người dùng tự xoá**.
- Lệnh **"Xoá các task không đặt được tên (⚠️)"** (nút trên thanh tiêu đề) xoá hàng loạt; hoặc
  chuột phải từng task → Xoá; hoặc "Dựng lại task này" rồi chọn Xoá nếu vẫn lỗi.

## [0.0.9] — chưa phát hành

- **Tự gom task thiếu thông tin**: task mà AI không đặt tên được (lượt mỏng) thường là một phần
  của task liền trước → tự **gom vào task liền trên CÙNG session** rồi tóm tắt lại (đủ thông tin).
  Chạy tự động sau "Dựng lại toàn bộ task" và khi "Dựng lại task này" vẫn fail.
- Báo cáo reprocess thêm số task được gom.

## [0.0.8] — chưa phát hành

- **Bỏ heuristic ở chế độ AI**: khi dùng AI mà gom nhóm/đặt tên thất bại thì KHÔNG chế tên thô —
  task bị **gắn cờ ⚠️** và giữ nhãn tạm; báo rõ số lượng fail sau khi dựng.
- **Lệnh "Dựng lại task này (AI)"** trên từng task (chuột phải) để thử lại riêng task lỗi.
- **Reprocess mặc định chỉ HÔM NAY** (`backfillDays=1`) cho ít dữ liệu.
- (Heuristic vẫn dùng khi hoàn toàn không có AI — vì khi đó là lựa chọn duy nhất.)

## [0.0.7] — chưa phát hành

Sửa lỗi "API chạy nhưng dựng lại không dùng AI".

- **Pre-check không chặn nhầm**: chỉ chặn reprocess khi thực sự không có model; nếu model đã cấu
  hình mà test vấp lỗi nhất thời thì vẫn dựng (mỗi lượt có retry + fallback).
- **reprocess tự build lại engine** từ cấu hình + key hiện tại (không dùng `this.ai` lỗi thời).
- **Báo minh bạch**: "Đã dựng N task — tên: X bằng AI, Y heuristic" + hiện lỗi AI nếu có fallback.
- **Retry/backoff** cho 429 (rate limit) & 5xx (overloaded) ở mọi provider key ngoài.

## [0.0.6] — chưa phát hành

- **Hiện lý do lỗi AI thật** (HTTP status + body) trong "Kiểm tra AI" / "Nhập API key" / reprocess —
  thay vì nuốt lỗi. Giúp biết ngay vì sao Gemini/OpenAI/Anthropic không chạy (key sai, model sai…).
- Sửa request Gemini: `systemInstruction` (camelCase), tăng maxOutputTokens, báo `finishReason` khi rỗng.

## [0.0.5] — chưa phát hành

- **Hỗ trợ Google Gemini** làm provider API key ngoài (cạnh Anthropic & OpenAI). Đặt
  `taskMind.ai.externalProvider = "gemini"` rồi "Nhập API key". Model mặc định `gemini-2.0-flash`.

## [0.0.4] — chưa phát hành

- **Lệnh "Kiểm tra AI"** (`taskMind.aiStatus`): gọi thử model, báo rõ AI có chạy không + ví dụ
  tiêu đề. Giúp chẩn đoán vì sao tên task xấu (thường do CHƯA có Copilot/API key → rơi heuristic).
- **Nhập API key** giờ tự thử & xác nhận key chạy được ngay.
- **Reprocess "dùng AI"** kiểm tra model trước; nếu chưa có thì cảnh báo (tránh dựng lại ra tên thô).

## [0.0.3] — chưa phát hành

- **Tiêu đề task có nghĩa**: AI đặt tiêu đề dạng "Động từ + đối tượng" ngắn gọn + kèm tên dự án
  (vd "Fix lỗi npx cho dự án X", "Tạo favicon cho demo Y") thay vì chép nguyên prompt.
- **Giới hạn backfill theo ngày** (`taskMind.capture.backfillDays`, mặc định 2): khi quét lịch sử
  và khi "Dựng lại task" chỉ lấy lượt trong N ngày gần đây — tập trung hôm nay + tương lai, bỏ
  dữ liệu cũ. Lượt live (mới) luôn được ghi bất kể giới hạn.

## [0.0.2] — chưa phát hành

Sửa lỗi tổ chức task (mỗi prompt thành 1 task) → gom nhóm theo ngữ nghĩa.

- **Gom nhóm v2**: so khớp lượt mới với MỌI task đang mở (`ai.matchTask`) thay vì chỉ task gần
  nhất theo phiên/thời gian; bỏ ranh giới theo ngày (một task trải nhiều ngày).
- Fallback heuristic: overlap từ khoá + prior "cùng phiên với task mới nhất" (đỡ vỡ vụn khi AI tắt).
- Lệnh **Dựng lại toàn bộ task** (`taskMind.reprocess`): gom nhóm lại từ lịch sử, ghi an toàn
  có backup, báo rõ engine đã dùng (Copilot / API key / heuristic).
- Lệnh **Mở chi tiết việc** (`taskMind.openTask`): card Markdown Title/Status/Summary/Subtask/History.
- Backfill chạy nền không chặn activate; ingest tăng dần O(n); checkbox thủ công (không cascade).

## [0.0.1] — chưa phát hành

Phiên bản đầu tiên (MVP).

- Tự bắt việc từ transcript Claude Code (`~/.claude/projects/**/*.jsonl`) qua polling tail-read.
- Gom nhóm lượt hỏi thành việc (heuristic + AI judge ở vùng nhập nhằng), update tại chỗ không trùng.
- Phân cấp `Epic → Task → Subtask`; AI tự phân loại Epic; Subtask từ `TodoWrite` của agent hoặc AI.
- TreeView checklist ở activity bar với checkbox, 2 chế độ nhóm (Epic / Ngày).
- Lệnh: làm mới, đổi nhóm, đánh dấu xong, sửa tiêu đề, gộp/tách việc, chuyển/đổi tên/xoá Epic,
  thêm/tick/xoá subtask, nhập API key.
- Báo cáo ngày (webview) gom theo Epic, xuất Markdown, lịch tự tạo theo giờ.
- Engine AI chọn được: VS Code LM (Copilot) / API key ngoài (Anthropic, OpenAI) / heuristic offline.
- Kiến trúc event-log append-only + projection tính lại được.
