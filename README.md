# SMTP Mail Sender

在本機瀏覽器撰寫與批次寄送郵件，支援多組 SMTP 設定、CSV 個人化欄位、HTML 範本、草稿、CC / BCC、寄送記錄，以及 OpenRouter AI 寫信助理。

## 啟動

需要 Node.js 22 以上（建議 Node.js 24 LTS）及 pnpm 11.24.0。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm start
```

開啟 <http://localhost:3000>。開發模式使用 `pnpm dev`。`.env` 由 Node.js 載入，修改連接埠後需重新啟動。

此工具只監聽 `127.0.0.1`，供單人本機使用。它沒有多人登入或權限系統，不應以反向代理直接公開至網際網路。若在遠端主機執行，可透過 SSH 將相同連接埠轉送至本機：

```sh
ssh -N -L 3000:127.0.0.1:3000 user@your-server
```

## 使用方式

1. 新增 SMTP 設定檔。使用服務商提供的應用程式密碼；587 使用 STARTTLS，465 勾選 SSL/TLS。支援的連接埠為 25、465、587、2525，全部要求加密及有效憑證。
2. 撰寫主旨與內容，或套用內建範本。複雜表格請維持 HTML 原始碼模式；切換至視覺編輯時 Quill 可能重新整理版型。
3. 匯入 CSV，第一欄名稱必須是 `email`（不分大小寫）。其他欄位可用 `{{name}}` 或 `{{姓名}}` 引用。欄位值以文字插入 HTML，不能透過 CSV 插入 HTML 標籤。
4. 預覽後寄送。CC / BCC 使用逗號分隔的純 Email 地址；不接受 `Name <email>` 格式。回覆地址只接受一個 Email。
5. AI 功能需自行提供 OpenRouter API Key；生成請求會將提示內容送到 OpenRouter 及所選模型供應商，可能產生 API 費用。

CSV 範例（勿提交真實收件人名單）：

```csv
email,name,company
person@example.com,範例姓名,Example Company
```

每批最多 500 封、CSV 最多 5 MB / 50 欄、API 請求最多 10 MB、單封 HTML 最多 256 Ki 字元，間隔為 0–30000 ms。每批最多執行 30 分鐘，AI 請求最多 2 分鐘；同時最多 3 個 API 請求，每分鐘最多 60 次。

中止會取消後續寄送；已進行中的一封仍可能被 SMTP 主機接受，已送出的信件無法撤回。網路中斷時，未回報的寄送結果可能不明，請先確認寄件備份或服務商紀錄，避免直接重送造成重複。

## 資料與安全

- SMTP 密碼與 OpenRouter 金鑰只保留在目前頁面記憶體，重新整理後必須重新輸入。載入時會移除舊版儲存在 `localStorage` 的密碼與金鑰。
- 設定檔的主機／帳號、草稿、寄送記錄與介面偏好仍儲存在該瀏覽器的 `localStorage`。草稿與記錄可能包含個資，使用共用電腦後請清除網站資料。
- 伺服器不寫入信件、憑證或收件人資料，也不回傳 SMTP / AI 供應商的原始錯誤內容。
- HTML 經 DOMPurify 清理；兩個預覽均使用無權限的 iframe 沙箱。HTTPS 圖片仍可能向圖片主機發出請求，寄信前請檢查內容中的外部圖片與連結。
- 前端套件由本機提供，版本及完整性鎖定於 `pnpm-lock.yaml`。
- 預設封鎖內網、loopback、metadata 與保留 SMTP IP。需要自管內網 SMTP 時，可在 `.env` 的 `SMTP_ALLOWED_HOSTS` 列出**完整且可信任**的主機名稱（逗號分隔），重啟後生效。這只放寬該主機的 IP 限制，仍會驗證 TLS 憑證。
- 內建 COSCUP 範本引用公開組織圖片；使用前請依你的用途調整內容，確認品牌素材使用權限。

## 驗證

```sh
pnpm check
pnpm test
pnpm audit
```

測試使用模擬 SMTP / AI 與 Nodemailer 記憶體郵件串流，不會寄出真實郵件。GitHub Actions 會執行語法檢查、測試、依賴稽核及完整 Git 歷史密鑰掃描；Dependabot 每週檢查套件與 Actions 更新。

目前 Quill 2.0.3 有一項未提供修補版的低風險公告。程式已清理匯入／顯示／寄送的 HTML 並隔離預覽；公告沒有被隱藏或忽略。CI 會阻擋中風險以上漏洞，完整 `pnpm audit` 仍會因這項低風險公告回傳非零狀態。詳見 [安全檢查報告](SECURITY-REVIEW.md) 與 [安全政策](SECURITY.md)。
