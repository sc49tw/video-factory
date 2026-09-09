# ESSY Video Production Playbook

Version 1.5 — Reflective Essay / Narration Video

Working channel identity: A Second Look at Life

Purpose: provide a portable editorial and production contract that can be attached to a new AI conversation or read by Video Factory/Cline so that each ESSY episode follows the same validated workflow.

## 1. How to Use This Document

1. Treat this playbook as the production and editorial contract for ESSY episodes.
2. When a new episode starts, provide this document plus the complete episode script to the AI conversation.
3. Read the entire script before planning visuals. Do not plan shot-by-shot while only seeing fragments.
4. If narration blocks are not already defined, divide the script into stable semantic narration blocks and assign stable IDs (N001, N002, ...).
5. Create a visual arc for each narration block, then divide it into visual slots where editorially needed. Roughly 7–10 seconds per visual remains a useful pacing guideline, NOT a requirement to create another sourcing slot or visual cut: a suitable atmospheric visual may remain on screen substantially longer (see §6.4).
6. For every slot, assign an `editorialFunction` (what editorial job the shot performs in the surrounding sequence), then a `visualIntent` plus an `avoid` list. Narration meaning and visual function are related but not identical.
7. Inspect the slots of each block as a sequence and run the sequence-level literalness check before generating queries. One literal shot can establish an idea; several consecutive literal shots can turn the video into an illustrated transcript.
8. Generate video-first stock search queries for each slot only after the editorial-function, visual-intent and literalness steps are complete. Use photos as fallback, not the default.
9. Review candidates editorially before downloading — visually, via contact sheet or preview, never solely from textual metadata when a preview is available. Search and selection are separate from download and rendering.
10. After selections are approved, Video Factory performs deterministic download, provenance recording, rendering and automated QA.
11. If a revision is needed after review, prefer small slot-level revisions; freeze unaffected shots. Do not redesign the renderer or expand scope during editorial/sourcing work unless explicitly requested.

## 2. Editorial Identity

ESSY is a reflective video-essay format. The tone is calm, mature and observational rather than motivational, preachy or optimized for constant stimulation. The initial editorial territory includes midlife, work, money, time, freedom, simplicity, aging, ambition, technology and the assumptions people make about a good life.

Core editorial method: take a familiar assumption and examine it again from a different stage of life or a different angle. The video should invite reflection rather than announce that the viewer has been living incorrectly.

### 2.1 Script Compression Pass (canonical, ESSY-0004+)

Before the English script is approved and frozen, it goes through one editorial
compression pass: **English Draft → Compression Pass → Human Approval →
Storyboard / visual planning.** The objective is density, not brevity: remove
conceptual redundancy, low-value restatement and transition overhead while
preserving emotional progression, necessary pauses, contrast and the reflective
ESSY tone. It is never a hard duration cap and never a rush-summary.

Checks (applied in order):

1. **Idea repetition** — has this thought already been established?
2. **Same-function sentences** — do two consecutive sentences perform the same rhetorical job?
3. **Restatement after conclusion** — did we land the point, then explain it again?
4. **Example value** — does the example add a new dimension or merely repeat the claim?
5. **Rhetorical-question density** — are multiple nearby questions doing the same work? (Intentional callbacks, e.g. a closing title question, are exempt.)
6. **Transition overhead** — can the transition be shorter without losing tone?
7. **Emotional progression protection** — is apparent repetition actually necessary escalation, contrast or rhythm? If yes, KEEP.
8. **Ending discipline** — does the ending land once, or keep explaining after the emotional conclusion?

Duration policy (editorial triggers, not rejection thresholds):

- 6–9 minutes: preferred natural range.
- > ~9 minutes: mandatory explicit compression review
  (`projects/<EP>/compression-review.md`).
- > ~10 minutes: a written justification for the remaining length is required
  in the compression review.
- Longer episodes are allowed if the structure earns the duration. Never
  optimize for duration at the expense of clarity or emotional pacing.

Findings are classified `A — CLEAR REDUNDANCY`, `B — POSSIBLE COMPRESSION`,
`C — KEEP (length editorially justified)`, with recommendations
`KEEP / TIGHTEN / CUT / MERGE` and estimated words saved. The human approves
the COMPRESSED English script; the compressed text is what gets frozen.

## 3. Stable Production Rules

| Rule | Meaning |
| --- | --- |
| Narration Block ≠ Visual Shot | A narration block is a semantic/TTS unit. One block may contain one or more visual shots; a single calm visual may cover a whole passage (§6.4). |
| Audio is the master timeline | Cached narration audio remains continuous. Visual shot boundaries must never cut, seek, slice or independently mux narration audio. |
| Visuals form an arc | Do not illustrate every sentence literally. The shots within a block should collectively express its mood, idea or progression. Narration carries meaning; visuals may primarily provide atmosphere, emotion, pacing, continuity, or simply stay out of the way of the narration (§6.4). |
| Editorial function before visual intent | Every sourcing slot carries an `editorialFunction` describing the shot's job within the surrounding sequence — not a paraphrase of the narration. Narration meaning and visual function are related but not identical. |
| Sequence-level literalness check | Slots are reviewed as a sequence, not only as independent semantic matches. Several consecutive shots that each literally illustrate a narration keyword make the video an illustrated transcript. Redesign such runs toward atmosphere, observation, scale change or breathing room. Literal visuals themselves are not banned; semantic visual scarcity can create emphasis when a deliberately narration-matched visual appears against mostly atmospheric continuity (§6.4). |
| Visual review before approval | No production asset is approved solely from textual metadata when a visual preview is available. Candidates pass through a contact sheet / visual preview gate (Section 8). |
| Video first | Prefer suitable stock video. Use still photos with static (default) or explicitly requested slow-push motion when video is weak or unavailable. Low-semantic-load ambient visuals (landscape, ocean, clouds, forest, rain, night city, window views, slow travel footage, space/cosmic imagery, abstract light/motion — examples only, not a house style) are explicitly valid sourcing targets (§6.4). |
| Avoid stock-actor overload | Mix people, environments, objects, movement, architecture, landscapes and atmospheric shots. Prefer natural behavior, backs/silhouettes/hands/spaces when appropriate. |
| Sourcing slot = visual shot | A selected sourcing slot normally maps to one visual shot and one use of its source asset. Do not duplicate or loop an asset merely to satisfy a pre-existing placeholder shot count. If more visual changes are editorially needed, source additional assets instead. Sourcing-slot count is editorial, not mechanical: fewer slots with longer atmospheric holds are valid (§6.4, §7.3). |
| Adjacent reuse | Do not repeat the same source asset in adjacent shots. Reuse only when justified and preferably separated in time (Section 7.2). |
| Placeholder plan is not authoritative | The placeholder visual-plan shot count must not constrain the final real-asset timeline once real editorial sourcing exists (Section 7.1). |
| Fit is judged on actual media duration | Use ffprobe duration, never rounded provenance metadata, when deciding whether a source can cover its shot; otherwise raise INSUFFICIENT_SOURCE (Section 7.2). |
| Provenance is mandatory | Every external asset must retain source, creator, license, license URL, retrieval/download time, original filename and integrity metadata when downloaded. |
| Search before download | Candidate discovery stores metadata and previews only. Download occurs only after editorial selection. |
| Engineering and editorial work are separate | Chat/LLM decides meaning, visual intent and selection. Video Factory executes deterministic production. |
| Small checkpoints | Develop or change the pipeline in small, reviewable steps. Use short prototypes before full-episode renders. |

## 4. Current Defaults (Changeable)

| Setting | Current default |
| --- | --- |
| Voice | en-GB-RyanNeural |
| Speech rate | -12% |
| Pitch | 0 Hz |
| Output | 1920×1080, 30 fps, H.264 + AAC |
| Visual rhythm | roughly 7–10 seconds per shot as a pacing guideline, never a requirement to cut; an atmospheric visual may hold substantially longer (§6.4, §7.3) |
| Source priority | Pexels video → Pexels photo → other approved sources / owned assets |
| Subtitle direction | visually secondary: white text, thin dark outline/shadow, maximum 2 lines, lower safe area; avoid a large opaque black panel |
| Subtitle timing | Edge TTS WordBoundary (`temp/<sentenceId>.words.json`) decides WHEN text is spoken; semantic segmentation decides only grouping. New-generation ESSY requires word timing (manifest `subtitleTiming.policy`); legacy char-proportional timing is an explicit, reported fallback — never production-grade |
| Transitions | hard cuts are acceptable by default; do not add complex transitions without a demonstrated need |
| Motion for stills | STATIC is the default. Motion requires explicit editorial justification via metadata `stillMotion: "slow-push"`. No automatic alternating Ken Burns. "Calm frame, meaningful motion." |

## 5. Episode Workflow

A. Script — Create/review the complete essay. Keep a human/LLM-readable `script.md` as the canonical creative source.

B. Narration blocks — Assign stable IDs N001…Nxxx. Blocks should be semantic units suitable for TTS and discussion.

C. TTS — Generate/cache narration per block. TTS cache keys must depend on narration/voice parameters, not visuals.

D. Visual arc — For each block, describe the visual progression in one concise phrase or sequence.

E. Visual slots — Narration/audio duration determines the total available visual timeline for the block; editorial intent alone determines whether and where visual cuts / sourcing slots are needed within that timeline. Split the block into as many slots as the editorial intent requires — never by mechanical 7–10 second division. A single calm visual may cover a whole passage (§6.4). After selection, the approved slots define the final visual shots; the placeholder count does not persist into rendering (Section 7).

F. Editorial function — For each slot, define an `editorialFunction`: what editorial job does this shot perform within the surrounding sequence? It must describe the shot's function, not merely paraphrase the narration.

G. Visual intent + avoid list — For each slot, define a `visualIntent` and an `avoid` list of imagery to steer away from (especially the obvious literal representations that adjacent slots already provide).

H. Sequence literalness check — Review the block's slots as a sequence. Redesign runs of consecutive keyword-illustrating shots before searching (Section 6).

I. Search plan — Only now define concise search queries per slot. Prefer video candidates and retain photo fallbacks.

J. Candidate search — Search approved providers and store candidate metadata with preview URLs. Do not download.

K. Contact sheet / editorial selection — Review candidates visually via contact sheet or preview, comparing relevance, naturalness, visual variety, duration, resolution and unintended symbolism. Select assets explicitly. Never approve solely from textual metadata when a preview is available.

L. Download + provenance — Download selected assets only. Record hashes, file size, local path and licensing/provenance.

M. Prototype when needed — For a new style or pipeline change, render only a short range (for example 60–90 seconds) before the full episode.

N. Full render — Render visuals against continuous block audio, subtitles and BGM. Visual changes must not affect narration continuity.

O. QA — Run automated technical QA, then human viewing QA for rhythm, voice, subtitles, asset quality and editorial coherence. Work through the episode's final-assembly QA checklist (for example `projects/ESSY-0001/final-assembly.md`).

P. Targeted revision if necessary — If review finds problems, revise only the affected slots and freeze unaffected shots.

## 6. Visual Planning Rules

For each narration block, create a small visual arc rather than a list of literal illustrations.

Example:

```text
N002 — Possibilities / expanding world
S1: train window landscape journey
S2: traveler walking through airport terminal
S3: open road toward mountains / horizon

Arc: movement → possibility → openness
```

A good arc can move from person → environment → movement, or detail → person → wide shot. Avoid three nearly identical city shots, three desk shots, or three rain-window shots unless repetition is intentional.

### 6.1 Editorial Function (required per slot)

Visual sourcing follows this layer order:

```text
Narration → Visual Arc → Visual Slot → Editorial Function → Visual Intent → Search Query
```

For every sourcing slot, define an `editorialFunction` that answers:

> What editorial job does this shot perform within the surrounding sequence?

It must describe the shot's function in the sequence, not paraphrase the narration. Narration meaning and visual function are related but not identical.

Examples of editorial functions:

- establish the pressure of modern life to keep progressing
- bridge from physical accumulation to the feeling that ordinary life quietly accumulates over years
- move from an environmental/social scale to an individual scale
- provide a quiet pause after a visually dense sequence
- transition from literal observation to emotional implication

### 6.2 Visual Intent + Avoid List

A `visualIntent` must not be a visual paraphrase of narration keywords. Pair it with an `avoid` list naming the imagery to steer away from — especially the obvious literal representations that adjacent slots already provide.

```json
{
  "slotId": "N006-S2",
  "narrationId": "N006",
  "editorialFunction":
    "Bridge from physical accumulation to the sense that ordinary life quietly accumulates over years.",
  "visualIntent":
    "A lived-in domestic environment showing traces of years of ordinary life.",
  "avoid": [
    "drawer",
    "shelf",
    "cabinet",
    "storage box",
    "generic clutter"
  ],
  "query":
    "old home interior everyday life quiet afternoon",
  "preferredMediaType": "video",
  "targetDurationSec": 8
}
```

The avoid list is most useful when neighboring shots already supply the obvious literal representation of the narration keyword.

### 6.3 Sequence-Level Literalness Check (mandatory before search)

Core heuristic:

> One literal shot can establish an idea. Several consecutive literal shots can turn the video into an illustrated transcript.

Inspect slots as a SEQUENCE, not only as independent semantic matches. Detect patterns such as:

```text
money/chart → multitasking worker → phone → books → planner
```

Even if every individual shot is semantically relevant, the sequence may still be too literal — a mechanical narration-keyword → stock-image montage. When several consecutive shots each independently illustrate a narration keyword, redesign some slots around:

- atmosphere
- human observation
- environmental storytelling
- movement
- visual metaphor
- transition
- scale change
- quiet visual breathing room

Do NOT ban literal visuals. A literal visual remains valuable when it establishes an idea clearly; the goal is to avoid consecutive mechanical sentence-to-image translation. List-shaped narration ("More income. More productivity. More followers...") deserves particular scrutiny because it naturally encourages keyword-by-keyword illustration. Conversely, when most visuals are atmospheric / low-semantic-load, a single deliberately narration-matched visual gains emphasis precisely through semantic scarcity (§6.4).

### 6.4 Visual Editorial Principles (canonical, ESSY-0004+)

No separate "Standard vs Cinematic" pipeline or production mode is created.
The existing `editorialFunction` / `visualIntent` / `avoid` model already
expresses these choices. Atmospheric / low-semantic-load visual continuity
is a first-class editorial choice alongside semantic visuals — not a
replacement for them. Semantic sourcing, literal visuals, and visual arcs
all remain available.

1. **Narration carries meaning.** Visuals do not need to explain every
   sentence. A visual may primarily provide atmosphere, emotion, pacing,
   continuity, or simply stay out of the way of the narration.
2. **Mood match is sufficient by default.** Do not require semantic
   matching for every visual. Reserve strongly semantic / literal visuals
   for moments where they add editorial value, such as thesis statements,
   turning points, concrete examples, or deliberate emphasis. Mood match
   does NOT mean generic repetitive queries: variety and selection
   criteria (§9) and the §14 lesson on generic-mood drift still apply.
3. **"Stay out of the way" is a legitimate editorial function.** A visual
   can be successful precisely because it does not demand interpretation
   or compete with narration. Example `editorialFunction`: "Provide quiet
   visual continuity while the narration carries the idea."
4. **Visual breathing room is intentional.** A suitable atmospheric visual
   may remain on screen substantially longer than the nominal 7–10 second
   rhythm. 7–10 seconds remains a useful pacing guideline, NOT a
   requirement to create another sourcing slot or visual cut.
5. **Semantic scarcity creates emphasis.** If most visuals are atmospheric
   / low-semantic-load, a deliberately narration-matched visual becomes
   more meaningful when it appears.
6. **Subtitle changes contribute to visual rhythm.** When evaluating
   whether a sequence feels visually static, consider subtitle/typography
   changes together with background motion and shot changes. Do NOT make
   normal ESSY subtitles oversized in response: current subtitle
   readability and visually-secondary principles (Section 4) remain.
7. **Prefer the simplest visual treatment that sustains attention.** Do
   not source, animate, transition, or illustrate merely because the
   pipeline supports it. If one calm visual can support a passage
   effectively, unnecessary visual cuts are not an improvement.
8. **Low-semantic-load ambient visuals are explicitly valid.** Examples
   may include landscape, ocean, clouds, forest, rain, night city, window
   views, slow travel footage, space/cosmic imagery, or abstract
   light/motion. These are examples, not a prescribed ESSY visual style.

Conceptual example (illustrative shape of the model, not a new schema):

```json
{
  "editorialFunction":
    "Provide quiet visual continuity while the narration carries the idea.",
  "visualIntent":
    "Slow-moving atmospheric imagery with low semantic specificity.",
  "avoid": [
    "literal illustration of narration",
    "dramatic human action",
    "visually dense composition",
    "distracting text/signage",
    "imagery that demands interpretation"
  ]
}

## 7. Real-Asset Timeline Rules

Stable rules promoted after the verified ESSY-0001 N001–N003 real-asset prototype (`output/ESSY-0001/prototype-N001-N003.mp4`, reviewed 2026-08-25).

### 7.1 Placeholder Visual Plan vs Real-Asset Timeline

- PLACEHOLDER VISUAL PLAN = pre-sourcing planning / rhythm prototype. It was useful for validating approximate visual rhythm before real sourcing existed.
- REAL-ASSET TIMELINE = production timeline derived after editorial sourcing.

The real-asset timeline supersedes the placeholder plan for actual shot count and asset allocation. The placeholder plan must NOT constrain the final real-asset timeline; keep it as historical/audit information, not as a rendering requirement.

Rationale: the final timeline derives from narration timing + approved sourcing slots + actual source-media duration + editorial pacing — not from forcing selected assets into an old placeholder shot count.

### 7.2 Source Reuse Policy

DEFAULT:

- one selected sourcing slot → one visual shot;
- one source asset → one use within that shot;
- render feasibility is judged against actual ffprobe media duration.

PROHIBITED BY DEFAULT:

- silent source looping;
- duplicating a source just to increase shot count;
- overlapping source-time ranges;
- visually recognizable repeated footage;
- using rounded provenance duration instead of actual media duration when deciding whether a source fits.

If a source cannot cover the required visual duration, DO NOT silently loop it. Surface `INSUFFICIENT_SOURCE` and require one of:

1. adjust shot duration,
2. use another already-approved asset,
3. source an additional asset,
4. obtain explicit editorial approval for reuse.

If editorially approved reuse is ever necessary, the reused source ranges must be demonstrably distinct and non-overlapping. Reuse is an exception, not the normal production strategy.

Verified origin: the first N001–N003 prototype cycled three N002 slots across six placeholder shots (S1→S2→S3→S1→S2→S3) with a fixed offset step, producing contained/overlapping source ranges and recognizable repeated footage around 36 s / 42 s. Mapping every selected slot to exactly one shot removed the defect.

### 7.3 Shot-Duration Policy

Narration remains the master timeline. Within each narration block:

1. Determine the block's actual duration from the narration/audio timeline.
2. Determine how many approved sourcing slots belong to that block.
3. Distribute the visual duration approximately evenly across those slots by default.
4. Respect actual source-media duration.
5. Prefer approximately 7–10 seconds per visual as a pacing guideline for the current ESSY editorial style, but never as a requirement to cut or to source another slot. A suitable atmospheric visual may hold substantially longer (§6.4).
6. Do not manufacture extra visual cuts solely to reach a target shot count. Prefer the simplest visual treatment that sustains attention.

If the prose or editorial intent benefits from a different rhythm, editorial intent wins over the nominal 7–10 s guideline.

### 7.4 Narration / Subtitle Independence

Narration is continuous and must not be segmented or regenerated merely because visual shot boundaries change. Visual shot boundaries and narration boundaries are independent.

When visual shot boundaries change:

- preserve cached TTS,
- preserve narration timing,
- re-slice subtitle cues onto the new visual windows,
- do not regenerate narration.

`pauseAfterSec` remains part of the narration/block timeline. Subtitles must not extend into intentional trailing narration pauses.

## 8. Search and Candidate Contract

Candidate search should be deterministic and non-destructive. Search results are metadata, not approved assets. For each slot, a useful default is 3 video candidates plus 2 photo fallbacks.

Candidate metadata should include: `slotId`, `narrationId`, `editorialFunction`, `visualIntent`, `avoid`, `searchQuery`, `provider`, `assetId`, `mediaType`, `sourceUrl`, `previewUrl`, `creator`, `creatorUrl`, `license`, `licenseUrl`, `durationSec` (video), `width`, `height`, `orientation`, `selectionStatus`, `downloadedAt` (null until downloaded).

### 8.1 Contact-Sheet / Visual Preview Approval Gate

Preferred candidate workflow:

```text
Candidate Search → Candidate Metadata → Contact Sheet / Visual Preview
→ Editorial Visual Approval → Download → Provenance → Production
```

Stable rule: **No production asset should be approved solely from textual metadata when a visual preview is available.**

Candidate search should generate or preserve preview URLs and, where practical, produce a contact sheet for editorial comparison. The contact sheet must display enough information to identify each candidate, at minimum:

- slot
- candidate ID
- media type
- preview
- duration/resolution where applicable

Textual descriptions are useful for filtering but do not substitute for visual review.

## 9. Selection Criteria

- Does the asset support the block's visual arc — or, where editorially intended, provide quiet atmospheric continuity / breathing room while the narration carries the idea (§6.4) — rather than merely match a keyword?
- Does it feel natural, or like an obvious staged stock advertisement?
- Does it add variety relative to the shots immediately before and after it?
- Is the motion useful at the intended viewing duration (nominal 7–10 s guideline, or a longer intentional atmospheric hold per §6.4)?
- Is the resolution sufficient for 1080p output? Prefer higher-resolution sources when a 720p variant looks soft.
- Does the asset contain distracting logos, text, faces acting unnaturally, or visual details that shift attention away from the narration?
- Does the visual introduce unintended meaning or symbolism that competes with the narration?
- Can the asset be used under the recorded license and provenance terms?

On unintended symbolism: common stock elements carry secondary meanings — a luxury car (wealth/status/consumption), a luxury home (wealth), corporate success imagery (ambition/status), a phone (social media/addiction), an isolated elderly person (loneliness/mortality), a sunset (ending/aging/death). These elements are NOT prohibited. The editorial reviewer must notice the secondary meaning and decide whether it supports or distracts from the shot's intended editorial function.

## 10. Audio / Visual Timeline Contract

```text
CORRECT
continuous block TTS  ---------------------------------------->
video                | shot A | shot B | shot C | shot D |
subtitles             follow original narration timing

INCORRECT
shot A + sliced audio | shot B + sliced audio | shot C + sliced audio
```

`pauseAfterSec` may extend the final visual shot, but subtitles must end with spoken narration and must not remain visible during the trailing pause.

## 11. Division of Responsibility

| Task | Chat / editorial AI | Video Factory / coding agent |
| --- | --- | --- |
| Understand complete script | Primary | No |
| Narration block design | Primary | Validate/consume |
| Visual arcs & slots | Primary | Consume |
| Search queries | Primary | Execute API search |
| Contact sheet / visual previews | Specify requirements | Generate when practical |
| Candidate comparison & selection | Primary | No autonomous editorial choice unless asked |
| Download selected assets | Approve | Primary |
| License/provenance persistence | Specify/review | Primary |
| FFmpeg/rendering | No | Primary |
| Automated QA | Review result | Primary |
| Human viewing QA | Primary | Support with metrics |

## 12. Required Outputs from a New Chat

When this playbook and a new script are supplied to a fresh conversation, the AI should first return a visual search plan for approval, not code and not downloaded assets.

Recommended planning record:

```json
{
  "slotId": "N004-S1",
  "narrationId": "N004",
  "editorialFunction": "Establish the material pressure of keeping up before widening to the human cost.",
  "visualIntent": "possessions gradually accumulating in a home",
  "avoid": ["generic clutter close-up", "stacked storage boxes"],
  "query": "cluttered home shelves possessions slow pan",
  "preferredMediaType": "video",
  "targetDurationSec": 8
}
```

The plan must include the editorial function and avoid list per slot, and must be the output of the sequence-level literalness review, not just per-slot keyword matching.

## 13. New-Conversation Starter Prompt

You are helping produce an episode for the reflective YouTube essay series ESSY.

Treat the attached ESSY Video Production Playbook as the production and editorial contract.

Read the complete script first. Then:

1. Verify or create stable narration blocks.
2. Create a coherent visual arc for each narration block.
3. Divide blocks into visual slots where editorially needed (roughly 7–10 seconds per visual is a pacing guideline, NOT a requirement to cut; an atmospheric visual may hold substantially longer — §6.4).
4. Assign an `editorialFunction` for every slot: the editorial job the shot performs within the surrounding sequence. Distinguish this from the literal meaning of the narration — narration meaning and visual function are related but not identical.
5. Create a `visualIntent` plus an `avoid` list for each slot; the avoid list should name the obvious literal representations that adjacent slots already provide.
6. Inspect adjacent slots and run the sequence-level literalness review across each block before generating any query. Redesign runs of consecutive keyword-illustrating shots toward atmosphere, observation, movement, scale change or breathing room. Do not ban literal visuals; avoid consecutive mechanical translation.
7. Only after those steps, generate video-first search intents/queries for each slot.
8. Present the visual search plan (including editorial functions and avoid lists) for approval before any download or engineering work.
9. When candidates are later provided, evaluate them visually using contact sheets or previews. Never approve solely from textual candidate descriptions when visual previews are available.
10. Keep narration audio continuous; visual boundaries must never alter audio.
11. Avoid repetitive stock-actor footage and adjacent reuse.
12. Preserve narration continuity and do not redesign the renderer unless explicitly requested.

## 14. ESSY-0001 Lessons Captured So Far

- 18 semantic narration blocks worked as TTS units for a ~7:49 episode.
- A 59-shot visual plan produced a workable visual rhythm; increasing shot count further was not necessary before testing real assets.
- en-GB-RyanNeural at -12% remained comfortable over the full episode and is the current voice default.
- Real Pexels video materially improved the prototype compared with gradient placeholders.
- Visual sourcing quality depends strongly on visual-arc design; generic mood queries can drift away from narration and become repetitive.
- A prototype exposed an audio-continuity bug when narration was sliced per visual shot. This established the stable rule that audio is the master timeline.
- Large black subtitle panels inherited from language-learning formats are unsuitable for ESSY; subtitles should be visually secondary.
- Short prototypes and small agent checkpoints are preferable to large closed-loop coding tasks.
- Cycling a small set of real assets across more placeholder shots produced recognizable repeated footage (~36 s / ~42 s in the N001–N003 prototype). This was resolved by letting sourcing slots define the shots (one asset, one use, no looping) and promoted to the stable rules in Section 7.
- Per-episode final-assembly decisions (subtitle target style, BGM state, mix parameters, QA checklist) are recorded in the episode Final Assembly Spec, e.g. `projects/ESSY-0001/final-assembly.md`.
- The final visual review of ESSY-0001 found that technically relevant stock footage could still create a mechanical narration-keyword → stock-image pattern (e.g. income → financial metrics, followers → phone/social imagery, physical accumulation → consecutive storage/clutter shots). "Do not illustrate every sentence literally" was directionally correct but not operationally sufficient.
- Three slots (N006-S2, N009-S1, N009-S3) were selected for a targeted sourcing-v2 visual revision rather than reopening the entire 60-shot episode; unaffected shots were frozen. Small slot-level revision is preferred over reopening already-good shots.
- The sourcing-v2 method introduced explicit `editorialFunction` reasoning before `visualIntent` and search-query generation, producing more environmental/observational alternatives instead of direct keyword illustrations. These lessons are promoted to the stable rules in Sections 1, 3, 5, 6, 8, 9 and 13.
- Candidate metadata alone proved insufficient for final editorial selection: visual preview/contact-sheet review exposed mismatches that textual descriptions did not reveal, including generic imagery and unintended status symbolism. Contact-sheet review is therefore part of the normal approval workflow whenever previews are available.

## 15. Change Control

Stable rules should change only after an observed production problem or a deliberate editorial decision. Current defaults may evolve episode by episode. When the workflow materially changes, increment this playbook version and keep it in Git with the Video Factory repository.

v1.1 (2026-08-25): promoted the real-asset timeline rules verified on the ESSY-0001 N001–N003 prototype — sourcing slots define shots; placeholder plan superseded; source-reuse policy; shot-duration policy; narration/subtitle independence (Section 7).

v1.2 (2026-08-30): promoted the ESSY-0001 sourcing-v2 editorial lessons into stable rules — required `editorialFunction` layer per slot (Section 6.1); `visualIntent` + `avoid` list contract (Section 6.2); mandatory sequence-level literalness check before search (Section 6.3); contact-sheet/visual-preview approval gate (Section 8.1); unintended-symbolism review in selection criteria (Section 9); targeted slot-level revision with frozen unaffected shots (Sections 1, 5, 14).

v1.3 (P1 still-image motion): STATIC is the default still treatment; motion requires explicit `stillMotion: "slow-push"` metadata and is never chosen from shot-index parity. No automatic alternating Ken Burns. "Calm frame, meaningful motion." Applies to ESSY-0004+ and newly-rendered episodes only — published ESSY-0001/0002/0003 are frozen baselines and are not guaranteed to reproduce their historical behavior if rebuilt with these defaults (not bit-exact backward compatibility; do not rerender).

v1.4 (P1 script compression): canonical Script Compression Pass before English approval (Section 2.1) — 8 density checks, KEEP-protection for emotional progression, 6–9 min preferred range, >9 min mandatory compression review, >10 min written justification, no hard cap. Evidence: retrospective audits of ESSY-0001–0003 (projects/<EP>/compression-review.md).

v1.5 (visual editorial principles, ESSY-0004+): §6.4 canonical principles — narration carries meaning; mood match sufficient by default; "stay out of the way" as legitimate editorial function; intentional breathing room (7–10 s guideline, never a cut requirement); semantic scarcity creates emphasis; subtitle changes count toward visual rhythm (subtitles stay visually secondary, no oversizing); simplest treatment that sustains attention; low-semantic-load ambient visuals explicitly valid (examples, not a house style). Relaxed/clarified: §1.5, §3 arc/literalness/slot rows, §4 rhythm, §5.E, §6.3, §7.3.5–6, §9 motion criterion, §13.3. No new pipeline/mode; existing editorialFunction/visualIntent/avoid model expresses these choices. Semantic sourcing, literal visuals, and visual arcs remain available.

Suggested repository path: `docs/ESSY_VIDEO_PRODUCTION_PLAYBOOK.md`
