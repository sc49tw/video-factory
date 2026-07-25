# Lesson Contract Gap Matrix

狀態：v0.2 Stable Lesson Contract 盤點草案  
盤點日期：2026-07-21  
範圍：`schemas/lesson.schema.json`、11 份現有 lesson、importer、prototype、v1.1、v2 renderer

> 本文件只記錄差異並提出候選方向，不修改 schema，也不宣告任何 renderer 為 canonical。程式目前能接受的 fallback 是 as-is 證據，不自動等於未來正式契約。

## 1. 判讀方式與證據索引

- **Schema 定義**以 `schemas/lesson.schema.json` 為準；root、`content`、segment、shadowing、visuals 與 metadata 大多為 `additionalProperties: false`，未定義欄位會被拒絕。`production` 例外為 `additionalProperties: true`。
- **Corpus 使用率**以 `lessons/examples/*.json` 2 份及 `lessons/en-junior-high/*.json` 9 份，共 11 份、48 個 segments 統計。
- **Importer**指 `scripts/lesson-import.mjs`；它是相容匯入器，不是 JSON Schema validator。
- **Prototype**是 `package.json` 的 `video:render` 及 importer 實際呼叫版本；v1.1、v2 僅作行為對照，不代表候選優先順序。
- 表中的「canonical 候選」是供人工決策的提案：**是**、**否**或**待確認**，不是已核准契約。

證據代號：

| 代號 | 來源與相關區段 |
| --- | --- |
| S-root | `schemas/lesson.schema.json:8-205`：root required/properties、content、shadowing、visuals、metadata |
| S-prod | `schemas/lesson.schema.json:209-258`：`production`、`opening_mode`、`subscribe_overlay` |
| S-seg | `schemas/lesson.schema.json:326-363`：segment required/properties |
| S-flow | `schemas/lesson.schema.json:366-404`：shadowing step enum、IDs、pause/speed/repeat |
| S-scene | `schemas/lesson.schema.json:409-445`：visual scene |
| I-rewrite | `scripts/lesson-import.mjs:66-78`：`rewrite()`、`normalizeLessonShape()` |
| I-validate | `scripts/lesson-import.mjs:81-98`：`validate()` |
| I-main | `scripts/lesson-import.mjs:109-171`：ID、thumbnail、output、scene/image 改寫及 prototype 呼叫 |
| P-shape | `scripts/render-english-prototype.mjs:416-480`：`getSequence()`、`normalizeSegment()`、`getLessonSegments()`、`requireLessonFields()` |
| P-main | `scripts/render-english-prototype.mjs:484-520`：輸出、三階段、pause、production defaults |
| P-end | `scripts/render-english-prototype.mjs:609-649`：固定 SHADOW 與 ending |
| R1-prod | `scripts/render-english-v1.1.mjs:176-233`：`getProductionSettings()`、`getSubscribeOverlay()` |
| R1-shape | `scripts/render-english-v1.1.mjs:524-620`：flow、segment、必填與 hook |
| R1-end | `scripts/render-english-v1.1.mjs:614-778`：固定三階段、CTA |
| R2-shape | `scripts/render-english-v2.mjs:436-524`：flow items、segment aliases、必填與輸出 |
| R2-main | `scripts/render-english-v2.mjs:532-668`：固定三階段、hook、production、CTA |
| C-001 | `lessons/en-junior-high/en-junior-high-001.json:1-41` 與 `002.json:1-42`：root `segments` + `script` + `learning_flow` |
| C-003 | `lessons/en-junior-high/en-junior-high-003.json:1-53`：`content_segments` + `visual_scenes` + `learning_flow` |
| C-004 | `lessons/en-junior-high/en-junior-high-004.json:1-80`：`format_version`、string `level`、`content.segments`、root scenes/output |
| C-005 | `lessons/en-junior-high/en-junior-high-005.json:1-135` 至 `009.json:1-152`：`version`、`content.segments`、`learning_flow.items`、輸出欄位 |
| C-008 | `lessons/en-junior-high/en-junior-high-008.json:134-152` 與 `009.json:134-139`：YouTube、production、thumbnail/output |
| C-ex | `lessons/examples/en-junior-high.example.json:1-177`、`ja-n4.example.json:1-196`：schema-like examples |

## 2. Corpus 基準

| 項目 | 實際結果 |
| --- | --- |
| Lesson 數 | 11（English production 9、examples 2） |
| Segment 數 | 48 |
| 版本欄位 | `schema_version` 5/11；`version` 5/11；`format_version` 1/11 |
| Segment 容器 | `content.segments` 8/11；root `segments` 2/11；`content_segments` 1/11 |
| Flow 容器 | `learning_flow` 8/11；`shadowing.sequence` 2/11；004 兩者皆無 |
| Segment 文字 | `text` 38/48；`script` 10/48；`english` 0/48 |
| Segment 圖片 | `image` 30/48；`visual_scenes[].image` 只見 003；Japanese example 沒有 runtime 可讀圖片 |
| 完整 schema-like metadata | `metadata`、`focus`、`visuals`、`shadowing` 各只出現在 2/11 examples |

證據：C-001、C-003、C-004、C-005、C-ex；上述數字由完整 corpus JSON parse 後統計。

## 3. 六來源操作矩陣

縮寫：**讀**＝直接影響行為；**改**＝寫入／改寫；**驗**＝明確檢查；**忽略**＝程式沒有讀取；**通用改寫**＝`rewrite()` 會遞迴替換字串，但不理解欄位語意。

### 3.1 身分、版本與教學 metadata

| JSON path | Schema：型別／required | 現有 lessons | Importer | Prototype | v1.1 | v2 | Runtime fallback/default |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `schema_version` | string、**必填**、const `1.0` | 5/11 | 不讀、不驗 | 忽略 | 忽略 | 忽略 | 無；runtime 不看版本 |
| `version` | 未定義；root 會拒絕 | 5/11，皆 `1.0` | 不讀、不驗 | 忽略 | 忽略 | 忽略 | 無 |
| `format_version` | 未定義；root 會拒絕 | 1/11，`1.0-draft` | 不讀、不驗 | 忽略 | 忽略 | 忽略 | 無 |
| `lesson_id` | string、**必填**、min 3、kebab pattern | 11/11 | **改**為下一個 `en-junior-high-NNN`；不依 schema 驗證 | **必填／讀**；輸出檔名、自動圖片候選 | 同 prototype | 同 prototype | 無；缺少即 fail |
| `course` | 未定義 | 0/11 | 不讀；程式內常數 `course="en-junior-high"` 只控制目錄/ID | 忽略 | 忽略 | 忽略 | 無 |
| `course_id` | string、**必填**；enum `en-junior-high`/`ja-n4` | 10/11；004 缺少 | 不讀、不補、不驗 | 忽略 | 忽略 | 忽略 | 無；TTS/renderer 不依它選擇 |
| `language` | string、**必填**、language-tag pattern | 10/11；004 缺少 | 不讀、不驗 | 忽略 | 忽略 | 忽略 | TTS 預設仍固定 English voice，不由此欄決定 |
| `level` | object、**必填**；`system/value/learner_profile` 皆必填 | 3/11；2 個 object examples、004 是 string | 不讀、不驗 | 忽略 | 忽略 | 忽略 | 無 |
| `title` | non-empty string、**必填** | 11/11 | 不驗；匯入後由 prototype 間接要求 | **必填／讀** intro | **必填／讀**，亦為 hook fallback | **必填／讀**，亦為 hook fallback | 缺少即 fail；hook 可 fallback 至 title |
| `metadata` | object、**必填**；`created_at/generator/status` 必填 | 2/11 examples | 不讀、不驗 | 忽略 | 忽略 | 忽略 | 無 |
| `focus` | object、**必填**；grammar/vocabulary arrays 各 min 1 | 2/11 examples；production lessons 多用 `grammar` 或 `grammar_focus` | 不讀、不驗 | 忽略 | 忽略 | 忽略 | 無 |

證據：S-root；I-main:109-128；P-shape:470-480、P-main:484-520；R1-shape:587-620；R2-shape:505-524；C-001、C-004、C-005、C-ex。

### 3.2 Content 與 segment

| JSON path | Schema：型別／required | 現有 lessons | Importer | Prototype | v1.1 | v2 | Runtime fallback/default |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `content` | object、**必填**；只允許 `context_zh_tw/segments` | 8/11 均為 object | 若外部 `content` 是 array，**改**為 `{segments: ...}` | 只作 `content.segments` 容器 | 同 prototype | 同 prototype | 無 |
| `content.segments` | array、**必填**、min 1 | 8/11 | 優先讀／驗；至少 1 | 優先讀／至少 1 | 同 prototype | 同 prototype | 容器優先順位 1 |
| `segments` | schema 未定義 | 2/11（001–002） | 相容讀／驗 | 相容讀 | 相容讀 | 相容讀 | 容器優先順位 2；不與第一容器合併 |
| `content_segments` | schema 未定義 | 1/11（003） | 相容讀／驗 | 相容讀 | 相容讀 | 相容讀 | 容器優先順位 3；不合併 |
| `segment.id` | string、**必填**、`^s[0-9]{2,}$` | 48/48；實際有 `scene01`、`sentence-01` 等不符 schema pattern 的值 | **驗**非空、unique；不驗 regex | 讀；缺少時生成 `s01...`；sequence map key | 同 prototype | 同 prototype | renderer fallback `sNN`；importer 不接受缺少 ID |
| `segment.text` | non-empty string、**必填** | 38/48、9/11 lessons | 文字候選順位 1，驗 non-empty | 文字順位 1、TTS/字幕 | 同 prototype | 同 prototype | 無；最後沒有可用文字即 fail |
| `segment.script` | schema 未定義 | 10/48、001–002 | 文字候選順位 3 | 文字順位 2 | 文字順位 2 | 文字順位 3 | 只作文字 alias |
| `segment.english` | schema 未定義 | 0/48 | 文字候選順位 2，可通過驗證 | **不讀** | **不讀** | 文字順位 2 | importer 接受但正式 prototype 可能隨後 fail |
| `segment.image` | schema 未定義，segment 會拒絕 | 30/48、7/11 lessons | 依 scene mapping 或 1:1 順序**改寫** | 圖片順位 1 | 同 prototype | 同 prototype | 再找 `visual_scenes`、生成路徑、最後硬編碼 fallback 圖 |

證據：S-root:118-137、S-seg；I-rewrite:76-78、I-validate:81-92、I-main:129-145；P-shape:430-449；R1-shape:547-566；R2-shape:450-469；C-001、C-003、C-004、C-005、C-ex。

### 3.3 Visual、story/repeat/shadow 與 flow

| JSON path | Schema：型別／required | 現有 lessons | Importer | Prototype | v1.1 | v2 | Runtime fallback/default |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `visuals` | object、**必填**；`style/scenes` 必填 | 2/11 examples | 讀 `visuals.scenes` 作 scene 容器的第三順位，並可加入 `scene.image` | 忽略整體 | 忽略整體 | 忽略整體 | 無 |
| `visuals.scenes` | array、**必填**、min 1；scene 有嚴格 shape | 2/11 examples | scene 計數/ID mapping/改寫 image | **不讀**，即使 importer 寫入 `image` | **不讀** | **不讀** | 無 |
| `visual_scenes` | schema 未定義 | 1/11（003） | scene 容器第二順位；驗 `content_segment_id`；改寫 `image` | 以 `content_segment_id` 對應圖片 | 同 prototype | 同 prototype | 只在 segment.image 缺少時使用 |
| root `story` | schema 未定義 | 0/11 | 不讀 | 不讀；只尋找 flow type `story` | 同 prototype | 同 prototype | 無設定時仍固定建立 STORY，使用全部 segments |
| root `repeat` | schema 未定義 | 0/11 | 不讀 | 不讀；只尋找 flow type `repeat` | 同 prototype | 同 prototype | 無設定時仍固定建立 REPEAT；pause 預設 3 秒 |
| `shadowing` | object、**必填**；只允許 sequence | 2/11 examples | 不讀、不驗 | 讀 `shadowing.sequence` | 同 prototype | 同 prototype | 缺少仍可由 `learning_flow` 或全部 segments 運作 |
| `shadowing.sequence` | array、**必填**、min 1 | 2/11 examples | 不讀、不驗 | 各 phase 優先來源 | 同 prototype | 同 prototype | 找不到某 phase 時再看 `learning_flow`；仍找不到則全 segments |
| `shadowing.sequence[].type="story"` | **不允許**；enum 沒有 `story` | English example 使用；Japanese example 用 `listen` 等 | 不讀 | 精確搜尋小寫 `story` | 同 prototype | 同 prototype | 找不到仍建立 STORY |
| `shadowing.sequence[].type="repeat"` | string enum 允許；step required | 2/11 examples | 不讀 | 搜尋小寫 `repeat` | 同 prototype | 同 prototype | 找不到仍建立 REPEAT |
| `shadowing.sequence[].type="shadow"` | string enum 允許；step required | 2/11 examples | 不讀 | 搜尋小寫 `shadow` | 同 prototype | 同 prototype | 找不到仍建立 SHADOW |
| `shadowing.sequence[].segment_ids` | array、**必填**、min 1、unique、ID regex | 2/11 examples | 不讀、不驗 | 控制選取/順序；未知 ID fail | 同 prototype | 同 prototype | 缺少或空陣列＝全部 segments；runtime 不驗 unique |
| `shadowing.sequence[].pause_after_seconds` | number、optional、min 0 | 2/11 examples 的 repeat | 不讀 | repeat pause 順位 1；round、min 0 | repeat pause 順位 1；轉 number、min 0 | 位於 per-item pause 後；finite、min 0 | 最終 3 秒 |
| `learning_flow` | schema 未定義 | 8/11 | 不讀、不驗；只受通用字串 rewrite | 第二順位 flow；type/mode 不分大小寫 | 同 prototype | 同 prototype | 某 phase 缺少時全部 segments |
| `learning_flow[].items[]` ID aliases | schema 未定義 | 003 用 `content_segment_id`；005–009 用 `content_id` | 不讀、不驗 | **不讀 IDs** | **不讀 IDs** | 依 `content_id ?? content_segment_id ?? segment_id ?? id` 選取/排序 | v2 沒 IDs 時全 segments |
| `learning_flow[].items[].silent_pause_seconds` | schema 未定義 | repeat items 見 003、005–009 | 不讀、不驗 | 使用第一個有值的 item，之後預設 3 | 先當前 item、再第一個 item、再 3 | 先當前 item、再 phase pause、再第一個 item、再 3 | 三 renderer precedence/rounding 不一致 |

證據：S-root:139-175、S-flow、S-scene；I-validate:93-95、I-main:131-144；P-shape:416-463、P-main:497-505；R1-shape:524-580；R2-shape:436-499；C-003、C-005、C-ex。

### 3.4 YouTube、production 與輸出 bookkeeping

| JSON path | Schema：型別／required | 現有 lessons | Importer | Prototype | v1.1 | v2 | Runtime fallback/default |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `youtube` | 未定義；root 會拒絕 | 2/11（008–009） | 不讀；通用 rewrite 可能改內部字串 | 忽略 | 讀 `hook/cta` | 讀 `hook/cta` | v1.1/v2 hook 最後 fallback title；CTA 有固定句 |
| `youtube.hook` | 未定義 | 2/11 | 不讀 | 忽略 | 讀，之後 root `hook`、title | 同 v1.1 | title |
| `youtube.cta` | 未定義 | 2/11 | 不讀 | 忽略；固定 `See you next time.` | 讀 | 讀 | 4 段用 four-sentence 句，否則 whole-story 句 |
| `production` | object、optional；`additionalProperties: true` | 2/11（008、English example） | 不讀；通用 rewrite | 讀 intro/sting 子集 | 讀 intro/sting/opening/overlay/title | 讀 hook/sting 子集 | 缺少 object 時三 renderer 各自套 defaults |
| `production.intro_title_card` | 未正式定義，但因 additionalProperties 允許 | English example | 不讀 | 背景；duration 預設 2 | 同 prototype | 不讀 | 背景再 fallback 第一 story 圖/內建圖 |
| `production.transition_sting` | 未正式定義，但允許 | English example | 不讀 | `enabled===true` 才用 asset | 同 prototype | 同類欄位用於 practice transition | disabled/空 asset |
| `production.opening_mode` | string、optional、enum classic/direct、schema default classic | 1/11（008 classic） | 不讀 | 忽略 | 讀；僅 `direct` 特殊，其他皆 classic | 忽略 | v1.1 classic；schema default 不會被程式自動套用 |
| `production.subscribe_overlay` | object、optional；子欄位皆 optional | 1/11（008） | 不讀；asset 字串可能通用改寫 | 忽略 | 讀完整設定 | 忽略 | enabled false；asset `""`；phase final_round；delay 1.5；duration 3.5；width 360；margins 40 |
| `output` | schema 未定義 | 0/11 | 若外部存在，`rewrite()` **改**為 `output/<id>.mp4` | 忽略 | 忽略 | 忽略 | renderer 固定用 lesson_id 推導 |
| `output_path` | schema 未定義 | 6/11（004–009） | 通用改寫且主流程**新增/覆寫** | 忽略 | 忽略 | 忽略 | 實際輸出永遠 `output/<lesson_id>.mp4` |
| `thumbnail` | schema 未定義 | 6/11（004–009） | 通用改寫且主流程**新增/覆寫** | 忽略 | 忽略 | 忽略 | 無 runtime fallback；不影響 render |

證據：S-root:176-178、S-prod；I-rewrite:66-73、I-main:126-128；P-main:489、506-520、P-end；R1-prod、R1-shape:601-625、R1-end:775-778；R2-shape:519-524、R2-main:532-668；C-008、C-ex。

## 4. 契約決策矩陣

「疑似未使用」只表示目前被檢查的 importer/renderers 沒有語意使用；不代表內容生成或未來 publisher 不需要。

| JSON path | Canonical 候選 | Legacy alias | 疑似未使用 | 建議 | 風險與證據 |
| --- | --- | --- | --- | --- | --- |
| `schema_version` | 是 | 否 | runtime 未使用，但契約需要 | **保留**，作唯一版本鍵 | 若只改 schema 不做相容，現有 6/11 非此鍵；S-root、C-004、C-005 |
| `version` | 否 | 是 | 是 | **棄用**，migration 時映射至 schema_version | 5/11 使用；不可先 blocking；C-005 |
| `format_version` | 否 | 是 | 是 | **棄用**，映射後保留原值語意待確認 | 唯一值 `1.0-draft` 未必等於 schema 1.0；C-004 |
| `lesson_id` | 是 | 否 | 否 | **保留**；pattern 是否沿用待確認 | corpus IDs 全有，但 importer 與 renderer 約束不同；S-root、I-main、P-shape |
| `course` | 否 | 否 | 是 | **棄用／不要新增**；使用 `course_id` | corpus 無此欄；不要把 importer 常數誤當 lesson 欄位；I-main |
| `course_id` | 是 | 否 | renderer 未使用 | **保留**；是否限制 enum 待確認 | 004 缺少；Japanese runtime 尚不可用；S-root、C-004 |
| `language` | 是 | 否 | renderer 未使用 | **保留**；未來需連到 TTS validation | 欄位存在不代表 renderer 支援該語言；S-root、R2-shape、C-ex |
| `level` | 是 | 否 | runtime 未使用 | **修改**：先決定 object 是否唯一 | 004 使用 string；直接 enforce 會失敗；S-root、C-004 |
| `title` | 是 | 否 | 否 | **保留**、required | 所有 runtime 必填；I 不先驗，錯誤延後到 render；P-shape |
| `metadata` | 是 | 否 | renderer/importer 未使用 | **保留或修改，待確認** required 程度 | 僅 2/11；若 required 需 migration strategy；S-root、C-ex |
| `focus` | 是 | 否 | renderer/importer 未使用 | **保留或修改，待確認**；需處理 `grammar/grammar_focus` | 只有 examples 符合，production 有其他教學欄位；S-root、C-001、C-005 |
| `content` | 是 | 否 | 否 | **保留**作 canonical container | importer 還接受 array content；I-rewrite、S-root |
| `content.segments` | 是 | 否 | 否 | **保留**作唯一 canonical segment 容器 | 8/11 已使用；須維持 legacy adapters；P-shape、C corpus |
| `segments` | 否 | 是 | 否 | **棄用**但暫留 compatibility | 001–002 依賴；移除會中斷；C-001、P-shape |
| `content_segments` | 否 | 是 | 否 | **棄用**但暫留 compatibility | 003 依賴；C-003、P-shape |
| `segment.id` | 是 | 否 | 否 | **保留**、required；ID pattern **修改/待確認** | 48/48 有 ID，但多種既有格式不符 `sNN`；S-seg、I-validate、C corpus |
| `segment.text` | 是 | 否 | 否 | **保留**作 canonical 唯一文字欄位 | 遷移 script 前不得 enforce；S-seg、P-shape |
| `segment.script` | 否 | 是 | 否 | **棄用**，adapter 映射至 text | 001–002 共 10 段依賴；C-001、P-shape |
| `segment.english` | 否 | 是／實驗 alias | corpus 未使用 | **棄用或待確認**；至少修正 importer/prototype 不對稱 | importer 接受、prototype/v1.1 不讀、v2 讀；I-validate、P-shape、R2-shape |
| `segment.image` | 是（強候選） | 否 | 否 | **修改 schema 後保留**，或先決定 asset mapping model | schema 禁止但 30/48 segments 與 renderer 依賴；S-seg、P-shape、C-004/C-005 |
| `visuals` | 待確認 | 否 | renderer 未使用 | **修改／待確認**：保留生成描述，或從 runtime contract 分層 | schema required、只有 examples；importer 會改 image 但 renderer 不讀；S-root、I-main、P-shape |
| `visuals.scenes` | 待確認 | 否 | renderer 未使用 | **修改／待確認** mapping 與 `segment.image` 的單一權責 | importer 寫入 renderer 不讀的 image；I-main、S-scene |
| `visual_scenes` | 否 | 是 | 否 | **棄用**但保留 003 adapter | 003 圖片解析依賴；C-003、P-shape |
| root `story` | 否 | 否 | 是 | **棄用／不要新增** | corpus/schema/runtime 均無 root story；P-main |
| root `repeat` | 否 | 否 | 是 | **棄用／不要新增** | corpus/schema/runtime 均無 root repeat；P-main |
| `shadowing` | 是 | 否 | 否 | **保留但修改** phase contract | schema required、8/11 production lessons 不含；S-root、C corpus |
| `shadowing.sequence` | 是 | 否 | 否 | **保留**作 canonical flow；定義缺 phase 是否允許 | renderer 固定三階段、schema enum 卻缺 story；S-flow、P-main |
| phase `story` | 是 | 否 | 否 | **修改 schema enum：候選加入** | 三 renderer 都搜尋 story；現 schema 拒絕 English example；S-flow、P-main、C-ex |
| phase `repeat` | 是 | 否 | 否 | **保留** | pause precedence 三 renderer 不同；需另決策；S-flow、P/R1/R2 pause functions |
| phase `shadow` | 是 | 否 | 否 | **保留** | renderer 固定執行；S-flow、P-main |
| `learning_flow` | 否 | 是 | 否 | **棄用**但保留 compatibility adapter | 8/11 依賴 phase discovery；P-shape、C-001/C-005 |
| `learning_flow[].items[]` ID aliases | 否 | 是 | prototype/v1.1 未使用 | **棄用**；若要遷移，轉成 `segment_ids` | v2 使用但不是 package renderer；不可因此自動納入 schema；R2-shape |
| `youtube` | 待確認 | 否 | prototype 未使用 | **待確認**：可能屬 publishing metadata，而非 core lesson | 2/11；v1.1/v2 讀，v0.6 publisher 尚 planned；C-008、R1/R2 main |
| `production` | 是（optional namespace） | 否 | 否 | **保留但收斂**每個正式子欄位 | 三 renderer 支援集合分裂；未選 canonical renderer；S-prod、P/R1/R2 main |
| `output` | 否 | 是／外部 alias | 是 | **棄用** | importer 會改但 corpus 沒有；I-rewrite |
| `output_path` | 否 | legacy bookkeeping | 是 | **棄用或移出 lesson，待確認** | 6/11、importer寫入，renderer忽略；I-main、P-main |
| `thumbnail` | 待確認 | legacy bookkeeping | renderer 未使用 | **待確認**是否移至 publishing/asset manifest | 6/11、importer寫入，v0.6 尚 planned；I-main、C-005 |
| `production.opening_mode` | 待確認 | 否 | prototype/v2 未使用 | **待確認**，不得因 v1.1 支援就自動 canonical | schema 已定義、只有 008、僅 v1.1 行為有效；S-prod、R1-prod、C-008 |
| `production.subscribe_overlay` | 待確認 | 否 | prototype/v2 未使用 | **待確認**，保留為 renderer-specific 候選 | schema 與 v1.1 defaults 大致一致，但 package 不使用；S-prod、R1-prod、C-008 |

## 5. Proposed canonical fields

以下是基於交集、資料完整性與可遷移性的**提案集合**，不是 schema 修改決定：

1. **Identity/version**：`schema_version`、`lesson_id`、`course_id`、`language`、`title`。
2. **Pedagogy metadata**：`level`、`focus`、`metadata` 是否 required，以及 `topic`、`learning_objectives` 的保留層級，仍需人工確認；不因 renderer 忽略就自動刪除。
3. **Canonical content**：`content` → `content.segments[]`；segment 至少使用 `id`、`text`。`segment.image` 是強候選，但必須先決定它與 `visuals.scenes` 的權責。
4. **Canonical learning flow**：`shadowing.sequence[]`，至少能表達 `story`、`repeat`、`shadow` 與 `segment_ids`；repeat pause 的唯一欄位與優先順位待確認。
5. **Optional renderer configuration**：`production` 可保留為 namespace，但只有經跨 renderer/正式路徑決策的子欄位才應進正式 schema。

不建議把 renderer 的「缺 sequence 就跑全部 segments」「缺 ID 就生 `sNN`」「多容器優先順位」直接寫成永久 canonical 規則；這些較適合作為 migration adapter 行為。

## 6. Legacy compatibility fields

建議先以 non-blocking adapter/audit 支援，再分批遷移：

| Legacy path | Canonical 映射候選 | 現有依賴 |
| --- | --- | --- |
| `version`、`format_version` | `schema_version` | 6/11 lessons |
| root `segments` | `content.segments` | 001–002 |
| `content_segments` | `content.segments` | 003 |
| `segment.script` | `segment.text` | 001–002，10 segments |
| `segment.english` | `segment.text` | corpus 無；importer/v2 相容分支 |
| `visual_scenes` | `segment.image` 或待定 canonical visual mapping | 003 |
| `learning_flow` | `shadowing.sequence` | 8/11 |
| `learning_flow[].items[].content_id/content_segment_id/...` | `shadowing.sequence[].segment_ids` | 003、005–009；目前只 v2 讀 IDs |
| `output`、`output_path` | runtime 由 `lesson_id` 推導，或移至 build manifest | output 0/11；output_path 6/11 |
| root `thumbnail` | 待定 asset/publishing manifest | 6/11 |

Compatibility 層應明確記錄 warning，不應讓正式 schema 同時永久接受所有 aliases。

## 7. Unresolved decisions

1. **版本鍵與版本語意**：是否統一為 `schema_version`；`format_version: 1.0-draft` 應如何映射，不能只改欄位名。
2. **Segment ID 規則**：沿用嚴格 `sNN`，或接受現有 `scene01`、`sentence-01` 等 kebab/semantic IDs；這會影響 sequence 與資產命名。
3. **圖片權責**：正式契約應以 `segment.image`、`visuals.scenes` mapping，或獨立 asset manifest 為準；目前 importer 與 renderer 對 `visuals.scenes[].image` 的行為不閉合。
4. **Flow phase 集合**：是否 canonical 只含 STORY/REPEAT/SHADOW，或保留 schema 的 `listen/chunked/no_subtitle`；後三者目前沒有 renderer phase 實作。
5. **Repeat pause 契約**：`pause_after_seconds` 是全 phase 還是 per item；prototype、v1.1、v2 的 precedence 與 rounding 不一致。
6. **Pedagogy metadata required 程度**：`topic/level/learning_objectives/focus/metadata/visuals` 是否全部 required；只有 2/11 examples 完整具備。
7. **`youtube` 與 `thumbnail` 的邊界**：留在 lesson、放到 publishing manifest，或延後到 v0.6；目前 prototype 不使用。
8. **Production 子契約**：intro、sting、hook、opening、overlay 分散於三 renderer；v0.2 不應藉此選 renderer，也不能先假定全部功能都 canonical。
9. **Language 與 course 支援**：schema 允許 Japanese，但三個 renderer 的 TTS/圖片流程沒有形成可確認的 Japanese operational path。
10. **缺值策略**：canonical schema 是否要求完整 phase/ID/image，而 compatibility adapter 才提供 fallback；建議如此，但 enforcement 時點待確認。

## 8. 最需要人工決策的 5 個 contract 問題

1. **Canonical segment/visual model 是什麼？** `segment.image` 是現行最可靠 runtime 欄位，卻被 schema 禁止；`visuals.scenes` 被 schema 要求但 renderer 不讀。
2. **Canonical flow phase 集合是什麼？** renderer 必用 `story`，schema 卻不允許；schema 的 `listen/chunked/no_subtitle` 又未被 renderer 實作。
3. **Legacy lesson 的 ID 與容器如何遷移？** 是否強制 `sNN`，以及 root `segments`、`content_segments`、`script`、`learning_flow` 的相容期限。
4. **哪些教學 metadata 必須成為新 lesson 的 required fields？** 嚴格 schema 只由 2/11 examples 展示，不能直接阻擋 9 份現有 production lessons。
5. **Renderer-specific / publishing 欄位放在哪裡？** `youtube`、`thumbnail`、opening、overlay、hook、intro、sting 應屬核心 lesson、production namespace 或獨立 manifest；必須在不選 canonical renderer 的前提下決策。

## 9. 本輪結論

- 現況最接近 canonical 容器的交集是 `lesson_id`、`title`、`content.segments[].id/text`，但僅此不足以構成完整教學契約。
- `schema_version`、教學 metadata、visual mapping 與 shadowing flow 的方向合理，但 schema 與 corpus/runtime 仍有 blocking gaps。
- 應先完成上述人工決策，再修改 schema；之後以 non-blocking audit 驗證全部 11 份 lessons。
- 本文件不建議切換 renderer，也沒有把 v1.1 或 v2 的專屬能力視為已採用。
