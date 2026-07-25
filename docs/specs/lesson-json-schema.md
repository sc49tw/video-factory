# lesson.json 實際規格

狀態：依 2026-07-21 專案實作盤點  
適用範圍：目前 repository 內的 lesson JSON、匯入器與三個 English renderer

## 1. 依據與優先順序

本文件不是新格式設計，而是現況整理。發生衝突時採用下列優先順序：

1. `package.json` 實際接線的 `scripts/render-english-prototype.mjs`
2. `scripts/lesson-import.mjs` 的匯入與檢查行為
3. 未接到 package script 的 `render-english-v1.1.mjs`、`render-english-v2.mjs`
4. `schemas/lesson.schema.json`
5. `README.md`、renderer 規格文件與既有 lesson

重要現況：`pnpm video:render` 與 `pnpm lesson:import` 最後都呼叫
`scripts/render-english-prototype.mjs`。v1.1 和 v2 雖然已存在且可直接用 Node 執行，
但不是 package 的預設 renderer。因此下文的「目前 renderer」若未特別註明，指 prototype。

專案內沒有 TypeScript 原始檔，也沒有 TypeScript `type` / `interface`；唯一的靜態資料契約是
`schemas/lesson.schema.json`。package 也沒有 validator 指令或 validation dependency。

## 2. 執行方式與檔名規則

### 2.1 package 指令

```text
pnpm video:render <lesson-json-path>
pnpm video:prototype
pnpm lesson:import [--no-render] [--thumbnail <編號或完整檔名>]
```

- `video:render`：執行 prototype；lesson 路徑是第一個 positional argument。
- `video:prototype`：固定傳入 `lessons/examples/en-junior-high.example.json`。
- 未傳路徑時，prototype、v1.1、v2 都預設讀取上述 English example。
- renderer 不限制輸入 JSON 的檔名或所在目錄，只要求檔案可被當作 UTF-8 JSON 解析。
- renderer 固定輸出 `output/<lesson_id>.mp4`；`output_path`、`expected_output` 不會改變輸出位置。

### 2.2 importer 的額外限制

這些限制只屬於 `pnpm lesson:import`，不是 renderer 本身的 JSON 限制：

- 課程固定為 `en-junior-high`。
- 既有 lesson 檔名只以 `^en-junior-high-(\d+)\.json$` 計算下一號。
- 新 ID 為 `en-junior-high-<至少三位數>`，例如 `en-junior-high-010`。
- 只接受 `.png` 場景圖與縮圖。
- 場景數優先取 `scenes`、`visual_scenes`、`visuals.scenes` 的長度；都不存在時取 segment 數。
- 最新候選必須提供「場景數 + 1」張 PNG，其中一張是縮圖；場景輸出名固定為
  `scene01.png`、`scene02.png`……，縮圖固定為 `thumbnail.png`。
- importer 會寫入或覆寫 JSON 內的 `lesson_id`、`thumbnail`、`output_path`，並在可對應時寫入
  `segment.image` / scene 的 `image`。
- importer 要求 segment `id` 是非空且不重複的字串；renderer 本身則可替缺少的 ID 自動產生
  `s01`、`s02`……。

## 3. 目前可執行的完整結構

以下是 prototype 實際理解的結構。`?` 表示選填，`A | B` 表示相容格式；這不是新的 JSON Schema。

```text
Lesson {
  lesson_id: string                         必填、非空
  title: string                             必填、非空

  content?: { segments: Segment[1..] }      segment 容器優先順位 1
  segments?: Segment[1..]                   優先順位 2（舊格式）
  content_segments?: Segment[1..]           優先順位 3（舊格式）

  shadowing?: {
    sequence?: Sequence[]                   優先於 learning_flow
  }
  learning_flow?: LegacyPhase[]             相容舊格式

  display_series_title?: string             預設 Easy English Shadowing
  production?: PrototypeProduction

  ...其他欄位                              prototype 會忽略
}

Segment {
  id?: string                               renderer 缺省時產生 s01、s02……
  text?: string                             文字優先順位 1
  script?: string                           文字優先順位 2（舊格式）
  image?: string                            repository root 相對路徑或 absolute path
  ...其他欄位                               prototype 會保留但不使用
}

Sequence {
  type: "story" | "repeat" | "shadow"     shadowing.sequence 內須小寫才會命中
  segment_ids?: string[]                    省略或空陣列時使用全部 segments
  pause_after_seconds?: number              只有 repeat 使用
  ...其他欄位                               prototype 會忽略
}

LegacyPhase {
  type?: string                             STORY / REPEAT / SHADOW，不分大小寫
  mode?: string                             type 不存在時使用，不分大小寫
  items?: Array<{
    silent_pause_seconds?: number            prototype 只讀第一個有此值的 item
    ...其他欄位                              prototype 會忽略
  }>
}

PrototypeProduction {
  intro_title_card?: {
    background_image?: string
    duration_seconds?: number                預設 2
    ...其他欄位                              prototype 會忽略
  }
  transition_sting?: {
    enabled?: boolean                        僅 true 啟用
    asset?: string
    ...其他欄位                              prototype 會忽略
  }
}
```

### 3.1 必填欄位

| 欄位 | renderer 要求 | importer 要求 | 用途 |
|---|---:|---:|---|
| `lesson_id` | 必填、truthy | 匯入時自動改寫 | 決定輸出檔名與自動圖片路徑 |
| `title` | 必填、truthy | 不檢查 | prototype 的 intro 標題 |
| 三種 segment 容器之一 | 至少 1 筆 | 至少 1 筆 | lesson 內容 |
| `segment.id` | 選填 | 必填、非空、唯一 | sequence 引用與圖片推導 |
| `segment.text` 或 `segment.script` | 至少一個 truthy | 接受非空 `text`、`english` 或 `script` | TTS 與字幕 |

注意：importer 接受只有 `english` 的 segment，但 prototype 不讀 `english`，所以「只有
`english`」會通過 importer 的前置檢查，之後 render 仍失敗。v2 才支援
`text ?? english ?? script`。為確保 package 預設流程可用，應使用 `text`。

### 3.2 segment 容器與文字的優先順位

prototype 不合併多個容器，只取第一個不是 `null` / `undefined` 的值：

1. `content.segments`
2. `segments`
3. `content_segments`
4. 都沒有時為空陣列並失敗

文字取值為 `segment.text ?? segment.script`。空字串會在 normalize 時判定為缺少文字。

### 3.3 圖片解析規則

每個 segment 的圖片依下列順序解析：

1. `segment.image`
2. `visual_scenes` 中 `content_segment_id === segment.id` 的 `image`
3. 若實體檔存在，使用 `assets/images/<lesson_id>/<segment.id>.png`
4. renderer 內建 fallback：`assets/images/flashlight-comic.png`

目前 repository 中沒有第 4 項 fallback 檔。因此若前 3 項都找不到，FFmpeg 很可能因圖片不存在而失敗；
這不是可依賴的有效預設。`visuals.scenes` 與根層 `scenes` 不會被 renderer 用來解析圖片，
但 importer 會用它們計算、改寫場景圖。

renderer 沒有檢查圖片副檔名；是否能讀取取決於 FFmpeg。importer 則只接受 PNG。

### 3.4 STORY、REPEAT、SHADOW

prototype 固定產生三個主要階段，lesson 不能關閉它們：

| 階段 | sequence 搜尋值 | 沒有相符設定時 | 實際可控制欄位 |
|---|---|---|---|
| STORY | `story` | 全部 segments、原順序 | `segment_ids` |
| REPEAT | `repeat` | 全部 segments、原順序 | `segment_ids`、全段 pause |
| SHADOW | `shadow` | 全部 segments、原順序 | `segment_ids` |

搜尋順序是：先找 `shadowing.sequence` 中 `type` **完全等於小寫值**的第一筆；找不到才找
`learning_flow` 中 `type ?? mode` 不分大小寫相符的第一筆。

- `segment_ids` 可重新排序或選取 segment；未知 ID 會 fail-fast。
- `segment_ids` 省略或為空陣列時使用全部 segments。
- prototype 完全忽略 `learning_flow[].items` 的內容 ID，因此現有 003、005–009 中的
  `content_id` / `content_segment_id` 不會控制 prototype 的順序或選取。
- prototype 忽略 `show_image`、`show_script`、`play_speech`、`speech`、`silent_pause`；畫面行為由 renderer 固定。
- `listen`、`chunked`、`no_subtitle` 是 JSON Schema 允許的值，但 prototype 不會建立這些額外階段。
- `speed`、`repeat_count`、sequence 上的 `show_script` 都不影響 prototype。

REPEAT pause 的 prototype 取值順序：

1. repeat sequence 的 `pause_after_seconds`
2. `learning_flow` repeat phase 中第一個具有 `silent_pause_seconds` 的 item
3. 預設 `3`

取值會四捨五入成整數並限制最低為 0；0 表示不產生等待 clip。它不讀根層
`repeat_pause_seconds`、`pause_after_speech_seconds` 或 segment 的
`shadowing_pause_seconds`。

### 3.5 陣列長度與 ID 限制

- prototype 只要求實際採用的 segment 陣列至少 1 筆，沒有上限，也沒有固定 4 或 5 句的限制。
- prototype 對 `shadowing.sequence`、`learning_flow` 與 `segment_ids` 沒有整體長度上限。
- `segment_ids` 只要不是空陣列，其中每一筆都必須能精確對應 segment ID；prototype 不檢查重複 ID，
  因此重複引用會重複 render。
- prototype 對 segment ID 沒有 regex 或長度限制；importer 只要求非空、唯一；schema 才要求 `^s[0-9]{2,}$`。
- schema 另限制 `learning_objectives` 為 1–5 筆且 unique；其他主要陣列只有至少 1 筆，沒有上限。
- 「4 個 scenes」只是目前 005–009 與匯入 README 的常見工作流，不是 renderer 限制。004 已證明
  6 個 segments 對應 4 張圖也可表達；importer 會依 scene 陣列長度決定需提供幾張 PNG。

## 4. youtube 區塊

```json
{
  "youtube": {
    "hook": "He waved at the wrong person.",
    "cta": "Can you say all four sentences?"
  }
}
```

| 欄位 | 型別 | prototype | v1.1 | v2 | 預設 / fallback |
|---|---|---|---|---|---|
| `youtube.hook` | string | 忽略 | 使用 | 使用 | v1.1/v2 再找根層 `hook`，最後 `title` |
| `youtube.cta` | string | 忽略 | 使用 | 使用 | 4 段時 `Can you say all four sentences?`，否則 `Can you say the whole story?` |

`youtube` 不在 `schemas/lesson.schema.json` 中；因 root `additionalProperties: false`，含此區塊的
lesson 不符合該 schema。然而 008、009 已使用它，v1.1/v2 也確實實作上述兩欄。

## 5. production 區塊

### 5.1 prototype（package 預設）

| 欄位 | 型別 | 預設 | 實際行為 |
|---|---|---|---|
| `intro_title_card.background_image` | string | 第一個 story segment 圖片，再 fallback | intro 背景 |
| `intro_title_card.duration_seconds` | number | `2` | intro 秒數；未做範圍與型別驗證 |
| `transition_sting.enabled` | boolean | 非 `true` 即關閉 | true 時使用 sting asset |
| `transition_sting.asset` | string | `""` | 從 repository root 解析 |

prototype 忽略 `intro_title_card.enabled`、`title`、`subtitle`，也忽略
`transition_sting.volume`。

### 5.2 v1.1（存在，但 package 未接線）

v1.1 另支援：

| 欄位 | 型別 | 支援值 / 預設 | 實際行為 |
|---|---|---|---|
| `opening_mode` | string | `direct` 或其他值一律視為 `classic`；預設 `classic` | direct 跳過 hook、intro、STORY transition |
| `display_series_title` | string | `Easy English Shadowing` | 注意此欄在 `production` 內；prototype 的同名欄在 root |
| `subscribe_overlay.enabled` | boolean | 預設 false；只有嚴格 `true` 啟用 | final round 疊圖 |
| `subscribe_overlay.asset` | string | 預設 `""` | 不存在時警告並略過 |
| `subscribe_overlay.start_phase` | string | 預設 `final_round` | 實際只有不分大小寫等於 `final_round` 才啟用 |
| `subscribe_overlay.delay_seconds` | finite number | 預設 1.5，最低 0 | 相對 final round 開始時間 |
| `subscribe_overlay.duration_seconds` | finite number | 預設 3.5，最低 0 | 另限制不超過 asset duration |
| `subscribe_overlay.width` | finite number | 預設 360，最低 1 | overlay 寬度；實作未強制 integer |
| `subscribe_overlay.margin_right` | finite number | 預設 40，最低 0 | 右邊距；實作未強制 integer |
| `subscribe_overlay.margin_top` | finite number | 預設 40，最低 0 | 上邊距；實作未強制 integer |

v1.1 也讀取 prototype 的 `intro_title_card`、`transition_sting`。它只支援
`segment.text ?? segment.script`，且 `learning_flow.items` 不控制 segment 選取。

### 5.3 v2（存在，但 package 未接線）

v2 另支援：

| 欄位 | 型別 | 預設 | 實際行為 |
|---|---|---|---|
| `production.hook.background_image` | string | 最後 story 圖，再第一張圖，再 fallback | hook 背景 |
| `production.hook.duration_seconds` | number | 1.8 | hook 秒數 |
| `production.transition_sting.enabled` | boolean | 非 true 即關閉 | practice transition sting |
| `production.transition_sting.asset` | string | `""` | sting 路徑 |

v2 支援 `segment.text ?? segment.english ?? segment.script`，也會從
`learning_flow[].items` 依序讀 `content_id ?? content_segment_id ?? segment_id ?? id`。
它沒有實作 v1.1 的 `opening_mode` 或 `subscribe_overlay`。

### 5.4 JSON Schema 中的 production

`schemas/lesson.schema.json` 只正式宣告 `opening_mode` 與 `subscribe_overlay`，其 defaults 與上表 v1.1
大致相同；`production.additionalProperties` 與 `subscribe_overlay.additionalProperties` 均為 true。
JSON Schema 的 `default` 只是註記，專案沒有程式會套用 schema default；真正 defaults 仍以 renderer 程式為準。

## 6. schema 1.0 的完整靜態契約

下表記錄 `schemas/lesson.schema.json`，但這套契約未被 render 指令執行。除 `production` 外，
所有列出的 object 都是 `additionalProperties: false`。

| 路徑 | 必填 | 型別 / 限制 | 用途與 renderer 狀態 |
|---|---:|---|---|
| `schema_version` | 是 | string，固定 `1.0` | 契約版本；renderer 忽略 |
| `lesson_id` | 是 | string，至少 3 字元，`^[a-z0-9]+(?:-[a-z0-9]+)*$` | renderer 必填但不套 regex |
| `course_id` | 是 | `en-junior-high` 或 `ja-n4` | renderer 忽略 |
| `language` | 是 | 2–3 小寫字母，可接 BCP-47-like subtags | renderer 忽略；TTS voice 不由此選擇 |
| `title` | 是 | 非空 string | renderer 必填 |
| `topic` | 是 | 非空 string | renderer 忽略 |
| `level` | 是 | object | renderer 忽略 |
| `level.system` | 是 | 非空 string | 例：CEFR、JLPT |
| `level.value` | 是 | 非空 string | 例：A1-A2、N4 |
| `level.learner_profile` | 是 | 非空 string | 學習者描述 |
| `learning_objectives` | 是 | unique string array，1–5 筆，每筆非空 | renderer 忽略 |
| `focus` | 是 | object | renderer 忽略 |
| `focus.grammar` | 是 | array，至少 1 筆 GrammarFocus | renderer 忽略 |
| `focus.vocabulary` | 是 | array，至少 1 筆 VocabularyItem | renderer 忽略 |
| `content` | 是 | object | renderer 可從中讀 segments |
| `content.context_zh_tw` | 是 | 非空 string | renderer 忽略 |
| `content.segments` | 是 | Segment array，至少 1 筆 | renderer 使用 |
| `shadowing` | 是 | object | renderer 使用 sequence 的一部分 |
| `shadowing.sequence` | 是 | ShadowingStep array，至少 1 筆 | renderer 只實作 story/repeat/shadow |
| `visuals` | 是 | object | prototype 忽略 |
| `visuals.style` | 是 | 非空 string | renderer 忽略 |
| `visuals.scenes` | 是 | VisualScene array，至少 1 筆 | renderer 忽略；importer 讀取 |
| `production` | 否 | object | 各 renderer 支援度不同，見第 5 節 |
| `metadata` | 是 | object | renderer 忽略 |
| `metadata.created_at` | 是 | date-time string | 建立時間 |
| `metadata.generator` | 是 | 非空 string | 產生器名稱 |
| `metadata.status` | 是 | `draft`、`validated`、`rendered`、`published` | renderer 忽略 |

### 6.1 schema 子物件

`GrammarFocus`：

- `id`：必填，非空 string，lowercase kebab-case pattern。
- `label`：必填，非空 string。
- `is_new`：必填，boolean。

`VocabularyItem`：

- `term`、`display`、`meaning_zh_tw`：必填且非空 string。
- `is_new`：必填 boolean。
- `reading`：選填但若存在須為非空 string。

schema `Segment`：

- `id`：必填，格式 `^s[0-9]{2,}$`。
- `text`、`translation_zh_tw`：必填且非空 string。
- `reading`、`notes_zh_tw`：選填但若存在須非空。
- `chunks`：選填；若存在至少 1 個非空 string。
- schema 不允許 `image`，但 renderer 實際依賴它或其他圖片解析來源。

`ShadowingStep`：

- `type`：必填；schema 只允許 `listen`、`chunked`、`repeat`、`shadow`、`no_subtitle`。
- `segment_ids`：必填、至少 1 個、unique；每個 ID 須符合 `^s[0-9]{2,}$`。
- `speed`：選填 number，最低 0.1。
- `pause_after_seconds`：選填 number，最低 0。
- `repeat_count`：選填 integer，最低 1。

`VisualScene`：

- `id`：必填，格式 `^scene[0-9]{2,}$`。
- `segment_ids`：必填、至少 1 個、unique，ID 格式同上。
- `description`、`image_prompt`：必填且非空 string。
- schema 不允許 `image`；renderer 又不讀 `visuals.scenes[].image`。

## 7. 最小可執行範例

下例符合 prototype 的最低需求，且引用 repository 中已存在的圖片。沒有 sequence 時，這一段會自動用於
STORY、REPEAT、SHADOW；REPEAT pause 預設為 3 秒。

```json
{
  "lesson_id": "minimal-example",
  "title": "A Small Test",
  "content": {
    "segments": [
      {
        "id": "s01",
        "text": "Tom has an old flashlight.",
        "image": "assets/images/en-junior-high-001/scene01.png"
      }
    ]
  }
}
```

執行：

```text
pnpm video:render path/to/minimal-example.json
```

輸出固定為 `output/minimal-example.mp4`。這份最小範例可 render，但不符合嚴格的
`schemas/lesson.schema.json`，因為後者另要求完整的教學 metadata。

## 8. 完整範例

下例只使用 repository 程式已支援或既有 lesson 已使用的欄位。它採用 renderer 最直接的
`content.segments` + `shadowing.sequence` 格式；以 prototype 執行時，`youtube` 與 v1.1-only 的
production 欄位會被安全忽略。若要啟用 direct opening 與 overlay，須直接執行 v1.1。

```json
{
  "version": "1.0",
  "course_id": "en-junior-high",
  "lesson_id": "en-junior-high-008",
  "language": "en",
  "status": "draft",
  "title": "The Wrong Wave",
  "grammar": {
    "grammar_target": "Present simple with third-person singular verbs",
    "learner_can_do": "Describe a short sequence of actions in the present simple.",
    "sentence_pattern": "He + verb-s ..."
  },
  "content": {
    "segments": [
      {
        "id": "sentence-01",
        "text": "Tom sees someone waving.",
        "image": "assets/images/en-junior-high-008/scene01.png"
      },
      {
        "id": "sentence-02",
        "text": "He waves back excitedly.",
        "image": "assets/images/en-junior-high-008/scene02.png"
      },
      {
        "id": "sentence-03",
        "text": "He walks toward the person.",
        "image": "assets/images/en-junior-high-008/scene03.png"
      },
      {
        "id": "sentence-04",
        "text": "The person walks past him and hugs someone else.",
        "image": "assets/images/en-junior-high-008/scene04.png"
      }
    ]
  },
  "shadowing": {
    "sequence": [
      {
        "type": "story",
        "segment_ids": ["sentence-01", "sentence-02", "sentence-03", "sentence-04"]
      },
      {
        "type": "repeat",
        "segment_ids": ["sentence-01", "sentence-02", "sentence-03", "sentence-04"],
        "pause_after_seconds": 4
      },
      {
        "type": "shadow",
        "segment_ids": ["sentence-01", "sentence-02", "sentence-03", "sentence-04"]
      }
    ]
  },
  "youtube": {
    "hook": "He waved at the wrong person.",
    "cta": "Can you say all four sentences?"
  },
  "production": {
    "opening_mode": "classic",
    "intro_title_card": {
      "background_image": "assets/images/en-junior-high-008/scene01.png",
      "duration_seconds": 2
    },
    "transition_sting": {
      "enabled": false,
      "asset": ""
    },
    "subscribe_overlay": {
      "enabled": true,
      "asset": "assets/overlays/like-subscribe-bell-alpha.mov",
      "start_phase": "final_round",
      "delay_seconds": 1.5,
      "duration_seconds": 10,
      "width": 360,
      "margin_right": 40,
      "margin_top": 40
    }
  },
  "thumbnail": "assets/images/en-junior-high-008/thumbnail.png",
  "output_path": "output/en-junior-high-008.mp4"
}
```

## 9. 現有格式差異與 renderer 的實際選擇

| Lesson | 主要格式 | prototype 結果 |
|---|---|---|
| `en-junior-high-001`、`002` | root `segments[]` + `script`；ID 是 `scene01` 類型 | 支援；learning_flow 的顯示旗標大多忽略 |
| `en-junior-high-003` | `content_segments[]` + `visual_scenes[]` | 支援；由 visual_scenes 找圖；items 的 ID 選取忽略 |
| `en-junior-high-004` | `content.segments[]` + root `scenes[]`；6 段共用 4 圖 | 支援，因 segment 已有 `image`；segment pause、speaker 等忽略 |
| `en-junior-high-005`–`009` | `content.segments[]` + `learning_flow[].items[]` | 支援；實際會按 segments 原順序跑三階段 |
| English example | schema-like `content` / `shadowing` / `visuals`，另加 image 與 production | 可由 prototype 執行；不符合現行 schema 的數個限制 |
| Japanese example | 最接近 schema 1.0 | 內容結構可讀，但沒有可解析的實體圖片，且 TTS voice 固定為 English；目前不能視為可用 Japanese render 流程 |

容器同時存在時，renderer 採 `content.segments`，不會與 root `segments` 或
`content_segments` 合併。phase 同時存在時，該 phase 的 `shadowing.sequence` 優先於
`learning_flow`。

## 10. 尚未實作、被忽略或疑似歷史欄位

### 10.1 prototype 明確不使用

- 版本與分類：`schema_version`、`version`、`format_version`、`course_id`、`language`、`status`。
- 教學 metadata：`topic`、`level`、`learning_objectives`、`focus`、`grammar`、`grammar_focus`、
  `metadata`、`content.context_zh_tw`。
- segment 教學資料：`translation_zh_tw`、`reading`、`chunks`、`notes_zh_tw`、`speaker`、
  `type`、`visual_scene`、`scene_image`、`scene_id`、`shadowing_pause_seconds`。
- flow 顯示/播放旗標：`show_image`、`show_script`、`play_speech`、`speech`、`silent_pause`、
  `pause_after_speech_seconds`。
- sequence 行為：`speed`、`repeat_count`，以及 `listen`、`chunked`、`no_subtitle` phases。
- 視覺描述：root `scenes`、`visuals.style`、`visuals.scenes` 的 description / prompt / mapping；
  `visual_scenes` 除 `content_segment_id` + `image` mapping 外的欄位。
- 發布資料：`thumbnail`、`output_path`、`expected_output`、`validation_status`。
- `youtube` 全區塊、root `hook`。
- root `repeat_pause_seconds`。

上述有些欄位仍對內容生成、importer 或未接線 renderer 有用途，不能一概刪除；這裡只表示它們不影響
package 預設 render。

### 10.2 疑似已廢棄或未完成

- `learning_flow[].items` 的 `content_id` / `content_segment_id`：v2 已實作，prototype 和 v1.1 未實作；
  package 預設流程下屬於無效控制資料。
- `scene_image`：005–009 同時已有 `image`；所有 renderer 都不讀 `scene_image`，疑似產生流程遺留。
- 001/002 的 `visual_scene` 是文字描述，不是 renderer 讀取的 `visual_scenes` mapping。
- 004 的 `expected_output` 與 `output_path` 都不影響 renderer；實際輸出由 `lesson_id` 固定推導。
- English example 的 `intro_title_card.enabled/title/subtitle` 與 `transition_sting.volume` 沒有被 prototype 使用。
- README 所述「bootstrap、尚無 renderer」以及預期的 `src/renderer/` 結構已落後於實際 repository。

## 11. 已知契約衝突與待確認

1. **schema 不允許 `story`，renderer 卻以 `story` 為正式 phase。**  
   schema 的 `ShadowingStep.type` enum 沒有 `story`；English example 使用 `story`，prototype/v1.1/v2
   都搜尋它。實際 render 以程式為準。

2. **schema 不允許 segment / scene 的 `image`。**  
   但現行 renderer 最可靠的圖片來源就是 `segment.image`。English example 因額外的 `image`、缺少
   `visuals.scenes[].image_prompt` 等原因不符合 schema。

3. **schema 的核心必填欄位不是 renderer 必填欄位。**  
   003–009 等實際 lessons 大多不具有 schema 所要求的完整 `topic`、`focus`、`metadata` 等資料，
   仍能 render。

4. **版本欄位有三種名稱。**  
   現有資料使用 `schema_version`、`version`、`format_version`；renderer 全部忽略。哪一個應成為未來唯一
   版本欄位：**待確認**。

5. **`level` 同時存在 object 與 string。**  
   schema 要求 object，lesson 004 使用 string；renderer 忽略。內容工廠未來應採何者：**待確認**。

6. **production 功能分散在三個 renderer。**  
   prototype 有 intro/sting，v1.1 有 direct/overlay，v2 有 hook；package 目前只接 prototype。
   哪個 renderer 應成為正式現行版本，以及是否合併能力：**待確認**。

7. **Japanese example 不是目前可確認的可用 render 目標。**  
   它缺少現存圖片解析來源，且 renderer TTS 預設 voice 為 `en-US-JennyNeural`、SAPI fallback 也沒有依
   `language` 選 voice。Japanese 支援狀態：**待確認**。

8. **缺少 fallback 圖片。**  
   三個 renderer 都指向 `assets/images/flashlight-comic.png`，repository 實際不存在此檔。是否應補資產
   或移除 fallback：**待確認**（本次未修改 renderer 或 assets）。

