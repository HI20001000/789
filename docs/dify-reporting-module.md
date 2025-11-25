# Dify 驅動的代碼審查報告模塊設計

## 快速開始：設定 Dify 連線資訊

在啟用 Dify 報告功能前，請於專案根目錄建立或更新 `.env` 檔案，並新增以下環境變數：

```
DIFY_API_BASE_URL=https://your-dify-host/v1
DIFY_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx
DIFY_CHAT_ENDPOINT=/chat-messages
DIFY_RESPONSE_MODE=blocking
DIFY_TOKEN_LIMIT=32000
```

* `DIFY_API_BASE_URL`：Dify 服務的 API 位址，通常以 `/v1` 結尾。
* `DIFY_API_KEY`：在 Dify 後台建立的 API Token，用於驗證請求。
* `DIFY_CHAT_ENDPOINT`：要呼叫的工作流端點，預設為 `/chat-messages`。
* `DIFY_RESPONSE_MODE`：Dify 回傳模式，可設定為 `blocking`（預設）或 `streaming`。
* `DIFY_TOKEN_LIMIT`：模型可處理的 Token 上限，預設 32000，可依實際方案調整。

### 設定 Dify 主機、Port 與路徑的範例

`DIFY_API_BASE_URL` 應填入完整的協定、主機名稱（或 IP）、Port 以及 API 前綴路徑。例如自架 Dify 服務並透過 5001 Port 提供 `/v1` API，可在 `.env` 中寫成：

```ini
DIFY_API_BASE_URL=http://10.0.10.38:5001/v1
```

如果您的 Workflow 不是使用預設的 `/chat-messages` 路徑，請同步調整 `DIFY_CHAT_ENDPOINT`，例如：

```ini
DIFY_CHAT_ENDPOINT=/workflow/run
```

修改後重新啟動後端伺服器或執行 `npm run server`，即可使新的路徑與 Port 設定生效。伺服器啟動時會在日誌輸出 `[env]` 及 `[dify]` 前綴的訊息，顯示使用的 `.env` 來源、目前採用的 `baseUrl`、端點、response mode 與是否偵測到 API Key，方便確認設定是否正確。

從這個版本起，後端會把每次生成的審查結果寫入 MySQL `reports` 表（參考 `server/sql/schema.sql`）。為了相容於使用 `utf8mb4` 編碼、索引長度限制為 3072 bytes 的部署環境，表結構採用 `project_id + path_hash` 作為唯一鍵，並將實際儲存的 `path` 長度限制在 512 個字元。當再次請求相同檔案時，新的結果會覆寫同一筆紀錄，方便後續擴充歷史查詢或導出功能。

後端服務與 `npm run db:init` 等指令會透過 `server/lib/env.js` 自動載入 `.env`，並在成功讀取時顯示 `[env] Loaded environment variables from ...`。重新啟動伺服器後，可從啟動日誌中的 `[env]`、`[dify]` 訊息確認設定是否生效。

## SQL 靜態分析器

當請求的檔案副檔名為 `.sql` 時，後端會改用專屬的靜態規則引擎（`server/lib/sql_rule_engine.py`）產生報告，不會呼叫 Dify。伺服器會將檔案內容透過標準輸入傳給該 Python 腳本，然後直接使用回傳的 JSON 結果填入報告。

預設會依序嘗試以下命令尋找 Python 直譯器：

1. `.env` 或系統環境中的 `SQL_ANALYZER_PYTHON`、`PYTHON_PATH`、`PYTHON`
2. `python3`
3. `python`
4. `py -3`
5. `py`

若伺服器日誌仍出現 `Python was not found` 相關訊息，可在 `.env` 明確指定直譯器路徑，例如：

```ini
SQL_ANALYZER_PYTHON=C:\\Python312\\python.exe
```

重新啟動 `npm run server` 後，啟動日誌會在第一次執行 SQL 分析時輸出 `[sql]` 前綴的訊息。若 Python 找不到或腳本回傳錯誤，API 會以 502 回應並將實際錯誤訊息包含在 body 中，方便排查。

## 區塊審查（Snippet Review）

除了整個檔案的報告外，工作區左側工具欄新增了「區塊審查」圖示，可在同一個兩欄版面中保留檔案樹，並於主視窗選取特定行段後一鍵送交 Dify。瀏覽器會監聽文字預覽區的選取範圍，自動記錄起迄行數與行數統計，並於成功回傳後在右側面板顯示最新的片段報告與分段輸出。

前端透過 `POST /api/reports/dify/snippet` 呼叫後端，payload 需包含：

```json
{
  "projectId": "demo",
  "path": "src/components/Button.vue",
  "selection": {
    "startLine": 12,
    "endLine": 42,
    "content": "...實際選取的程式碼..."
  }
}
```

後端會重新切段（沿用 `partitionContent` 邏輯）並將選取行範圍附加在送往 Dify 的 `inputs` 與提示語中；此請求僅回傳結果，不會寫入 MySQL `reports` 表，方便針對大型檔案進行局部分析或迭代嘗試。若選取內容為空或 `.env` 未設定完整的 Dify 參數，API 會回傳 400/502 錯誤供前端顯示提示。

## 目標

* 允許使用者針對當前項目或指定提交請求代碼審查報告。
* 通過調用 Dify Workflow 對代碼進行分析，返回審查建議與風險評估。
* 在現有工作區介面中提供報告的觸發、狀態反饋與結果展示。

## 系統結構

```
+-------------------+        +--------------------------+
| Vue Workspace UI  | ---->  | Reporting Service (FE)   |
+-------------------+        +--------------------------+
           |                              |
           v                              v
+-------------------+        +--------------------------+
| Backend API (新)   | ---->  | Dify Workflow Endpoint   |
+-------------------+        +--------------------------+
```

### 前端

* **報告觸發器 (ReportTrigger.vue)**
  * 放置於現有 top bar 或專案工具列。
  * 提供下拉選單選擇審查範圍（整個專案、指定檔案、Git diff）。
  * 可選擇報告類型（安全、性能、風格、自定義模板）。
* **報告狀態面板 (ReportPanel.vue)**
  * 顯示正在執行的工作流狀態、隊列位置、耗時。
  * 允許取消尚未完成的請求。
* **報告結果視圖 (ReportResult.vue)**
  * 模組化呈現 Dify 回傳的結構化數據：概要、問題列表、建議、置信度。
  * 支援將建議轉化為待辦事項或直接在 IDE 中定位。

### 狀態管理

* 建立 `useReportStore`（Pinia）管理請求、結果與錯誤。
* 透過 `useProjectStore`/`useChatStore` 的現有模式注入依賴。
* 報告請求結構：

```ts
interface ReportRequest {
  id: string;
  projectId: string;
  target: 'project' | 'files' | 'diff';
  payload: {
    files?: string[];
    diff?: string;
    branch?: string;
  };
  templateId: string;
  createdAt: number;
}
```

### 後端 API

* 新增 Node/Express 或現有後端服務的 `/api/reports` 路由。
* **POST /api/reports**：接收 `ReportRequest`，轉發給 Dify Workflow。
* **GET /api/reports/:id**：輪詢或 SSE 推送結果。
* **DELETE /api/reports/:id**：取消執行。
* 後端負責：
  * 封裝 Dify API Key，避免前端暴露。
  * 對 Dify Workflow 請求/回應進行驗證與格式化。
  * 管理超時、重試及錯誤映射。

### 與 Dify 的整合

* 選擇使用 Dify Workflow v2 HTTP API。
* 發送 payload：

```json
{
  "inputs": {
    "project_name": "...",
    "code_context": "...", // 打包的檔案或 diff
    "report_type": "security",
    "metadata": { "user": "...", "branch": "..." }
  },
  "response_mode": "stream"
}
```

* 使用 Webhook 或輪詢 `workflow_runs/{id}` 取得狀態。
* 將回傳資料整理為：

```ts
interface ReportResult {
  id: string;
  summary: string;
  issues: Array<{
    title: string;
    severity: 'low' | 'medium' | 'high';
    description: string;
    file?: string;
    line?: number;
    suggestion: string;
  }>;
  metrics: Record<string, number>;
  raw: unknown;
}
```

## UX 流程

1. 使用者在 top bar 點擊「生成報告」。
2. 彈出設定對話框選擇審查範圍與模板。
3. 前端呼叫 `/api/reports` 建立請求；`useReportStore` 紀錄狀態為 `pending`。
4. 後端呼叫 Dify Workflow，使用 SSE 將進度推送給前端。
5. 完成後 `ReportPanel` 自動顯示結果摘要，並可進一步展開詳情。
6. 使用者可將建議加入待辦、複製或導出為 Markdown/PDF。

## 報告文件生成與交付

為了讓審查結果能夠長期保存並易於分享，需要針對 Dify 回傳資料建立統一的文件輸出流程：

1. **格式選擇**：預設生成 Markdown 供前端直接渲染，同時提供 PDF、HTML 的導出選項。導出的模板建議放在 `docs/templates/report` 目錄，可由設計師與產品協作調整。
2. **後端匯出服務**：在 `/api/reports/:id/export` 加入 `format` 查詢參數，後端負責使用如 `markdown-pdf` 或 `Puppeteer` 轉檔，避免在瀏覽器端增加依賴。
3. **檔案快取與存儲**：
   * 對於一次性下載，回應 `Content-Disposition: attachment` 即可。
   * 若需要留存歷史記錄，可將生成的檔案上傳至 S3/OSS，並在報告紀錄中追加 `downloadUrl`、`expiresAt` 欄位。
4. **文件結構建議**：
   * 標題：包含專案、分支、提交資訊與產生時間。
   * 摘要：Dify 回傳的總體結論，必要時附上分數或等級。
   * 問題清單：按照嚴重性排序，帶檔案路徑與行號，並提供可複製的修正建議段落。
   * 指標：如複雜度、測試涵蓋率、潛在風險數量等統計資料。
   * 附錄：放置原始輸出、模型參數等細節。

### 報告生成進度體驗

* 在 `ReportPanel` 中加入 **步驟指示器**：上傳上下文 → 排程 → Dify 處理 → 文件渲染 → 完成。
* 支援背景生成：若使用者離開報告頁，`useReportStore` 仍維持輪詢/推播，並在完成時以通知提醒。
* 失敗時提供「重新嘗試」與「下載原始 JSON」按鈕，方便工程師調查。

### Dify Workflow 設計建議

* 在 Workflow 中拆分節點：
  * `ingest_context`：整理代碼片段與元數據。
  * `analysis_chain`：可插入多模型（靜態分析、風格檢查等）。
  * `report_writer`：產生結構化 JSON，並輸出 Markdown 文本欄位。
* 若需要支援多語系，在 `inputs` 中加入 `locale`，並於模板內置翻譯表或指定語系模型。
* 將 Workflow Run 的 `outputs` 轉換為 `ReportResult` 時，保留 `raw.markdown`、`raw.json` 欄位，供不同格式生成器使用。

## 權限與設定

## 權限與設定

* 在專案設定頁加入 Dify API Key 與 Workflow ID 的管理介面。
* 支援多 Workflow（不同審查模板），可在組織層級配置。
* 針對不同角色限制報告請求權限。

## 錯誤處理

* 顯示清晰的錯誤訊息（認證失敗、工作流異常、超時）。
* 提供重試機制與可操作建議。
* 在 Console 記錄完整錯誤以協助除錯。

## 後續擴展

* 導入自動化排程（每日/每次合併）生成報告。
* 與版本控制整合（Git Hooks）在 PR 建立時自動生成報告。
* 對報告內容引入 AI 輔助修復建議，一鍵應用補丁。

