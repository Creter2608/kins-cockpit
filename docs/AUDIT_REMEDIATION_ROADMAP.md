# 🛡️ AUDIT HEALTH CHECK & 3-STAGE REMEDIATION ROADMAP
**Product**: Kin's Multi-Agents UI (`Creter2608/kins-cockpit`)  
**Audited By**: ECC Multi-Agent Panel (`code-architect`, `security-reviewer`, `silent-failure-hunter`, `react-reviewer`)  
**Date**: October 10, 2026  
**Standard**: Enterprise-Grade AI-Ready Standard (v3.0) & Karpathy Behavioral Invariants  

---

## 1. Executive Summary & Diagnostic Scorecard

Cuộc "khám tổng quát" chuyên sâu do 4 chuyên gia ECC Agents độc lập thực hiện trên toàn bộ codebase đã phát hiện nhiều điểm mạnh về phân tách Preload isolation, nhưng đồng thời bộc lộ **4 nhóm bệnh lý nghiêm trọng** đe dọa sự ổn định, an ninh và trải nghiệm của ứng dụng desktop:

```
┌──────────────────────────────────────┬─────────────┬────────────────────────────────────────────────────────┐
│ Chuyên khoa kiểm toán                │ Điểm số     │ Hiện trạng tóm tắt                                     │
├──────────────────────────────────────┼─────────────┼────────────────────────────────────────────────────────┤
│ 1. Kiến trúc Hệ thống (Architect)    │ B-          │ "Nhạc trưởng bóng ma", rò rỉ Subagent lên Main UI,     │
│                                      │             │ State machine phân đôi, gọi git đồng bộ trên main.    │
│ 2. An ninh & Đặc quyền (Security)    │ HIGH RISK   │ Nguy cơ RCE từ will-navigate + PTY write, CSP lỏng,   │
│                                      │             │ untrusted runner script execution trên máy host.      │
│ 3. Độ tin cậy & Bắt lỗi (Reliability)│ D+          │ Quả bom crash fs.watch, nuốt lỗi rollback, đọc state   │
│                                      │             │ bị lỗi tự xóa trắng state.json trên đĩa.               │
│ 4. Hiệu năng & UI (Performance)      │ B- (78/100) │ Nghẽn PTY do ghi đồng bộ, lag search 500 events,      │
│                                      │             │ vỡ hợp đồng React.memo, nguy cơ rò rỉ xterm instance.  │
└──────────────────────────────────────┴─────────────┴────────────────────────────────────────────────────────┘
```

---

## 2. Giải phẫu Bệnh lý Cốt lõi (Root-Cause Analysis)

### 🚨 Vấn đề 1: Rò rỉ Trạng thái Subagent lên Main Cockpit (State & Telemetry Contamination)
- **Vị trí**: `src/main/services/TranscriptIngestionService.ts` & `src/main/services/transcriptParsers.ts`
- **Nguyên nhân**:
  1. `findActiveTranscriptPath()` quét `.gemini/antigravity-cli/brain/` và chọn file `transcript.jsonl` có `mtime` mới nhất. Khi Subagent chạy ngầm đọc file và execute command liên tục, file log của Subagent có `mtime` mới hơn Main Agent. Service bị "cướp phiên" và ingest transcript của Subagent như thể đó là Main Agent.
  2. `detectPhaseWithEvidenceFromTranscriptStep()` tự động dò phase dựa trên tool calls. Khi Subagent chạy test hoặc đọc file, hàm này kích hoạt `loopService.advanceToPhase()`, làm thanh `PhaseTracker` của Main Agent nhảy loạn xạ.
  3. Token completion của Subagent bị cộng dồn thẳng vào `totalGeminiCompletion`, làm cạn kiệt ngân sách ($0.50 / 60k tokens) của Main Loop.

### 🚨 Vấn đề 2: Lỗi Hiển thị Queue Subagent & Mất Prompt Details
- **Vị trí**: `src/main/services/TranscriptIngestionService.ts:907-940`
- **Nguyên nhân**:
  1. Khi Main Agent gọi `invoke_subagent` với prompt dài (như 4 con ECC agents vừa rồi), CLI ghi log bị cắt cụt (`truncated_fields: ["tool_calls"]`). File `transcript.jsonl` bị mất đuôi, chỉ có trong `transcript_full.jsonl`.
  2. Đoạn Regex fallback khi `JSON.parse` thất bại chỉ trích xuất `Role` và `Model`, hoàn toàn **bỏ quên trường `Prompt`**. Do đó `prompt` bị `undefined`, UI không thể hiển thị nội dung task của Subagent.
  3. Regex bị cắt giữa chừng chỉ nhặt được 2 object đầu tiên thay vì toàn bộ danh sách 4 subagents.
  4. `handleSubagentOutput()` bắt chuỗi `finished with result` từ timer của hệ thống hoặc tác vụ nền khác và đánh dấu `completed` cho Subagent trước cả khi Subagent hoàn tất báo cáo.

### 🚨 Vấn đề 3: Lỗ hổng RCE qua `will-navigate` và Lệnh PTY Không Kiểm Soát
- **Vị trí**: `src/main/index.ts:119-128` & `src/main/ipc.ts`
- **Nguyên nhân**: Event `will-navigate` cho phép mọi URL bắt đầu bằng `file://`. Kéo thả file HTML lạ sẽ làm Electron tải trang kèm theo `window.cockpitApi`. Trang này có thể gọi `window.cockpitApi.terminal.write("powershell ...")` thực thi mã tùy ý trên máy Host.

### 🚨 Vấn đề 4: "Quả bom" Crash Tiến trình Electron từ `fs.watch`
- **Vị trí**: `src/main/services/LoopStateService.ts:1134` & `CriticalLogService.ts:248`
- **Nguyên nhân**: Khởi tạo `fs.watch` mà không gắn `.on('error', ...)`. Khi thư mục bị đổi tên, xóa bởi Git worktree hoặc bị Windows lock, Node.js ném unhandled EventEmitter error làm tắt phụt toàn bộ ứng dụng desktop.

---

## 3. Lộ trình Khắc phục 3 Giai đoạn (3-Stage Remediation Roadmap)

Để đảm bảo tuân thủ nguyên tắc **Karpathy Invariants (Surgical Changes, Simplicity First)** và bảo vệ hạn mức ngữ cảnh của **GPT Architect (3,000 - 5,000 tokens/lần)**, toàn bộ khối lượng sửa đổi được phân rã thành **3 Giai đoạn độc lập**:

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             3-STAGE REMEDIATION ROADMAP                          │
├──────────────────────────────────────────────────────────────────────────────────┤
│ GIAI ĐOẠN 1 (P0): Core Subagent Isolation & Queue Restoration                    │
│   → Trọng tâm: Sửa triệt để Ingestion Service, cách ly Subagent, sửa Queue UI.  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ GIAI ĐOẠN 2 (P0/P1): Electron Security Lockdown & State Reliability              │
│   → Trọng tâm: Chặn đứng RCE, CSP, bảo vệ state.json, bắt lỗi fs.watch.         │
├──────────────────────────────────────────────────────────────────────────────────┤
│ GIAI ĐOẠN 3 (P1/P2): Terminal PTY Batching & React 19 Frontend Performance       │
│   → Trọng tâm: RAF buffer terminal, useDeferredValue search, Error Boundary.     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 🔹 GIAI ĐOẠN 1: Core Subagent Isolation, Ingestion Decoupling & Queue Restoration (P0)

> **Mục tiêu**: Đảm bảo Giao diện chính (PhaseTracker & TelemetryHUD) **CHỈ ĐẠI DIỆN** cho Main Agent. Khôi phục hiển thị đầy đủ tên, prompt chi tiết và chu trình sống chính xác của Subagents trong Queue.

#### 1. Phạm vi Files tác động:
- `src/main/services/TranscriptIngestionService.ts`
- `src/main/services/SubagentService.ts`
- `src/main/services/transcriptParsers.ts`

#### 2. Danh mục Hạng mục Sửa đổi:
1. **Khóa cứng Transcript Session cho Main Agent**:
   - `TranscriptIngestionService` phải nhận `mainConversationId` hoặc khóa đường dẫn transcript của Main Agent khi khởi tạo.
   - Loại bỏ cơ chế "đoán mò" bằng `mtime` trong `findActiveTranscriptPath()`. Không bao giờ chuyển target file sang các thư mục con của Subagents (`.gemini/antigravity-cli/brain/<subagent-id>/`).
2. **Khôi phục Bóc tách Subagent Toàn vẹn (Anti-Truncation)**:
   - Khi phát hiện `truncated_fields` có chứa `tool_calls` hoặc khi JSON bị cắt dở, Ingestion Service phải đọc dòng tương ứng trong file `transcript_full.jsonl` (nếu tồn tại) hoặc áp dụng regex parser hỗ trợ đa trường (`Role`, `TypeName`, `Model`, `Prompt`, `Task`).
   - Đảm bảo bóc tách chính xác toàn bộ danh sách Subagents trong mảng `Subagents: [...]`, không làm rơi rụng các subagents phía sau.
3. **Tuyệt đối Cách ly Subagent khỏi Main Loop**:
   - Trong `detectPhaseWithEvidenceFromTranscriptStep()`: Bổ sung kiểm tra ngữ cảnh nguồn gốc. Nếu step thuộc về Subagent hoặc là kết quả tool của subagent, **tuyệt đối không gọi** `loopService.advanceToPhase()`.
   - Token sinh ra bởi Subagent không được cộng dồn vào `totalGeminiCompletion` của Main Agent. Token subagent phải được ghi nhận độc lập vào `SubagentService` (nếu cần theo dõi trên từng card subagent).
4. **Sửa Chu trình Sống (Lifecycle) Tránh Hoàn thành Non**:
   - Trong `handleSubagentOutput()`: Chỉ đánh dấu `completed` khi `sender` khớp chính xác với `conversationId` của subagent và nội dung là thông điệp kết thúc thực sự của subagent đó, không bắt nhầm các log hệ thống chung chung (`task-xx finished with result`).

#### 3. Tiêu chí Nghiệm thu (Acceptance Criteria):
- [ ] Chạy lệnh gọi 4 subagents (như 4 ECC agents), trên giao diện `SubagentSidebar` hiển thị chính xác **đủ 4 thẻ subagent**.
- [ ] Tên vai trò (Role) và nội dung nhiệm vụ (Prompt Details) hiển thị rõ ràng, không bị `undefined`.
- [ ] Thanh `PhaseTracker` và `TelemetryHud` trên màn hình chính giữ nguyên trạng thái của Main Agent, không bị giật phase hay tăng vọt token.
- [ ] Thẻ subagent chỉ chuyển sang `completed` khi subagent thực sự trả kết quả.

---

### 🔹 GIAI ĐOẠN 2: Electron Security Lockdown, Process Stability & State Reliability (P0/P1)

> **Mục tiêu**: Triệt tiêu nguy cơ chiếm quyền thực thi mã tùy ý (RCE), ngăn chặn crash ứng dụng đột tử từ `fs.watch`, bảo toàn tính toàn vẹn của file trạng thái `state.json`.

#### 1. Phạm vi Files tác động:
- `src/main/index.ts`
- `src/renderer/index.html`
- `src/main/ipc.ts`
- `src/main/services/LoopStateService.ts`
- `src/main/services/CriticalLogService.ts`
- `src/main/services/EvalHarnessService.ts`

#### 2. Danh mục Hạng mục Sửa đổi:
1. **Khóa Chặt Điều hướng Electron (`will-navigate`)**:
   - Trong `src/main/index.ts`: Chỉ cho phép điều hướng tới đúng URL `index.html` nội bộ của ứng dụng (trong production) hoặc `VITE_DEV_SERVER_URL` (trong development).
   - Chặn đứng mọi URL `file://` lạ; chặn `will-frame-navigate`; từ chối mở cửa sổ mới (`setWindowOpenHandler` deny all).
2. **Siết chặt Content-Security-Policy (CSP)**:
   - Trong `src/renderer/index.html` và thông qua `session.defaultSession.webRequest.onHeadersReceived`: Loại bỏ `'unsafe-inline'` trong `script-src`.
3. **Tháo ngòi "Quả bom Crash" `fs.watch`**:
   - Trong `LoopStateService.ts` và `CriticalLogService.ts`: Bắt buộc gắn `.on("error", (err) => { ... })` cho mọi instance `fs.watch`. Khi gặp lỗi, đóng watcher an toàn và fallback êm về cơ chế interval polling.
4. **Chống Xóa Trắng `state.json` (Destructive Fallback Prevention)**:
   - Trong `LoopStateService.ts`: Nếu file `state.json` tồn tại nhưng `readFileSync` hoặc `JSON.parse` thất bại (do Windows file lock tạm thời), **hủy ngay thao tác ghi đè**, giữ nguyên snapshot trong bộ nhớ và ghi log cảnh báo; tuyệt đối không gán `{}` rồi commit xuống đĩa.
5. **Minh bạch Hóa Lỗi Rollback trong IPC**:
   - Trong `src/main/ipc.ts`: Khi `services.rollback.executeRollback()` thất bại, trả về đúng lỗi để UI thông báo cho người dùng; không âm thầm gọi `services.loop.stepBack()` tạo cảm giác rollback thành công giả tạo.
6. **Bảo vệ Đường dẫn Chạy Benchmark Runner**:
   - Trong `EvalHarnessService.ts`: Cấm thực thi trực tiếp file `runner.mjs` từ workspace ngoài trên máy Host; chỉ sử dụng runner chuẩn từ ứng dụng hoặc thực thi an toàn trong Docker container.

#### 3. Tiêu chí Nghiệm thu (Acceptance Criteria):
- [ ] Thử kéo thả file HTML bên ngoài vào ứng dụng: Electron từ chối tải trang, không rò rỉ `cockpitApi`.
- [ ] Xóa hoặc đổi tên thư mục `.ai` khi app đang chạy: App không bị crash, watcher tự động đóng và chuyển sang polling.
- [ ] Giả lập lỗi đọc `state.json`: File trên đĩa không bị biến thành `{}` rỗng.
- [ ] Lệnh rollback khi gặp lỗi Git sẽ báo lỗi rõ ràng trên UI thay vì âm thầm lùi số phase ảo.

---

### 🔹 GIAI ĐOẠN 3: Terminal PTY Batching & React 19 Frontend Performance (P1/P2)

> **Mục tiêu**: Tối ưu hóa hiệu năng render 60 FPS cho Terminal PTY khi nhận lượng dữ liệu lớn, xóa bỏ hiện tượng đơ lag khi tìm kiếm hoạt động và bọc Error Boundary toàn ứng dụng.

#### 1. Phạm vi Files tác động:
- `src/renderer/components/TerminalStage.tsx`
- `src/renderer/components/RunActivityPanel.tsx`
- `src/renderer/components/SubagentSidebar.tsx`
- `src/renderer/App.tsx`
- `src/renderer/main.tsx`

#### 2. Danh mục Hạng mục Sửa đổi:
1. **Đệm Dữ liệu Terminal qua `requestAnimationFrame`**:
   - Trong `TerminalStage.tsx`: Tạo hàng đợi `bufferQueueRef`. Thay vì gọi `term.write(data)` tức thời mỗi khi có sự kiện IPC, gom các chunks dữ liệu và xả qua `requestAnimationFrame`.
   - Thay `window.addEventListener("resize")` bằng `ResizeObserver` gắn trực tiếp vào container của terminal; dọn dẹp và gán `terminalRef.current = null` khi unmount.
2. **Tìm kiếm Bất đồng bộ Không Nghẽn Luồng (`useDeferredValue`)**:
   - Trong `RunActivityPanel.tsx`: Áp dụng `useDeferredValue` cho ô nhập `searchQuery`.
   - Kiểm tra các trường chuỗi nông (`kind`, `source`, `stepId`) trước; chỉ gọi `safeStringify(data)` khi thực sự cần thiết, loại bỏ nguy cơ crash khi gặp dữ liệu circular/BigInt.
3. **Tối ưu Hóa Timer trong `SubagentSidebar.tsx`**:
   - Chỉ kích hoạt `setInterval` đếm giây khi có ít nhất 1 subagent đang ở trạng thái `running` hoặc `idle`. Dừng timer khi danh sách rỗng hoặc toàn bộ đã hoàn tất.
4. **Bảo toàn Hợp đồng `React.memo` trong `App.tsx`**:
   - Bọc tất cả các hàm callback (`handleRollback`, `handleStepForward`, `handleReset`, `handleRunBenchmark`) trong `useCallback`.
   - Chỉ render `RunActivityPanel` khi tab đang kích hoạt (`activeTab === "activity"`).
5. **Bọc `CockpitErrorBoundary` tại Gốc Ứng dụng**:
   - Trong `src/renderer/main.tsx`: Bọc `<App />` trong một Error Boundary tùy biến, hiển thị màn hình thông báo lỗi và nút Reload khi có sự cố render, loại bỏ hoàn toàn lỗi trắng xóa màn hình (WSOD).

#### 3. Tiêu chí Nghiệm thu (Acceptance Criteria):
- [ ] Chạy lệnh in log CLI liên tục (ví dụ build hoặc test): Terminal cuộn mượt mà, không giật chuột hay đơ giao diện.
- [ ] Gõ từ khóa tìm kiếm trong Activity Panel với 500 events: Ký tự hiển thị tức thì, không có độ trễ phím.
- [ ] Khi không có subagent chạy: CPU không bị đánh thức mỗi 1 giây.
- [ ] Nếu component con văng lỗi render: Xuất hiện màn hình cứu hộ Cockpit thay vì trắng màn hình.

---

## 4. Phương pháp Triển khai Từng Giai đoạn (Workflow Execution)

Mỗi Giai đoạn sẽ được triển khai theo quy trình **2-Tier Pipeline chuẩn của dự án**:
1. **Stage 2 (GPT Architect)**:
   - Cung cấp đúng **3,000 - 5,000 tokens** ngữ cảnh của các files trong giai đoạn đó cho công cụ `craft_technical_prompt_with_gpt`.
   - Nhận về Bản thiết kế kỹ thuật (Blueprint) và Bảng kiểm thử Golden Assertions gọn gàng.
2. **Layer 2 (Gemini / Antigravity Execution)**:
   - Chỉnh sửa code chuẩn xác theo nguyên tắc phẫu thuật (Surgical Changes).
   - Chạy typecheck và test cục bộ trên CPU ($0 token cost) với trần tối đa 1 lần thử lại (Hard cap = 1 retry).
3. **Stage 4 (GPT Reality Checker Audit)**:
   - Triệu hồi `audit_and_break_code_with_gpt` kiểm tra chéo thực tế trước khi hoàn thành giai đoạn.

---
*Tài liệu này được lưu trữ chính thức tại `docs/AUDIT_REMEDIATION_ROADMAP.md` làm kim chỉ nam thực thi cho dự án.*
