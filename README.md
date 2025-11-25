# InfoAI 使用指南

## 專案概觀
整合式的 SQL 專案分析環境，結合前端工作空間與 Node.js API 伺服器，以及 MySQL 資料庫。使用者可以匯入資料夾、檢視檔案結構、生成 SQL 報告，並透過整合的 AI 助理對問題進行對話式分析。

## 系統需求
- Node.js 18 以上（僅在本機開發時需要）
- npm 9 以上
- Docker 與 Docker Compose（建議使用 Docker 啟動整個堆疊）
- 可存取的 MySQL 8.4 叢集（Docker 方案會自動啟用一個容器）

## 設定環境變數
專案採用 `.env` 檔案集中管理設定。：

```bash
nano .env
```

根據部署環境調整資料庫帳號密碼、後端監聽主機與連接埠等欄位。若之後將環境變數放到其他路徑，可透過 `ENV_FILE_PATH` 指定載入位置。

## 使用 Docker 啟動專案
以下流程說明如何在乾淨的環境中利用 Docker Compose 建立完整服務：

1. **建立 Docker Compose 設定檔**  
   在專案根目錄新增 `docker-compose.yml`，內容如下：

   ```yaml
   services:
     mysql:
       image: mysql:8.4
       restart: unless-stopped
       environment:
         MYSQL_ROOT_PASSWORD: P@ss28719862
         MYSQL_DATABASE: ai_platform
         MYSQL_USER: InfoMarco
         MYSQL_PASSWORD: P@ss28719862
       volumes:
         - mysql-data:/var/lib/mysql
       ports:
         - "3306:3306"
   
     api:
       image: node:20
       working_dir: /app
       env_file: ./InfoAI/.env
       environment:
         MYSQL_HOST: mysql        # 指向上面的 mysql 服務
         MYSQL_USER: infoai
         MYSQL_PASSWORD: infoai
         MYSQL_DATABASE: ai_platform
         HOST: 0.0.0.0
         PORT: 3001
       volumes:
         - ./InfoAI:/app
         - api-node-modules:/app/node_modules
       command: >
         sh -c "npm install && npm run server"
       ports:
         - "3001:3001"
       depends_on:
         - mysql
   
     web:
       image: node:20
       working_dir: /app
       env_file: ./InfoAI/.env
       environment:
         HOST: 0.0.0.0
         PORT: 5173
         VITE_DEV_SERVER_HOST: 0.0.0.0
         VITE_BACKEND_URL: http://api:3001
         CHOKIDAR_USEPOLLING: 1   # 讓 Vite 在容器內能偵測檔案變化
       volumes:
         - ./InfoAI:/app
         - web-node-modules:/app/node_modules
       command: >
         sh -c "npm install && npm run dev -- --host 0.0.0.0 --port 5173"
       ports:
         - "5173:5173"
       depends_on:
         - api
   
   volumes:
     mysql-data:
     api-node-modules:
     web-node-modules:

   ```

2. **啟動整個堆疊**  
   在 `docker-compose.yml` 所在目錄執行：

   ```bash
   啟動：docker compose up
   ```

   首次啟動會在容器內自動安裝前後端依賴套件。預設對外開放的服務為：
   - 前端（Vite 開發伺服器）：http://10.0.10.38:5173
   - API 伺服器：http://10.0.10.38:3001

3. **停止服務**  
   按下 `Ctrl+C` 或執行 `docker compose down` 即可停止並釋放資源。

## 本機開發（非 Docker）
若想直接在本機執行，請先安裝依賴並啟動前後端：

```bash
npm install
npm run server
npm run dev
```

API 預設監聽 `http://10.0.10.38/:3001`，Vite 開發伺服器則在 `http://10.0.10.38/:5173` 提供前端介面。

## 系統操作流程
1. **登入工作空間**  
   開啟瀏覽器造訪前端網址（預設為 http://10.0.10.38/:5173 或部署時設定的網域）。首頁會自動載入既有專案並顯示左側面板。

2. **匯入專案**  
   - 支援拖放資料夾或使用「匯入資料夾」按鈕。瀏覽器會要求檔案系統權限；若使用外部磁碟模式，請保持分頁開啟以維持授權。  
   - 成功匯入後，系統會將專案基本資訊與檔案樹節點同步到資料庫，日後重新載入即可快速回復狀態。

3. **瀏覽與預覽檔案**  
   - 左側 Panel Rail 提供「專案」與「報告」兩種工具。選取專案後即可展開檔案樹。  
   - 點擊檔案可在中央編輯區預覽內容，支援顯示行號與快速捲動。

4. **生成報告與問題檢視**  
   - 在報告面板中選擇目標檔案或資料夾，觸發「生成報告」後，後端會呼叫 Dify 與內建靜態分析規則產出結果。  
   - 報告會存回資料庫；即使無法再次取得檔案系統權限，系統仍可從資料庫載入先前保存的文本內容與報告摘要。

5. **AI 助理互動**  
   - 開啟右下角 AI 對話窗，可將目前選取的程式碼片段加入上下文，並提出問題。  
   - 助理會根據最新的報告、節點資訊以及儲存的檔案內容回應，協助你定位 SQL 風險與修正建議。

6. **維護與清理**  
   - 可在專案面板中刪除不需要的專案，系統會同步移除資料庫中的節點與報告。  
   - 若使用外部檔案模式並重新載入頁面，需要重新授權資料夾以便存取最新檔案。

## 進一步資訊
更多細節請參考 `docs/` 目錄下的補充文件，例如：
- `dify-reporting-module.md`：Dify 報告整合流程
- `sql-analyzer-rules.md`：靜態分析規則清單

若遇到問題，建議檢查瀏覽器主控台與 API 伺服器日誌，或開啟 `REPORT_DEBUG_LOGS=true` 以取得更完整的除錯資訊。
