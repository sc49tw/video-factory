# Architecture Migration

> 本文件是完整遷移 backlog，不是目前 sprint 清單。實際執行順序與當前唯一優先事項請見 [`docs/roadmap.md`](roadmap.md)；未列入當期版本的項目不得因出現在此處而自動開工。

每項「可立即執行」只表示技術上可安全開始，不表示已獲授權或屬目前 roadmap 階段。

## M01 — 建立正式 Codex 入口

- **現況**：既有 `agnets.md` 檔名疑似拼錯，入口不清楚。
- **目標**：`AGENTS.md` 成為唯一正式操作入口。
- **衝突**：舊工具或使用者可能仍參照 `agnets.md`。
- **建議處理**：新增正式入口，保留舊檔並標示歷史角色。
- **風險**：兩份文件內容漂移。
- **是否可立即執行**：是；入口已建立，舊檔未刪除或改名。

## M02 — 統一文件入口與優先順序

- **現況**：factory、architecture 與任務文件都可能被誤讀成當前計畫。
- **目標**：factory 是文件入口，roadmap 是優先順序唯一來源。
- **衝突**：target/migration 涵蓋大量未排期內容。
- **建議處理**：加入定位與交叉連結。
- **風險**：若連結未維護，仍會出現多套優先順序。
- **是否可立即執行**：是；文件 alignment 可立即完成。

## M03 — 盤點 Stable Lesson Contract

- **現況**：schema、renderer、importer、examples 與 lessons 不完全一致。
- **目標**：確認唯一 canonical lesson contract。
- **衝突**：runtime 接受多種 segment 與 flow aliases，schema 可能較窄或不同。
- **建議處理**：以程式行為與 corpus 建立差異矩陣，逐欄決定 required、optional、default、deprecated。
- **風險**：過早收窄會讓既有 lesson 無法 render。
- **是否可立即執行**：是；這是 v0.2 當前唯一開發重點。

## M04 — 對齊 `lesson.schema.json`

- **現況**：schema 未被主要命令使用，也未完整代表 renderer 相容行為。
- **目標**：schema 成為 lesson 格式唯一真實來源。
- **衝突**：既有資料可能無法通過修訂後 schema。
- **建議處理**：先完成 M03，再同步 schema、examples 與說明並記錄 breaking changes。
- **風險**：過窄造成大量 migration；過寬則失去約束力。
- **是否可立即執行**：否；須先決定 contract，本次亦禁止修改 schema。

## M05 — 建立 non-blocking validator audit

- **現況**：只有 importer 與 renderer 的局部手寫檢查。
- **目標**：以同一 schema 與 semantic rules 檢查全部 lessons。
- **衝突**：目前沒有 validator module 或 package command。
- **建議處理**：先只報告、不阻擋 render，確認誤判後再談 enforcement。
- **風險**：錯誤規則會製造噪音或誤導修正。
- **是否可立即執行**：待確認；新增程式需另行授權。

## M06 — 遷移既有 lesson corpus

- **現況**：`lessons/` 存在不同結構與歷史相容欄位。
- **目標**：正式 lesson 全部通過 canonical validator 且保留相同內容。
- **衝突**：批次修改可能改變 render 或資產參照。
- **建議處理**：逐 lesson 產生 diff、備份與 render regression；先 examples 後正式 lessons。
- **風險**：內容遺失、路徑失效、輸出漂移。
- **是否可立即執行**：否；須完成 M03～M05 並獲授權修改 lessons。

## M07 — 接入 schema enforcement

- **現況**：render 不要求 schema validation 成功。
- **目標**：canonical lesson 在正式 renderer 前通過驗證。
- **衝突**：直接阻擋會破壞 operational flow。
- **建議處理**：audit → warning → opt-in blocking → 正式 blocking。
- **風險**：本機流程中斷，舊 lesson 無法使用。
- **是否可立即執行**：否；未經授權禁止 blocking schema enforcement。

## M08 — 定義 `src/` 模組邊界

- **現況**：`src/` 無正式實作，runtime 集中於 scripts。
- **目標**：domain、validation、media、render orchestration 有明確邊界。
- **衝突**：直接重構會同時改變可運作 renderer。
- **建議處理**：先做 dependency map 與介面設計，再以無行為變更方式抽取。
- **風險**：抽象過度、平台相依程式難分離。
- **是否可立即執行**：文件設計可；程式遷移需另行授權。

## M09 — 將 `scripts/` 收斂為 CLI／相容層

- **現況**：scripts 是完整實作，不只是 wrapper。
- **目標**：scripts 只解析參數並呼叫 `src/`。
- **衝突**：package commands 直接依賴 scripts 的行為與路徑。
- **建議處理**：保留檔名與 CLI contract，逐段將純邏輯移至 `src/`。
- **風險**：exit code、cwd、預設路徑或訊息變化。
- **是否可立即執行**：否；須在 M08 後並有回歸測試。

## M10 — 合併 renderer 重複

- **現況**：prototype、v1.1、v2 重複 TTS、FFmpeg 與 normalization 邏輯。
- **目標**：單一 renderer 核心，版本差異由設定或 feature module 表達。
- **衝突**：三版本的 production 行為與功能不同。
- **建議處理**：先建立 regression matrix，再抽共用服務，最後才決定版本命運。
- **風險**：影片時間、字幕、音訊與 overlay 產生隱性變化。
- **是否可立即執行**：否；禁止未授權 renderer 切換或重構。

## M11 — 建立 renderer regression 基準

- **現況**：沒有 test 指令或 golden output。
- **目標**：以固定 lessons 驗證輸出、media streams、時長及關鍵畫面／音訊。
- **衝突**：輸出受 OS、字型、TTS 與 FFmpeg 版本影響。
- **建議處理**：先定義穩定可比的 metadata，再補視覺抽樣。
- **風險**：binary golden files 體積大，測試可能 flaky。
- **是否可立即執行**：待確認；新增測試程式需另行授權。

## M12 — 正式化 generator

- **現況**：courses 與 prompts 不會由 repo 程式自動轉成 lesson。
- **目標**：generator 產生符合 canonical schema 的 draft。
- **衝突**：來源解析、模型、品質與授權邊界未定。
- **建議處理**：等 stable contract 後，先做可人工審核的單一路徑 prototype。
- **風險**：教材錯誤、不可重現、成本與版權問題。
- **是否可立即執行**：否；v0.3 之後，planned。

## M13 — 正式化資產與 TTS pipeline

- **現況**：renderer 直接解析圖片、呼叫 TTS、管理 temp files。
- **目標**：資產準備與 TTS 有獨立、可快取、可驗證介面。
- **衝突**：目前與 Windows/本機 FFmpeg 路徑耦合。
- **建議處理**：從不改變輸出的 service 抽取開始，定義 cache key 與恢復策略。
- **風險**：語音差異、cache stale、跨平台問題。
- **是否可立即執行**：否；planned，且需先有 regression。

## M14 — 建立 publisher

- **現況**：沒有 package command 或程式自動發佈影片。
- **目標**：以明確授權發佈已驗證的 media 與 metadata。
- **衝突**：憑證、重試、重複發布、隱私與平台政策未定。
- **建議處理**：先設計 dry-run 與人工 approval gate，再接平台 API。
- **風險**：誤發佈、重複內容、憑證外洩。
- **是否可立即執行**：否；planned，且需獨立授權。

## M15 — 分離規格、系列、風格與角色文件

- **現況**：docs 以 factory、renderer 與任務文件為主，目標分類未完全建立。
- **目標**：`docs/specs`、`docs/series`、`docs/styles`、`docs/characters` 只承載說明與規則。
- **衝突**：既有資訊散落，分類邊界可能重疊。
- **建議處理**：先建立索引與 ownership，按需要新增；不為整齊而搬動舊檔。
- **風險**：重複規則與文件漂移。
- **是否可立即執行**：部分可；任何搬移、刪除、改名均需授權。

## M16 — 淘汰舊入口、格式與版本

- **現況**：`agnets.md`、多 renderer 與多 lesson aliases 仍存在。
- **目標**：相容期後只保留正式入口、canonical contract 與正式 renderer。
- **衝突**：沒有證據證明哪些相容路徑可安全移除。
- **建議處理**：先 deprecated、蒐集使用證據、提供 migration guide，再逐項核准移除。
- **風險**：隱性使用者或舊 lesson 工作流中斷。
- **是否可立即執行**：否；不得未授權刪除、改名或切換 renderer。

## 建議遷移順序

1. v0.2：M03 → M04 → M05，並規劃 M06/M07；核心是 Stable Lesson Contract。
2. contract 穩定後：M06 → M07 → M11。
3. 有回歸保護後：M08 → M09 → M10 → M13。
4. 後續 planned：M12、M14、M15、M16。

M01、M02 是文件 alignment，可與 v0.2 同步維護，但不擴張 runtime 範圍。

## 不可提前執行

- 未授權搬移、刪除或改名檔案。
- 未授權修改或批次遷移 lessons/assets。
- 未授權切換 `video:render` 的 renderer。
- contract/corpus 未對齊前啟用 blocking schema enforcement。
- 把 target architecture 的 planned modules 當成目前 sprint。

## 最優先的 alignment 問題

1. **Lesson contract 不一致**：schema、renderer、importer 與 lessons 接受不同形狀。
2. **實作位置與目標責任相反**：runtime 全在 `scripts/`，`src/` 尚未承載正式實作。
3. **正式 renderer 與演進版本分離**：package 指向 prototype，v1.1/v2 未納入正式命令與回歸決策。
