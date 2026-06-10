# Task Mind

Extension VS Code tự động ghi lại **việc bạn giao cho AI agent (Claude Code)** thành một
checklist phân cấp `Epic → Task → Subtask`, tự tóm tắt, gom nhóm và tổng kết **báo cáo theo
ngày** — giống Jira nhưng **sinh từ chat**.

## Tính năng

- **Tự bắt việc**: theo dõi transcript của Claude Code (`~/.claude/projects/**/*.jsonl`) — không
  cần sửa cấu hình, dựng lại được cả lịch sử cũ.
- **Gom nhóm thông minh**: nhiều lượt hỏi cho cùng một mục tiêu được gộp vào **một việc** (update
  tại chỗ, không tạo trùng). Heuristic + AI phán đoán ở vùng nhập nhằng.
- **Phân cấp 3 tầng** `Epic → Task → Subtask`: AI tự gán việc vào chủ đề (Epic) và chẻ nhỏ thành
  Subtask. Subtask còn lấy được từ `TodoWrite` của agent.
- **Checklist tương tác**: tick xong/chưa xong ngay trên cây ở sidebar; gộp/tách/đổi tên/chuyển Epic.
- **Báo cáo ngày**: webview tổng hợp việc trong ngày theo **Dự án → Task** (khớp cây checklist),
  có KPI và **xuất Markdown**; tự tạo vào giờ đặt trước.
- **Engine AI chọn được**: VS Code Language Model (Copilot, không cần key) / API key ngoài
  (Anthropic, OpenAI) / heuristic offline. Mặc định `auto` với fallback heuristic luôn hoạt động.

## Cách dùng nhanh

1. Mở biểu tượng **Task Mind** ở thanh activity bar.
2. Khi bạn giao việc cho Claude Code, việc sẽ tự xuất hiện sau vài giây.
3. Tick checkbox để đánh dấu xong; chuột phải để gộp/tách/đổi Epic.
4. Bấm biểu tượng báo cáo trên thanh tiêu đề để xem/ xuất báo cáo ngày.

## Cấu hình chính (`taskMind.*`)

| Khoá | Mặc định | Ý nghĩa |
|---|---|---|
| `autoCapture.enabled` | `true` | Bật/tắt tự bắt việc |
| `capture.idleGapMinutes` | `20` | Ngưỡng nghỉ để gộp lượt thành một việc |
| `ai.provider` | `auto` | `auto` / `vscode-lm` / `external` / `heuristic` |
| `ai.externalProvider` | `anthropic` | Nhà cung cấp khi dùng API key ngoài |
| `hierarchy.autoClassify` | `true` | AI tự gán việc vào Epic |
| `hierarchy.subtaskSource` | `both` | `agent-todo` / `ai` / `both` / `off` |
| `tree.groupBy` | `project-day` | Nhóm cây 2 cấp: `project-day` (Dự án → Ngày) hay `day-project` (Ngày → Dự án) |
| `report.time` | `18:00` | Giờ tạo báo cáo ngày |

Tất cả cấu hình trên có thể chỉnh trực tiếp trong panel **Settings** ở sidebar Task Mind
(gồm cả nhập API key, kiểm tra AI, dựng lại task); nhãn trong panel này là tiếng Anh. Lệnh
**Task Mind: Mở cài đặt** sẽ mở panel này. *(Các lệnh Task Mind đã được ẩn khỏi Command Palette —
dùng nút/menu trong sidebar.)*

## Phát triển

```bash
npm install
npm run watch      # biên dịch TypeScript theo dõi thay đổi
# Nhấn F5 trong VS Code để chạy Extension Development Host
npm test           # smoke test (mock vscode)
```

## Cơ chế

Một **event log append-only** là nguồn sự thật; Epic/Task/Subtask/Báo cáo là projection tính lại
được — nên idempotent, đồng bộ nhiều cửa sổ, và **gộp/tách sửa sau** được. Xem `PLAN.md` để biết
thiết kế chi tiết.
