# Architecture Target

> 本文件描述長期目標架構，不代表近期要全部實作。實際開發階段與優先順序一律由 [`docs/roadmap.md`](roadmap.md) 決定；target architecture 不等於目前待辦清單。

## 目標與邊界

目標是建立可維護、可驗證、可逐步自動化的 lesson-to-video factory，同時保留目前可運作的 renderer。以下 planned modules 必須按 roadmap 分階段落地，不因列在本文件就視為已完成或已排入當期工作。

## 唯一權威來源

| 關注點 | 目標權威來源 |
| --- | --- |
| Codex 操作入口 | 根目錄 `AGENTS.md` |
| Factory 文件入口 | `docs/factory.md` |
| 開發階段與優先順序 | `docs/roadmap.md` |
| lesson 格式 | `schemas/lesson.schema.json` |
| 正式實作 | `src/` |
| 對外命令 | `package.json`，由薄型 `scripts/` CLI 呼叫正式實作 |
| lesson 實例 | `lessons/`，必須符合正式 schema |
| 規則與說明 | `docs/specs/`、`docs/series/`、`docs/styles/`、`docs/characters/` |

在 v0.2 完成前，`schemas/lesson.schema.json` 尚未實際成為 runtime 唯一來源；這是目標，不是現況宣稱。

## 目標模組

以下均為 planned architecture；是否與何時實作由 roadmap 決定。

### Generator（planned）

- 從課程來源、prompt 與系列規則產生 lesson draft。
- 只輸出正式 schema 允許的欄位。
- 生成後交給 validator，不直接 render。

### Validator（planned）

- 以 `schemas/lesson.schema.json` 驗證結構。
- 補充參照完整性與檔案存在性等 semantic checks。
- 提供可讀錯誤與非破壞性的 audit 模式。
- 在 v0.2 對齊且獲明確授權前，不啟用 blocking enforcement。

### TTS / Media preparation（planned module boundary）

- 將語音合成、音訊探測、暫存與資產解析從 renderer 編排中分離。
- 定義 deterministic inputs/outputs，讓 renderer 可測試。

### Renderer（既有能力，目標重整）

- 保留已證實可用的 prototype 路徑，先建立 regression evidence。
- 正式實作最終位於 `src/`；`scripts/` 只負責 CLI 與相容呼叫。
- renderer 只消費已驗證的 canonical lesson，不長期承擔多種舊格式正規化。
- renderer 切換必須另有授權，不由本文件自動觸發。

### Publisher（planned）

- 將已驗證影片與 metadata 發佈到目標平台。
- 發佈是明確、可審核的獨立步驟，不隱含在 render 中。
- YouTube automation 目前不是 operational capability。

## 目標資料流程

```text
courses + prompts + docs rules
              |
        generator (planned)
              |
        canonical lesson.json
              |
     schema + semantic validator
              |
      TTS/assets preparation
              |
           renderer
              |
       verified media output
              |
       publisher (planned)
```

手工 lesson 仍可直接進入 validator，不必依賴 generator。

## Schema 與相容策略

1. 盤點 renderer 真正讀取欄位、既有 lesson 與 importer 行為。
2. 在 v0.2 對齊 canonical contract、schema、examples 與 validator。
3. 以 non-blocking audit 找出舊 lesson 差異。
4. 完成 migration 與回歸驗證後，才考慮 blocking gate。
5. 舊欄位由明確 compatibility adapter 處理並設定棄用期限；renderer 核心不永久支援平行格式。

## `src/` 與 `scripts/` 的目標責任

### `src/`

- 正式 domain types、schema adapter、validator、generator、media services、renderer orchestration 與 publisher。
- 可被測試、組合及重用，不依賴 CLI global state。

### `scripts/`

- CLI 參數解析、錯誤碼與使用者訊息。
- 呼叫 `src/` 正式 API。
- 遷移期保留舊命令名稱與必要相容層。
- 不再複製大段 renderer/domain logic。

目前 scripts 是完整 runtime、src 為空，因此只能漸進遷移。

## 文件邊界

- `docs/specs/`：格式、介面與契約說明；不能取代 machine-readable schema。
- `docs/series/`：系列層級內容與學習流程規則。
- `docs/styles/`：視覺、聲音、剪輯等風格規則。
- `docs/characters/`：角色設定與 continuity 規則。
- 文件不可新增 runtime 不支援的 lesson 欄位；新能力須先完成 schema、validator 與 renderer 對齊。

## 目標命令面

最終可能包含 generate、validate、render、publish 等獨立命令，但命名與介面均為**待確認**。目前唯一正式命令仍是 `package.json` 的 `lesson:import`、`video:render`、`video:prototype`。

## 完成條件

- `AGENTS.md` 與 factory/roadmap 權責清楚。
- schema、types、validator、renderer 與 examples 表達同一 lesson contract。
- `src/` 承載正式實作，scripts 僅為薄 CLI／相容層。
- 每次 renderer 切換均有回歸證據與明確授權。
- planned generator/publisher 有獨立驗收與安全邊界。
- 舊格式與舊 renderer 有可追蹤淘汰計畫，而非直接刪除。
