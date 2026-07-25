# Architecture As-Is

> 日常開發優先順序請見 [`docs/roadmap.md`](roadmap.md)。本文件只描述目前可觀察到的實作與命令，不代表目標架構。

## 現有目錄與用途

| 路徑 | 實際用途 |
| --- | --- |
| `AGENTS.md` | Codex 唯一正式操作入口。 |
| `agnets.md` | 舊有、檔名疑似拼錯的操作說明；目前保留。 |
| `package.json` | 對外可用的 pnpm/npm 指令入口。 |
| `scripts/` | 目前所有可執行實作：lesson 匯入與三個 FFmpeg renderer。 |
| `src/` | 目前沒有可執行原始碼，尚未成為 runtime 主路徑。 |
| `schemas/` | `lesson.schema.json`；目前沒有被主要指令當作 blocking validation 使用。 |
| `lessons/` | 可 render 的 lesson JSON 與 examples。 |
| `courses/` | 課程來源 PDF；沒有自動產生 lesson 的程式連接。 |
| `prompts/` | 人工或外部 AI 產生內容時的提示材料；不在 package scripts 執行鏈中。 |
| `assets/` | 圖片、音效與 renderer 輸入資產。 |
| `output/` | renderer 影片與暫存輸出。 |
| `docs/` | Factory、renderer、架構、規格與任務說明。 |

## 實際執行流程

### 直接 render

1. `pnpm video:render <lesson-json>` 呼叫 `node scripts/render-english-prototype.mjs`。
2. renderer 讀取並 `JSON.parse` lesson；未給路徑時使用 `lessons/examples/en-junior-high.example.json`。
3. renderer 只做內建最低限度欄位檢查，並相容多種 segment/flow 形狀。
4. 程式解析圖片、語音與 production 設定，以 Edge TTS 或 Windows SAPI 產生語音。
5. FFmpeg/ffprobe 產生並串接片段，輸出 `output/<lesson_id>.mp4`。

`pnpm video:prototype` 是固定以英文 example 呼叫上述路徑的 convenience command。

### 匯入後 render

1. `pnpm lesson:import` 啟動 `scripts/lesson-import.mjs`。
2. importer 從使用者 Downloads 尋找 JSON 與 PNG，配置下一個 `en-junior-high-NNN` id。
3. importer 正規化部分欄位、改寫 id/輸出與資產路徑，做程式內建檢查。
4. 寫入 `lessons/en-junior-high/` 與 `assets/images/<lesson_id>/`。
5. importer 直接啟動 `scripts/render-english-prototype.mjs`。

## lesson 從哪裡產生

- 儲存庫沒有正式 lesson generator。
- `lessons/examples/` 是手工維護的範例；`lessons/en-junior-high/` 是既有 lesson。
- `lesson:import` 只把外部準備好的 JSON/PNG 匯入並重新編號，不生成教學內容。
- `courses/` 的 PDF 與 `prompts/` 可作人工或外部生成來源，但目前沒有 package command 將它們轉為 lesson JSON。
- 外部 JSON/圖片實際如何生成：**待確認**。

## schema、validator、renderer 的關係

- `schemas/lesson.schema.json` 是宣告式規格候選，沒有 package script 執行它。
- importer 的 `validate()` 是手寫 validator，只檢查匯入所需的部分條件。
- 三個 renderer 各自以 `requireLessonFields()` 與 defaults 接受資料。
- renderer 實際相容 `content.segments`、`segments`、`content_segments`，以及 `shadowing.sequence` 或 `learning_flow` 等形狀，runtime contract 因而比 schema 更寬。
- 現況不存在「schema 通過才可 render」的 blocking gate。
- v0.2 完成前，schema、lesson 與 renderer 仍可能不一致。

## `scripts/` 與 `src/` 是否重複

目前不重複：`scripts/` 是實際 runtime，`src/` 沒有可執行檔案。目標架構希望 `src/` 成為正式實作、`scripts/` 成為 CLI/相容層，但那不是現況。

`scripts/` 內部有高度重複：

- `render-english-prototype.mjs`：`package.json` 的正式 `video:render` 入口。
- `render-english-v1.1.mjs`：加入 production/overlay 設定，未被 package 指令指向。
- `render-english-v2.mjs`：另一演進版本，未被 package 指令指向。

後兩者目前只能視為候選／實驗分支；是否取代或淘汰：**待確認**。

## `prompts/`、`courses/`、`lessons/` 的角色

- `prompts/`：內容生成指示與模板，runtime 不自動載入。
- `courses/`：原始教材來源，runtime 不自動解析。
- `lessons/`：renderer 的直接結構化輸入，也是 importer 寫入目的地。

三者目前靠人工或外部流程銜接，沒有 repository 內的 end-to-end generator。

## `AGENTS.md` 與 `agnets.md`

`AGENTS.md` 是正式 Codex 操作入口，要求先讀 factory 與 roadmap。`agnets.md` 是舊文件，暫時保留，不得未授權刪除或改名。

## `package.json` 主要指令

| 指令 | 實際命令 | 現況 |
| --- | --- | --- |
| `pnpm lesson:import` | `node scripts/lesson-import.mjs` | 匯入 Downloads 的 lesson/PNG，再呼叫 prototype renderer。 |
| `pnpm video:render [lesson]` | `node scripts/render-english-prototype.mjs` | 正式 render 入口。 |
| `pnpm video:prototype` | `pnpm video:render lessons/examples/en-junior-high.example.json` | 固定範例 smoke/prototype。 |

沒有 generator、獨立 schema validator、publisher、test、lint 或 build 指令。

## 現行主路徑

1. `AGENTS.md` → `docs/factory.md` → `docs/roadmap.md`：操作與優先順序。
2. 外部 lesson/PNG → `lesson:import` → `lessons/`、`assets/` → prototype renderer。
3. 既有 lesson → `video:render` → `render-english-prototype.mjs` → `output/`。

## 舊版、實驗版或待淘汰候選

- v1.1/v2 renderer：未接 package 指令，屬候選／實驗版；是否淘汰待確認。
- `agnets.md`：舊入口候選，先保留。
- `segments`、`content_segments`、`learning_flow` 等 aliases：疑似歷史相容，淘汰時機待確認。
- `src/` 不是舊版，而是尚未落地的目標位置。
- schema 未接 runtime，不代表已廢棄。

## 現況結論

專案目前是「以 scripts 為核心、lesson 與資產先備妥、由 prototype renderer 直接輸出影片」的 v0.1 operational factory。主要架構缺口是 lesson contract 尚未在 schema、validator、renderer 與既有資料間對齊；這也是 roadmap v0.2 的唯一開發焦點。
