# PLAN.md — Task Mind: Extension VS Code theo dõi checklist task của AI Agent

> Tài liệu này là kế hoạch đầy đủ cho extension. **Giai đoạn hiện tại chỉ lập kế hoạch, chưa code.**

---

## 1. Context — Vì sao làm cái này

Người dùng làm việc với AI agent (Claude Code) ngay trong VS Code. Mỗi ngày giao rất
nhiều "việc" cho agent, nhưng:

- Không có nơi nào tổng hợp lại **hôm nay đã giao những việc gì** cho AI.
- Một việc thường phải hỏi/đáp nhiều lượt mới xong → nếu ghi mỗi lượt thành 1 dòng thì
  danh sách bị loãng, trùng lặp.
- Cuối ngày muốn có **báo cáo** đã làm gì thì phải tự nhớ.

**Mục tiêu**: một extension VS Code tự động:
1. **Tự tóm tắt & lưu** mỗi khi giao một task cho agent.
2. **Gộp các lượt hỏi của cùng một task** vào một mục (update task cũ, không tạo mục mới).
3. **Tổng kết báo cáo theo từng ngày**.
4. **Tự phân cấp công việc 3 tầng `Epic → Task → Subtask`** (giống Jira nhưng **sinh từ chat**):
   AI tự phân loại các task cùng chủ đề vào một Epic và chẻ nhỏ thành Subtask.

Kết quả mong muốn: một checklist sống động ở thanh sidebar, tự cập nhật theo công việc
thực tế với agent, hiển thị dạng cây phân cấp Epic → Task → Subtask, và một báo cáo ngày
xuất ra được.

```
Epic
 └ Task
    └ Subtask

Ví dụ:
Authentication
 ├ Google Login
 ├ Facebook Login
 └ Password Reset
```

---

## 2. Phân tích ý tưởng

### 2.1 Ý tưởng có khả thi không?
**Có.** Claude Code ghi lại toàn bộ phiên làm việc thành file transcript dạng JSON Lines
(`.jsonl`) tại `~/.claude/projects/<thư-mục-mã-hoá>/<session-id>.jsonl`. Mỗi dòng là một
sự kiện (prompt của người dùng, phản hồi của AI, gọi tool…). Extension chỉ cần **đọc các
file này** là bắt được mọi việc đã giao cho agent — không cần plugin của Claude, không cần
sửa cấu hình.

### 2.2 Những phát hiện quan trọng từ transcript thật (đã kiểm chứng)
Việc đọc transcript thật cho thấy một số điểm tinh tế **bắt buộc phải xử lý**, nếu không
checklist sẽ đầy rác:

| Phát hiện | Hệ quả với thiết kế |
|---|---|
| Dòng `type:"user"` gồm **cả prompt người thật lẫn `tool_result`** (cùng `promptId`) | Phải lọc: prompt người thật = có phần `type:"text"` và **không** có phần `tool_result`. |
| ~32% dòng "user" là **IDE tự chèn** (`<ide_opened_file>`, `<ide_selection>`…) | Phải lọc theo danh sách tiền tố (denylist), nếu không sẽ tạo task ma. |
| `isSidechain:true` đánh dấu lượt của **subagent** | Phải bỏ, nếu không subagent tạo task ma. |
| `promptId` = **1 lượt người dùng**, KHÔNG phải 1 task (1 phiên có thể 8 promptId) | `promptId` chỉ gộp prompt + tool_result của chính nó; gom thành task là việc riêng. |
| `ai-title` = tiêu đề **của cả session**, đặt 1 lần, không đổi | Dùng làm "hạt giống" tiêu đề task đầu tiên, không dùng để tách nhiều task. |
| `slug` thường `undefined` trong phiên tương tác | Không dùng làm khoá gom nhóm. |
| Tên thư mục mã-hoá-cwd là ánh xạ **mất mát** (`:` `\` `/` `_` đều thành `-`) | **Không** parse ngược tên thư mục; đọc trường `cwd` thật có trên **mỗi dòng**. |
| `cwd` có trên mọi dòng = đường dẫn gốc thật của dự án | Khoá phân vùng theo dự án + cho phép "xem toàn cục mọi dự án" miễn phí. |
| Không suy ra "done" từ `stop_reason` (agent kết thúc lượt bằng câu hỏi vẫn là `end_turn`) | "Done" phải thủ công + cờ "stale", không tự động hoá hoàn toàn. |
| Prompt bằng **tiếng Việt** | Tóm tắt/tiêu đề phải giữ ngôn ngữ gốc. |
| File transcript **append-only**, nằm **ngoài** workspace | Đọc tăng dần theo byte-offset; watcher dạng **polling** (FileSystemWatcher không đáng tin cho path ngoài workspace trên Windows). |
| `settings.json` đã gắn sẵn pipeline `.pixel-agents` cho mọi hook | **Không đụng** vào hook → chọn cách theo dõi transcript (không xâm lấn). |

### 2.3 Phần khó nhất: gom nhóm "nhiều lượt → một task"
Đây là trái tim của yêu cầu #2. Định nghĩa chốt:

> **Một task = chuỗi liên tục một hoặc nhiều lượt người dùng, trong cùng một dự án (`cwd`),
> cùng theo đuổi một mục tiêu — bao gồm mọi lượt làm rõ, sửa lại, "tiếp đi", "đúng rồi",
> "fix giúp" cần để hoàn thành mục tiêu đó.**

Hệ quả: 1 session ≠ 1 task (một phiên có thể nhiều task); phần lớn lượt người dùng **không**
phải task mới mà là lượt nối vào task đang mở. Công việc của bộ gom nhóm vừa là **tách** mục
tiêu mới, vừa là **hấp thụ** các lượt hội thoại phụ.

### 2.4 Phân cấp 3 tầng — khả thi & nguồn dữ liệu
Phân cấp `Epic → Task → Subtask` là một **tầng phân loại** đặt **lên trên** kết quả gom nhóm:

- **Task** (đã có ở §2.3) = một mục tiêu cụ thể gom từ các lượt chat (vd "Google Login").
  Đây là đơn vị trung tâm có checkbox/trạng thái.
- **Epic** = chủ đề/tính năng lớn gom nhiều Task cùng hướng (vd "Authentication"). **AI tự
  phân loại**: so khớp ngữ nghĩa Task mới với các Epic hiện có; nếu không khớp thì tạo Epic
  mới và tự đặt tên.
- **Subtask** = chẻ nhỏ của một Task. **Hai nguồn**: (a) AI tự chẻ mục tiêu thành các bước;
  (b) **lấy trực tiếp từ kế hoạch/`TodoWrite` của agent** trong transcript — Claude Code
  thường tạo todo-list khi làm việc, đây là nguồn subtask **rẻ, không cần AI**.

Vì phân loại có thể sai, mọi quan hệ cha-con đều **sửa được thủ công** (gán Epic, đổi cấp,
thêm/đánh dấu Subtask) và lưu dưới dạng sự kiện `correction` (xem §5–§6).

---

## 3. Quyết định thiết kế (đã chốt với người dùng)

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | **Gom nhóm task** | **Theo mục tiêu (ngữ nghĩa)**: heuristic (cùng session, khoảng nghỉ thời gian, câu khẳng định ngắn, cụm "việc khác/task mới") làm prior; AI phán đoán ở vùng nhập nhằng. |
| 2 | **Đánh dấu done** | **Thủ công 1-click + cờ "stale"** tự gắn khi task không có lượt mới sau ~24h (chỉ nhắc, không tự đóng). |
| 3 | **Engine AI** | **Cho người dùng chọn**: (a) VS Code LM API / Copilot (không cần key), (b) API key ngoài (Anthropic/OpenAI), (c) heuristic offline làm fallback luôn-sẵn-sàng. Mặc định `auto`: ưu tiên LM API → API key → heuristic. |
| 4 | **Cơ chế bắt task** | **Theo dõi file transcript `.jsonl`** (polling tăng dần, không sửa cấu hình, dựng lại được lịch sử cũ). |
| 5 | **Phân cấp công việc** | **3 tầng `Epic → Task → Subtask`, AI tự phân loại** (giống Jira nhưng sinh từ chat). Epic gom Task theo ngữ nghĩa; Subtask từ AI chẻ nhỏ hoặc từ `TodoWrite` của agent. Mọi quan hệ sửa tay được. |

---

## 4. Kiến trúc tổng thể

```
~/.claude/projects/**/*.jsonl   (append-only, ngoài workspace)
        │  polling tail-read (stat short-circuit + byte cursor + buffer dòng dở)
        ▼
   [Capture]  lineParser: lọc prompt người thật (bỏ sidechain / tool_result / IDE-inject)
        │  emit sự kiện idempotent theo khoá (sessionId, promptId, lineUuid)
        ▼
   [EVENT LOG]  append-only JSONL trong globalStorage  ← nguồn sự thật duy nhất
        │  (mọi chỉnh sửa của user = append "correction", không ghi đè)
        ▼
   [Projection]  phát lại log → 
        ├─ [Grouping]    heuristic + AI judge (vùng nhập nhằng) → gom lượt thành Task
        ├─ [Classifier]  AI gán Task → Epic (tạo Epic mới nếu cần) + chẻ Subtask (AI / TodoWrite)
        ├─ [Summarizer]  ai-title → LM/API key → heuristic (debounce) → tiêu đề + tóm tắt
        ▼
   [Epic ⊃ Task ⊃ Subtask]  (Task: in_progress / stale / done)   +   [DailyReport]
        ▼
   UI: TreeView phân cấp Epic→Task→Subtask (sidebar)  +  Webview báo cáo ngày  +  xuất TASKS.md / report.md
```

**Nguyên tắc cốt lõi:** **Event log append-only là nguồn sự thật; Task & DailyReport là
projection tính lại được.** Một quyết định này giải quyết đồng thời: idempotency khi đọc lại
file, đồng bộ nhiều cửa sổ VS Code, và khả năng **gộp/tách task sau khi đã gom** (vì gom nhóm
chắc chắn có lúc sai → cần sửa lại mà không phá dữ liệu).

---

## 5. Mô hình dữ liệu (hình dạng, chưa phải code)

**CaptureEvent (log — mỗi dòng một sự kiện):**
- `human_turn` — `{ eventId, ts, sessionId, promptId, lineUuid, cwd, projectKey, text, gitBranch, version, entrypoint }`
- `assistant_text` — `{ eventId, ts, sessionId, promptId, lineUuid, cwd, textExcerpt, model }`
- `session_meta` — `{ eventId, ts, sessionId, cwd, aiTitle? }`
- `grouping_decision` — `{ eventId, ts, turnRef, taskId, decision:"new"|"append", reason:"heuristic"|"llm"|"manual", confidence? }`
- `classification` — `{ eventId, ts, taskId, epicId, epicTitle?, reason:"heuristic"|"llm"|"manual", confidence? }`
- `subtask` — `{ eventId, ts, taskId, subtaskId, title, source:"ai"|"agent-todo"|"manual", done? }`
- `correction` — `{ eventId, ts, op:"merge"|"split"|"set_status"|"retitle"|"set_epic"|"create_epic"|"rename_epic"|"move_task"|"promote"|"demote"|"toggle_subtask", payload }`
- `summary` — `{ eventId, ts, targetId, targetKind:"epic"|"task", title, summary, lang, source:"ai-title"|"lm"|"external"|"heuristic" }`

Khoá idempotent khi nạp: `(sessionId, promptId, lineUuid)`.

**Phân cấp (projection):** `WorkItemKind = "epic" | "task" | "subtask"`.

**Epic (projection):**
`{ id, kind:"epic", projectKey, cwd, title, summary, source:"ai"|"manual", createdAt, updatedAt,
taskIds[], progress:{done, total}, status (derived: rollup từ Task con) }`

**Task (projection):**
`{ id, kind:"task", epicId?, subtaskIds[], projectKey, cwd, title, summary, summarySource, lang,
status, createdAt, updatedAt, sessionIds[], turns[ {ts, sessionId, promptId, lineUuid, text, assistantExcerpt?} ],
tags[], transcriptLinks[ {filePath, sessionId} ], needsResummarize, groupingConfidence, classifyConfidence }`

**Subtask (projection):**
`{ id, kind:"subtask", taskId, title, status:"todo"|"done", source:"ai"|"agent-todo"|"manual", createdAt }`

**TaskStatus:** `in_progress` (mặc định khi có lượt đầu) → `stale` (tự gắn sau ~24h không
lượt mới, chỉ để nhắc) → `done` (thủ công 1-click) / `abandoned` (thủ công). Mọi đổi trạng
thái = sự kiện `correction` nên sống sót qua mỗi lần tính lại projection.

**Status của Epic = rollup** từ các Task con (vd "2/3 xong"), **không tick trực tiếp**. Status
của Subtask chỉ `todo`/`done`.

**DailyReport (projection):**
`{ date, generatedAt, perProject[ {projectKey, cwd, tasksCompleted[], tasksInProgress[], tasksStarted[]} ],
totals{started, completed, inProgress, turns, sessions}, narrative }`

---

## 6. Thuật toán gom nhóm (yêu cầu #2)

> **CẬP NHẬT (v2, theo phản hồi người dùng):** thay vì so với *một* task đang mở gần nhất
> theo phiên/thời gian (gây mỗi prompt thành 1 task), giờ **so khớp ngữ nghĩa lượt mới với
> MỌI task đang mở của dự án** — đúng spec "Prompt → tìm task gần nhất → đủ giống thì update
> task cũ, không thì tạo mới". Đã **bỏ ranh giới theo ngày** (một task được trải nhiều ngày).
>
> Với mỗi lượt người thật `T` trong dự án `P`, `C` = danh sách task `in_progress` của `P`
> (mới-nhất-trước, cắt 30):
> 1. Lọc rác (như cũ + bổ sung `[Request interrupted`, `<local command caveat`, `This session is being continued…`).
> 2. `C` rỗng → **TASK MỚI**.
> 3. Cụm ranh giới ("việc khác", "task mới") → **TASK MỚI**.
> 4. Câu nối lẻ ngắn ("Go", "tiếp đi") → **nối vào `C[0]`** (task mới nhất).
> 5. **AI matcher** (`matchTask`): đưa danh sách (id, title, summary) + prompt, model trả
>    `taskId` khớp hoặc `null`. Khớp → **nối**, null → **mới**. *(Đây là cơ chế ngữ nghĩa
>    thay cho embedding/Qdrant; có thể nâng cấp lên embedding cosine khi dùng OpenAI key.)*
> 6. Không có AI → **fallback heuristic**: overlap từ khoá với từng task (ngưỡng 0.4); nếu yếu
>    thì prior "cùng phiên với `C[0]` → nối". *(Heuristic vốn yếu cho gom ngữ nghĩa — chất lượng
>    thật cần AI bật.)*
>
> **Lệnh "Dựng lại toàn bộ task"** (`taskMind.reprocess`): giữ event gốc (lượt/phản hồi/todo),
> bỏ event suy diễn cũ, chạy lại pipeline với thuật toán mới + AI; ghi an toàn (backup) và **báo
> rõ engine đã dùng** (Copilot / API key / heuristic). Dùng để sửa dữ liệu đã bắt sai trước đó.

Thuật toán gốc (v1, đã thay) để tham khảo — với `A` = task đang mở của `P`:

1. **Lọc.** Bỏ `T` nếu `isSidechain`, không có phần text, content có `tool_result`, hoặc text
   bắt đầu bằng tiền tố tự chèn (denylist: `<ide_opened_file>`, `<ide_selection>`,
   `<command-name>`, `<local-command-stdout>`, `<system-reminder>`, `Caveat:`).
2. Không có `A` đang mở → **TASK MỚI** (lấy `ai-title` cùng session làm hạt giống tiêu đề).
3. `gap = T.ts − A.lastTurnAt`.
4. Câu khẳng định tầm thường ("ok/tiếp/đúng rồi/làm đi/yes") **và** `gap < SHORT` → **nối vào A**.
5. Cụm ranh giới rõ ràng ("việc khác", "task mới", "chuyển sang") → **TASK MỚI**.
6. `gap > IDLE_MAX` (vd > config phút, hoặc khác ngày) → **TASK MỚI**.
7. Cùng session **và** `gap < SHORT` → **nối vào A**.
8. **Vùng nhập nhằng** (gap trung bình, có thể đổi chủ đề) → **AI judge**
   (so `A.summary` + vài lượt gần nhất với `T.text`) → continue/new + độ tin cậy.
   Nếu không có AI → fallback heuristic (cùng session & `gap < SESSION_GAP` ⇒ nối, ngược lại mới).
9. Nối: cập nhật `A.updatedAt`, thêm turn, đặt cờ `needsResummarize`. Mới: đóng `A` theo
   staleness, tạo task mới từ `T`.

**Kiểm soát chi phí:** AI judge chỉ chạy **tối đa 1 lần/lượt** và **chỉ ở vùng nhập nhằng**.
**Sửa sau:** vì gom nhầm là không tránh khỏi, hỗ trợ **merge/split** bằng cách append sự kiện
`correction` rồi tính lại projection — không migrate dữ liệu.

Ngưỡng (`SHORT`, `IDLE_MAX`, `SESSION_GAP`) là config để người dùng tinh chỉnh; mặc định
thiên về thận trọng để AI judge lo phần thực sự khó.

### 6.1 Phân loại phân cấp Epic → Task → Subtask (yêu cầu #4)
Chạy **sau** khi một Task đã hình thành/được tóm tắt; dùng **cùng engine AI** với judge & summarizer.

**Gán Task vào Epic:**
1. Lấy danh sách Epic hiện có **trong cùng dự án (`cwd`)** + tiêu đề/tóm tắt của chúng.
2. AI so khớp ngữ nghĩa Task ↔ từng Epic. Khớp (độ tin cậy ≥ ngưỡng) → gán vào Epic đó
   (append `classification`). Không khớp → **tạo Epic mới**, AI tự đặt tên ngắn (vd "Authentication").
3. Không có/không bật AI → fallback heuristic: gom theo từ khoá/đường dẫn file chung; cùng lắm
   để Task ở Epic "Khác" (chưa phân loại) cho user kéo sau.

**Chẻ Subtask** (theo setting `taskMind.hierarchy.subtaskSource`):
- `agent-todo` — quét các lượt `assistant` có **`TodoWrite`/kế hoạch** trong transcript của
  task, map mỗi mục todo → 1 Subtask (`source:"agent-todo"`), trạng thái done theo todo. **Rẻ,
  không tốn AI.**
- `ai` — AI chẻ mục tiêu Task thành 3–6 bước (`source:"ai"`).
- `both` (mặc định) — ưu tiên todo của agent, bổ sung bằng AI nếu thiếu.
- `off` — không tạo Subtask.

**Kiểm soát chi phí & sửa tay:** phân loại Epic chạy **tối đa 1 lần/Task** (và lại khi Task đổi
nhiều). Mọi can thiệp tay — `set_epic`, `create_epic`, `rename_epic`, `move_task`, `promote`
(Task→Epic), `demote` (Task→Subtask), `toggle_subtask` — là sự kiện `correction`, sống sót qua
tính lại projection. Phân cấp là **projection tính lại được**, không đóng băng lúc bắt.

---

## 7. Tóm tắt (Summarizer) — provider chọn được

Trừu tượng `SummarizerProvider` với 3 hiện thực, người dùng chọn qua setting
`taskMind.ai.provider` (`auto` | `vscode-lm` | `external` | `heuristic`):

1. **VsCodeLmProvider** — `vscode.lm.selectChatModels()` + `sendRequest()`. Không cần dán key
   nhưng cần có Copilot/model + cấp quyền 1 lần (gate đồng ý). Trả rỗng nếu không có provider.
2. **ExternalApiProvider** — dùng API key người dùng nhập (Anthropic/OpenAI…), lưu trong
   `context.secrets`. Chất lượng cao, không phụ thuộc Copilot, tốn phí.
3. **HeuristicProvider** — luôn chạy, offline: tiêu đề = dòng đầu prompt (đã bỏ markdown,
   ~80 ký tự) hoặc `ai-title`; tóm tắt = ~280 ký tự đầu các lượt người dùng nối lại.

**Thang hạ cấp khi `auto`:** thử LM API → API key ngoài → heuristic. Tiêu đề luôn có (hạt giống
`ai-title` miễn phí). Tóm tắt **giữ tiếng Việt** (ngôn ngữ nguồn). **Debounce:** chỉ tóm tắt
lại khi `needsResummarize` và phiên rảnh, không tóm mỗi lượt. Cùng một model dùng cho cả AI
judge (mục 6) lẫn tóm tắt → chỉ xin quyền 1 lần.

---

## 8. Lưu trữ

- **Nguồn sự thật:** event-log JSONL trong `context.globalStorageUri`:
  `<globalStorage>/task-mind/events/<yyyy-mm>.jsonl` (chia theo tháng để chặn phình file).
  Kèm `cursors.json` (byte-offset từng file transcript) và `projection-cache.json` (Task suy
  ra, xoá được vì dựng lại bất cứ lúc nào).
- **Vì sao global, không workspaceState:** task thuộc về dự án (`cwd`) nhưng người dùng muốn
  **xem toàn cục mọi dự án**. Lưu global, phân vùng bằng `projectKey`; setting `taskMind.scope`
  cho phép lọc về dự án hiện tại nếu muốn.
- **Xuất bản dễ đọc (không phải nguồn sự thật):** lệnh xuất `TASKS.md` / `report-<date>.md`
  từ projection khi cần.
- **Đa cửa sổ VS Code:** ghi append-only chịu được tranh chấp; một `watcher.lock` (pid +
  heartbeat) bầu một cửa sổ làm chủ tiến trình đọc, cửa sổ khác chỉ append `correction`.
  Kể cả không bầu được, append-only + khoá idempotent khiến đọc trùng chỉ phí công, không hỏng.

---

## 9. UI/UX

**Chọn: cả hai, ưu tiên TreeView.** Checklist hợp với TreeView gốc (có sẵn `checkboxState`);
báo cáo ngày hợp với Webview. (Lưu ý: extension tham chiếu `anime-companion` chỉ dùng webview —
ta **cố ý khác** vì checklist dùng TreeView gốc tiết kiệm và đúng paradigm hơn.)

### 9.1 TreeView `taskMind.tasksView` (trong activity-bar)
Cây hỗ trợ **2 chế độ nhóm** (đổi bằng nút title-bar / setting `taskMind.tree.groupBy`):

- **`epic` (mặc định, giống Jira):** `Epic → Task → Subtask`.
- **`day` (xoay quanh báo cáo ngày):** `Hôm nay/Hôm qua/ngày → Task → Subtask` (Epic hiện
  dạng badge ở `description` của Task).

**Node Epic** (`contextValue:"epic"`): icon `$(folder)` / `$(milestone)`; `label` = tên Epic;
`description` = tiến độ rollup (vd `2/3 xong`); **không có checkbox** (chỉ rollup).

**Node Day** (`contextValue:"dayGroup"`, chỉ ở chế độ `day`): nhãn `Hôm nay`/`Hôm qua`/ngày;
`description` = vd `3 việc · 1 xong`. Phân nhóm theo **nửa đêm giờ địa phương**.

**Node Task** (`contextValue:"task"`):
- `checkboxState` ↔ done/undone (qua `createTreeView(...).onDidChangeCheckboxState`).
- `iconPath` theo trạng thái: đang làm `$(sync~spin)`, xong `$(check)`, có vẻ xong/stale
  `$(question)`, lỗi `$(error)`, chờ `$(circle-outline)`.
- `label` = tiêu đề tóm tắt; `description` = thời gian tương đối ("5 phút trước") + Epic (ở chế độ `day`);
  `tooltip` (MarkdownString) = tóm tắt đầy đủ + mốc thời gian + dự án.

**Node Subtask** (`contextValue:"subtask"`): `checkboxState` ↔ todo/done; icon nhỏ; `label` = tiêu đề bước.

- **Trạng thái rỗng** qua `viewsWelcome` (tiếng Việt).
- `TreeView.message` cho trạng thái tạm ("Đang đồng bộ…").

### 9.2 Webview báo cáo ngày
- Header: ngày + điều hướng trước/sau.
- Hàng KPI: tổng việc / đã xong / đang làm.
- Danh sách task nhóm theo trạng thái + icon + tóm tắt + khoảng thời gian.
- Nút "Xuất Markdown".
- CSP theo chuẩn extension tham chiếu: `default-src 'none'; style-src ${cspSource};
  script-src ${cspSource} 'nonce-…'`; asset qua `webview.asWebviewUri`; config qua
  `window.__CONFIG__`; giao tiếp `postMessage`/`onDidReceiveMessage`.

---

## 10. `contributes`, lệnh, cấu hình

### 10.1 contributes (rút gọn)
- `viewsContainers.activitybar`: `{ id:"taskMind", title:"Task Mind", icon:"media/icon.svg" }`
- `views.taskMind`: `{ id:"taskMind.tasksView", name:"Checklist" }` (tree mặc định)
- `viewsWelcome`: nội dung tiếng Việt khi rỗng.
- `menus.view/title`: `toggleGrouping`, `refresh`, `generateReport`, `openReport`.
- `menus.view/item/context`:
  - trên Epic (`viewItem == epic`): `renameEpic`, `deleteEpic`.
  - trên Task (`viewItem == task`): `markDone` (inline), `editTitle`, `moveToEpic`, `promoteToEpic`,
    `addSubtask`, `mergeTasks`, `splitTask`, `deleteTask`.
  - trên Subtask (`viewItem == subtask`): `toggleSubtask` (inline), `deleteSubtask`.
- `configuration` "Task Mind":
  - `taskMind.autoCapture.enabled` (boolean, true)
  - `taskMind.capture.idleGapMinutes` (number, 20) — ngưỡng gộp lượt thành task
  - `taskMind.capture.pollIntervalSeconds` (number, 3)
  - `taskMind.ai.provider` (enum `auto|vscode-lm|external|heuristic`, mặc định `auto`)
  - `taskMind.ai.externalProvider` (enum `anthropic|openai`, mặc định `anthropic`)
  - `taskMind.ai.model` (string, để trống = mặc định)
  - *(API key lưu trong `context.secrets`, không để trong settings)*
  - `taskMind.hierarchy.autoClassify` (boolean, true) — AI tự gán Task vào Epic
  - `taskMind.hierarchy.subtaskSource` (enum `agent-todo|ai|both|off`, mặc định `both`)
  - `taskMind.tree.groupBy` (enum `epic|day`, mặc định `epic`)
  - `taskMind.report.time` (string `HH:MM`, "18:00")
  - `taskMind.report.autoGenerate` (boolean, true)
  - `taskMind.language` (enum `vi|en`, "vi")
  - `taskMind.scope` (enum `global|workspace`, "global")

### 10.2 Lệnh (`taskMind.*`)
| id | Tiêu đề | Hành vi |
|---|---|---|
| `taskMind.refresh` | Làm mới | đọc lại + dựng lại tree |
| `taskMind.toggleGrouping` | Đổi cách nhóm | chuyển `epic` ↔ `day` |
| `taskMind.markDone` / `markUndone` | Đánh dấu xong / bỏ | đổi status (append correction) |
| `taskMind.editTitle` | Sửa tiêu đề | `showInputBox` → retitle |
| `taskMind.deleteTask` | Xoá việc | xác nhận → ẩn task (correction) |
| `taskMind.mergeTasks` | Gộp việc | chọn task khác → gộp |
| `taskMind.splitTask` | Tách việc | tách lượt thành task mới |
| `taskMind.moveToEpic` | Chuyển sang Epic | chọn Epic có sẵn / tạo mới → `set_epic` |
| `taskMind.createEpic` | Tạo Epic | nhập tên → `create_epic` |
| `taskMind.renameEpic` / `deleteEpic` | Đổi tên / Xoá Epic | `rename_epic` / gỡ Epic (Task về "Khác") |
| `taskMind.promoteToEpic` | Nâng thành Epic | Task → Epic (`promote`) |
| `taskMind.addSubtask` | Thêm subtask | `showInputBox` → `subtask` (manual) |
| `taskMind.toggleSubtask` / `taskMind.deleteSubtask` | Tick / Xoá subtask | `toggle_subtask` / gỡ subtask |
| `taskMind.generateReport` | Tạo báo cáo hôm nay | dựng DailyReport |
| `taskMind.openReport` | Mở báo cáo | mở/hiện webview |
| `taskMind.exportReportMarkdown` | Xuất báo cáo Markdown | report-builder → save dialog |
| `taskMind.setApiKey` | Nhập API key | `showInputBox` → `secrets.store` |
| `taskMind.openSettings` | Mở cài đặt | `@ext:…` |
| `taskMind.simulateTask` *(dev)* | Tạo việc mẫu | bắn sự kiện MockCaptureService |

---

## 11. Cấu trúc thư mục (mirror `anime-companion`)

```
task-mind/
├─ .editorconfig  .eslintrc.cjs  .gitignore  .gitattributes
├─ .vscode/{ launch.json, tasks.json, settings.json }
├─ media/{ icon.svg, report.css, webview/report.js }
├─ scripts/smoke-test.js          # node+assert, mock vscode (mirror reference)
├─ out/                           # tsc output (gitignored)
├─ src/
│   ├─ extension.ts               # activate/deactivate, wiring
│   ├─ log.ts                     # OutputChannel logger
│   ├─ config.ts                  # getter có kiểu trên workspace.getConfiguration('taskMind')
│   ├─ types.ts                   # CaptureEvent, Epic, Task, Subtask, TaskStatus, DailyReport
│   ├─ store/
│   │   ├─ event-log.ts           # append-only JSONL + projection + lock + globalStorage
│   │   └─ projection.ts          # phát lại log → Task[] / DailyReport
│   ├─ capture/
│   │   ├─ capture-service.ts     # interface (seam tích hợp)
│   │   ├─ mock-capture-service.ts# fake emitter theo timer
│   │   ├─ transcript-watcher.ts  # polling tail-read, cursor, buffer dòng dở, quét cây projects
│   │   └─ line-parser.ts         # lọc human-turn (sidechain/tool_result/denylist), build event
│   ├─ brain/
│   │   ├─ grouping.ts            # thuật toán mục 6 + merge/split
│   │   ├─ classifier.ts         # gán Task→Epic + chẻ Subtask (mục 6.1) + todo-parser của agent
│   │   ├─ summarizer.ts          # SummarizerProvider abstraction (mục 7)
│   │   └─ providers/{ vscode-lm.ts, external-api.ts, heuristic.ts }
│   ├─ tree/{ task-tree-provider.ts, task-tree-node.ts }   # node: Epic | Day | Task | Subtask, 2 chế độ nhóm
│   ├─ report/{ report-view.ts, report-builder.ts }
│   ├─ commands.ts
│   └─ scheduler.ts               # timer báo cáo ngày theo report.time
├─ tsconfig.json  package.json  README.md  CHANGELOG.md  LICENSE
```

**Seam tích hợp** — `CaptureService` (UI chỉ phụ thuộc interface này, không import brain cụ thể):
```ts
interface CaptureService {
  onTaskCreated: vscode.Event<Task>;
  onTaskUpdated: vscode.Event<Task>;
  getTasks(): Promise<Task[]>;
  getDailyReport(dateISO: string): Promise<DailyReport>;
  start(): void; dispose(): void;
}
```
Cắm `MockCaptureService` trước → sau thay brain `.jsonl` thật mà không đổi UI.

**File tham chiếu để copy/điều chỉnh** (đường dẫn tuyệt đối):
- `…\anime-companion-vscode\package.json` — mẫu contributes/scripts/engines/files
- `…\anime-companion-vscode\src\extension.ts` — mẫu activate/đăng ký
- `…\anime-companion-vscode\src\companion-view.ts` — mẫu webview/CSP/asWebviewUri
- `…\anime-companion-vscode\src\chat\conversation-store.ts` — mẫu lưu JSON dưới globalStorage
- `…\anime-companion-vscode\scripts\smoke-test.js` — mẫu test (thêm spy `createTreeView`)

**Tech stack:** TypeScript 5 strict, `tsc` thuần (không esbuild/webpack), `engines.vscode ^1.85.0`,
`activationEvents:["onStartupFinished"]`, ESLint + @typescript-eslint, đóng gói `vsce`/`ovsx`.

---

## 12. Lộ trình theo Phase (mỗi phase chạy/test được dưới F5)

### Phase 0 — Khởi tạo scaffold
- **Mục tiêu:** extension rỗng chạy được.
- **Giao phẩm:** `package.json` (engines/scripts/contributes khung), `tsconfig.json`,
  `.vscode/{launch,tasks,settings}.json`, `.eslintrc.cjs`, `src/extension.ts` (activate no-op),
  `src/log.ts`, `scripts/smoke-test.js`.
- **Tiêu chí nghiệm thu:** F5 mở Extension Host không lỗi; `npm test` xanh.

### Phase 1 — Lõi dữ liệu + seam + Mock
- **Mục tiêu:** tầng dữ liệu + interface tích hợp, test headless được.
- **Giao phẩm:** `types.ts`, `store/event-log.ts` + `store/projection.ts` (append/get/projection),
  `capture/capture-service.ts` (interface), `capture/mock-capture-service.ts` (timer phát/cập nhật task giả).
- **Nghiệm thu:** test node round-trip store (tạo → update theo id giữ 1 mục → xoá); mock bắn
  `onTaskCreated`/`onTaskUpdated`.

### Phase 2 — TreeView checklist phẳng (chạy với mock)
- **Mục tiêu:** checklist hiện ra, tương tác được (chưa phân cấp — Epic/Subtask thêm ở Phase 6).
- **Giao phẩm:** `viewsContainer`+`views`+`viewsWelcome` trong `package.json`;
  `tree/task-tree-node.ts`, `tree/task-tree-provider.ts`; `extension.ts` dùng
  `window.createTreeView` + `onDidChangeCheckboxState` để lưu done/undone; nhóm `Hôm nay/Hôm qua/ngày → Task`.
- **Nghiệm thu:** dưới F5 với mock — có icon sidebar; tree hiện nhóm Hôm nay/Hôm qua; tick
  checkbox được lưu và sống sót sau reload.

### Phase 3 — Lệnh & menu thao tác
- **Mục tiêu:** tương tác checklist đầy đủ.
- **Giao phẩm:** `commands.ts` (markDone/markUndone/editTitle/deleteTask/mergeTasks/splitTask/refresh);
  menu `view/title` + `view/item/context`; `contextValue` trên node.
- **Nghiệm thu:** mỗi lệnh đổi store + refresh tree; menu chỉ hiện trên đúng loại node.

### Phase 4 — Bắt dữ liệu thật (transcript watcher)
- **Mục tiêu:** thay mock bằng đọc transcript thật qua cùng interface.
- **Giao phẩm:** `capture/transcript-watcher.ts` (polling tail-read, byte cursor, buffer dòng dở,
  quét cây `~/.claude/projects`, lọc theo `cwd`), `capture/line-parser.ts` (lọc human-turn).
- **Nghiệm thu:** chạy một transcript Claude Code thật → tạo ra event/task; đọc lại file không
  sinh trùng (idempotent theo `(sessionId,promptId,lineUuid)`).

### Phase 5 — Gom nhóm theo mục tiêu (heuristic + AI judge)
- **Mục tiêu:** nhiều lượt cùng mục tiêu → một task (yêu cầu #2).
- **Giao phẩm:** `brain/grouping.ts` (thuật toán mục 6), tích hợp AI judge ở vùng nhập nhằng,
  lệnh merge/split append `correction`.
- **Nghiệm thu:** prompt lặp lại cùng task → update tại chỗ, không tạo task mới; merge/split
  hoạt động và sống sót qua tính lại projection.

### Phase 6 — Phân cấp Epic → Task → Subtask (AI tự phân loại) *(yêu cầu #4)*
- **Mục tiêu:** dựng cây 3 tầng giống Jira, sinh từ chat.
- **Giao phẩm:** `brain/classifier.ts` (gán Task→Epic, tạo Epic mới, đặt tên; parser
  `TodoWrite`/kế hoạch của agent → Subtask; AI chẻ Subtask); mở rộng `types.ts` (Epic/Subtask),
  `store/projection.ts` (dựng quan hệ cha-con + rollup tiến độ Epic); nâng cấp tree thành
  Epic→Task→Subtask + chế độ nhóm `epic|day` + nút `toggleGrouping`; các lệnh phân cấp
  (`moveToEpic`/`createEpic`/`renameEpic`/`promoteToEpic`/`addSubtask`/`toggleSubtask`…);
  settings `taskMind.hierarchy.*` + `taskMind.tree.groupBy`.
- **Nghiệm thu:** các task cùng chủ đề tự gom dưới 1 Epic do AI đặt tên; Subtask lấy được từ
  todo của agent; tick Subtask cập nhật rollup của Task/Epic; kéo/đổi cấp (correction) sống
  sót qua tính lại projection; tắt AI → vẫn về Epic "Khác" + sửa tay được.

### Phase 7 — Tóm tắt AI (provider chọn được)
- **Mục tiêu:** tự sinh tiêu đề + tóm tắt (cho cả Task và Epic), người dùng chọn engine.
- **Giao phẩm:** `brain/summarizer.ts` + `brain/providers/{vscode-lm,external-api,heuristic}.ts`;
  lệnh `setApiKey` (lưu `secrets`); setting `taskMind.ai.*`; debounce theo `needsResummarize`.
- **Nghiệm thu:** với Copilot → tóm tắt tiếng Việt; với API key → tóm tắt qua key; không có gì →
  heuristic vẫn ra tiêu đề/tóm tắt; đổi provider trong settings có hiệu lực.

### Phase 8 — Báo cáo ngày + xuất + lịch
- **Mục tiêu:** báo cáo theo ngày (gom theo Epic) + xuất Markdown + tự chạy theo giờ.
- **Giao phẩm:** `report/report-builder.ts` (DailyReport → Markdown, nhóm theo Epic),
  `report/report-view.ts` (webview, CSP chuẩn), lệnh `generateReport`/`openReport`/`exportReportMarkdown`,
  `scheduler.ts` bắn vào `report.time` (giờ địa phương).
- **Nghiệm thu:** báo cáo hiện task/KPI hôm nay theo Epic; xuất Markdown ra file; scheduler bắn
  đúng giờ khi `report.autoGenerate` bật.

### Phase 9 — Hoàn thiện & đóng gói VSIX
- **Mục tiêu:** ra bản cài được.
- **Giao phẩm:** rà soát i18n tiếng Việt, `media/icon.svg` theo theme, README/CHANGELOG/LICENSE,
  script `package`/`publish:vsce`/`publish:ovsx` + `scripts/cleanup-vsix.js`, `files` allowlist.
- **Nghiệm thu:** `vsce package` ra VSIX cài được; mọi lệnh hiện trong palette; smoke-test xanh.

---

## 13. Verification (kiểm thử đầu-cuối)

- **Chạy/debug:** mirror `launch.json` `Run Extension` (`type:extensionHost`,
  `--extensionDevelopmentPath=${workspaceFolder}`, `outFiles:out/**/*.js`,
  `preLaunchTask:${defaultBuildTask}`) + `tasks.json` `tsc -watch`. Bấm **F5**.
- **Thang quan sát dưới F5:** icon sidebar hiện → tree hiện Hôm nay/Hôm qua → tick checkbox lưu
  qua reload.
- **Smoke test:** `npm test` = `tsc` + `node scripts/smoke-test.js` (mock `vscode` qua
  `Module._load`); assert mọi lệnh `taskMind.*` đã đăng ký + `createTreeView` được gọi với
  `taskMind.tasksView`.
- **Transcript thật:** trỏ watcher vào một `.jsonl` Claude Code thật, quan sát tạo-rồi-update
  task trong tree, xác nhận không trùng khi hỏi lặp lại; bật/tắt provider AI để kiểm thang
  hạ cấp.
- **Phân cấp:** kiểm các task cùng chủ đề tự gom dưới 1 Epic (AI đặt tên); Subtask hiện ra từ
  `TodoWrite` của agent; đổi `groupBy` epic↔day; kéo task sang Epic khác / nâng-hạ cấp và xác
  nhận sống sót sau reload (vì là `correction` trên event log).

---

## 14. Rủi ro & giả định cần lưu ý

1. **Watcher cho path ngoài workspace trên Windows** — `FileSystemWatcher` không đáng tin → mặc
   định dùng **polling** (stat short-circuit nên rẻ). Native watcher chỉ thêm sau khi kiểm chứng.
2. **Phụ thuộc LM API** — `vscode.lm` cần Copilot + cấp quyền 1 lần; nếu không có thì AI judge &
   tóm tắt hạ cấp về heuristic (chất lượng giảm) hoặc dùng API key ngoài. Đã có fallback nên
   không chặn luồng.
3. **Denylist tiền tố IDE/synthetic dễ lỗi thời** — schema Claude Code có thể đổi (có trường
   `version`). Để denylist tập trung, dễ mở rộng; log tiền tố lạ để rà soát thay vì tin mù.
4. **Định nghĩa "một task"** đã chốt theo mục tiêu/ngữ nghĩa — toàn bộ tầng gom nhóm phụ thuộc
   định nghĩa này; merge/split là van an toàn khi gom sai.
5. **Phân loại Epic dễ sai/nhiễu** — AI có thể tạo Epic trùng nghĩa hoặc gán nhầm. Giảm thiểu:
   chỉ so khớp trong cùng dự án, có ngưỡng tin cậy, gộp Epic gần nghĩa, luôn có Epic "Khác" và
   cho sửa tay (move/rename/promote/demote) — mọi sửa là `correction` nên tính lại an toàn.
6. **`TodoWrite` của agent không phải lúc nào cũng có** — nếu phiên không tạo todo thì Subtask
   chỉ đến từ AI (hoặc rỗng nếu `subtaskSource=off`); không chặn luồng.

---

## 15. Tóm tắt phụ thuộc giữa các phase

```
P0 ─► P1 ─► P2 ─► P3
            │
            ▼
       P4 ─► P5 ─► P6 ─► P7 ─► P8 ─► P9
```
- P2/P3 chạy được ngay với Mock (không cần brain thật).
- P4 thay Mock bằng watcher thật; P5 gom task; **P6 phân cấp Epic→Task→Subtask**; P7 tóm tắt;
  P8 báo cáo; P9 đóng gói. (P5–P7 là "bộ não".)

---

*Bước tiếp theo khi muốn triển khai: bắt đầu từ Phase 0.*
