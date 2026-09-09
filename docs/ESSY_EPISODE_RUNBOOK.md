# ESSY Episode Runbook (single entry point)

> **This is the single entry point for producing an ESSY episode.**
> Runbook = WHAT / WHEN / WHO. Editorial HOW/WHY lives in
> `docs/ESSY_VIDEO_PRODUCTION_PLAYBOOK.md` (authoritative for
> editorial/sourcing decisions); renderer mechanics live in
> `docs/production-lifecycle.md`. This document states the phase sequence,
> ownership, and approval gates — not the detailed editorial rules.
>
> Any AI (ChatGPT / Codex) starting or continuing an ESSY episode:
>
> 1. Read this Runbook first.
> 2. Determine the current Phase and Gate state from repository state —
>    repository state is canonical truth; do not rely on chat memory.
> 3. Read the Playbook sections referenced for that Phase.
> 4. Determine the next artifact / action.
> 5. Do not skip approval gates.

## Canonical 5-phase workflow

```text
WRITE → PREPARE → DIRECT → BUILD → FINALIZE
```

| Phase | Owner | Gate out |
| --- | --- | --- |
| 1. WRITE | ChatGPT + Human | Gate 1 — Script approval |
| 2. PREPARE | Codex / Video Factory | (none — hands timing to DIRECT) |
| 3. DIRECT | ChatGPT directs / Codex executes / Human selects | Gate 2 — Visual selection approval |
| 4. BUILD | Codex / Video Factory | Gate 3 — Review approval |
| 5. FINALIZE | Codex / Video Factory + Human | Gate 4 — Final approval → DONE |

## PHASE 1 — WRITE

- **Owner:** ChatGPT conversation + Human.
- **Input:** episode idea / raw draft.
- **Main work:** Idea → English Draft → Compression Pass → Narration Blocks.
  Follow the Playbook Script Compression Pass (§2.1): record it in
  `projects/<EP>/compression-review.md` — mandatory when the draft exceeds
  ~9 min; a written length justification is required above ~10 min. No hard
  duration cap. Split the approved script into semantic narration blocks
  with stable IDs (N001, N002, ...).
- **Visual-only text contract:** text that is NOT narration (e.g. series
  title `"A Second Look at Life"`, episode card `"Who Am I Beyond My
  Roles?"`) must be explicitly separated from narration with
  machine-readable semantics, e.g. `tts: false` + `role: title`. Never rely
  on Codex inferring TTS-eligibility from Markdown formatting.
- **Output:** approved English narration + narration blocks
  (`projects/<EP>/script.md`, `projects/<EP>/compression-review.md`).
- **Gate 1 — SCRIPT APPROVAL:** human approves the COMPRESSED English
  script. After approval, Codex and the pipeline must not rewrite narration.
- **Next:** PREPARE.

## PHASE 2 — PREPARE

- **Owner:** Codex / Video Factory.
- **Input:** approved script + narration blocks.
- **Main work:** create episode production artifacts; generate/cache TTS per
  block; generate WordBoundary timing in the SAME synthesis session as the
  audio (`scripts/generate-essy-tts.py`); determine actual narration
  duration per block; subtitle timing preparation (`temp/*.vtt` block parent
  windows, `temp/<sentenceId>.words.json` canonical timing).
- **Output:** narration timing artifacts ready for editorial planning
  (`projects/<EP>/audio/*.mp3`, timing files).
- **Invariant: Audio is the master timeline.** Visual shot count must NOT be
  fixed before actual narration durations are known.
- **Next:** hand each Nxxx's actual duration / timing back to DIRECT.

## PHASE 3 — DIRECT

- **Owner:** ChatGPT = editorial direction; Codex = sourcing/search
  execution; Human = selection approval.
- **Input:** complete script + actual audio timing from PREPARE.
- **Main work (ChatGPT):** Visual Arc → Visual Slots (where editorially
  needed; ~7–10 s is a pacing guideline, never a quota — Playbook §6.4) →
  `editorialFunction` → `visualIntent` → `avoid` → sequence-level
  literalness check → search queries. Follow the Playbook (§§6–9). Never
  pre-fix a shot count.
- **Execution (Codex):** candidate search (video-first), preview / contact
  sheet generation, candidate metadata. **Search ≠ selection ≠ download.**
  Candidates must pass visual review before download — never approve solely
  from textual metadata when a preview is available.
- **Output:** human-approved asset selections.
- **Gate 2 — VISUAL SELECTION APPROVAL:** only approved assets proceed to
  download.
- **Next:** BUILD.

## PHASE 4 — BUILD

- **Owner:** Codex / Video Factory.
- **Input:** approved script + approved asset selections.
- **Main work:** download approved assets only → provenance → real-asset
  timeline → subtitles → BGM → render → automated technical QA → review
  proxy.
- **Commands (reference):**
  `prepare-essy-real-input` (builds `inbox/<EP>/lesson.json`),
  `video:render` (visual plan + shot renders),
  `video:subtitle-review` (continuous 540p burn-in proxy).
- **Invariants (preserved):** audio is the master timeline — never slice
  narration per shot; sourcing slot = visual shot; no silent source looping;
  fit judged on actual ffprobe duration; subtitle cues timed by WordBoundary
  data (`speechStart`/`speechEnd`), never shot boundaries — missing/mismatched
  word timing FAILS subtitle QA (`subtitleTiming.policy =
  "word-boundary-required"`; legacy loads warn explicitly, never silently);
  shared subtitle timeline builder + QA gate; still-image motion STATIC by
  default, `stillMotion: "slow-push"` only with explicit justification
  (absence = static; never infer from shot order); approved
  story/English/images frozen — never modified during rendering; episode
  one-offs stay in `scripts/oneoff/` (reference only); `final-assembly.md`
  records subtitle style, BGM state, mix params, QA checklist.
- **Output:** review-quality proxy.
- **Gate 3 — REVIEW APPROVAL:** human reviews the proxy; record with
  `pnpm video:workflow approve <EPISODE> qa` (workflow must be registered;
  do NOT register retroactively).
- **Targeted revision:** on review issues, revise only affected slots and
  freeze unaffected shots. Do not redesign the renderer or re-source the
  whole episode for a local editorial problem.
- **Next:** FINALIZE.

## PHASE 5 — FINALIZE

- **Owner:** Codex / Video Factory + Human.
- **Input:** review-approved episode.
- **Main work:** final 1080p assembly → final technical QA → human viewing
  QA (frame-verify against `projects/<EP>/temp/<EP>-subtitles.srt`) → final
  sign-off.
- **Commands (reference):** `video:build-narration-master` (continuous
  narration master), `video:build-bgm` (extended BGM master, optional),
  `video:render-final <EPISODE> --label v1` (`final-assembly.json`
  required; shot-incremental via `--only=`).
- **Deliverable hygiene:** `output/<EP>/` holds final deliverables (and
  review proxies) only — keep exactly ONE final master, delete superseded
  labels; QA screenshots / render diagnostics go to
  `projects/<EP>/logs/qa-screens/`.
- **Gate 4 — FINAL APPROVAL:** a rendered final MP4 does NOT complete the
  episode. Record the human sign-off with
  `pnpm video:workflow approve <EPISODE> final-assembly`. The renderer keeps
  the workflow at `final-assembly` with a `final-render-succeeded` history
  event (a new label invalidates earlier approval), so workflow state never
  runs ahead of artifacts. Approval completes the episode (state = DONE).
- **Archival (preserved):** never automatic, never inferable from production
  state — `pnpm video:workflow archive <EPISODE> --published` only after the
  user confirms EXTERNAL publication.

## Responsibility model

- **ChatGPT — THINK / WRITE / DIRECT / SELECT:** meaning, script,
  compression, narrative structure, visual arc, `editorialFunction`,
  `visualIntent`, literalness review, search strategy, editorial candidate
  evaluation.
- **Human — APPROVE (4 gates):** 1. Script · 2. Visual Selection ·
  3. Review · 4. Final.
- **Codex / Video Factory — BUILD / SEARCH / EXECUTE / VERIFY:** repository
  artifacts, TTS, WordBoundary, timing, search execution, contact sheets,
  downloads, provenance, ffprobe, timeline construction, subtitles,
  rendering, automated QA.
- **Core principle:** editorial judgment must not silently migrate into
  deterministic production code; deterministic engineering work must not
  depend on ChatGPT manually performing production operations.

## Post-episode learning loop

```text
Produce → Review → Learn → Promote reusable rule → Next episode reads improved rules
```

After each episode, ask: *"Did this episode reveal a reusable lesson that
should improve future ESSY episodes?"* Classify:

- **A. Episode-specific issue** → keep in `projects/<EP>/...`; do NOT
  promote.
- **B. Reusable editorial lesson** → update
  `docs/ESSY_VIDEO_PRODUCTION_PLAYBOOK.md`.
- **C. Reusable workflow / ownership / gate lesson** → update this Runbook.
- **D. Reusable implementation / technical lesson** → update the appropriate
  engineering documentation.

Do not promote one-off preferences into global rules without evidence —
but workflow ambiguity, data-contract ambiguity, approval ambiguity, or a
deterministic production defect should be considered for immediate
promotion.

## Hard rules (recap)

- Audio is the master timeline; never slice narration per shot.
- Subtitle timing comes from edge-tts WordBoundary artifacts
  (`temp/<sentenceId>.words.json`); VTT only provides block parent windows.
  Never from shot boundaries. Legacy char-proportional timing is an explicit,
  reported fallback — never production-grade.
- Subtitles always use the shared timeline builder + QA gate.
- Never modify approved story/English/images during rendering.
- Legacy baseline warning: ESSY-0001/0002/0003 are frozen PUBLISHED baselines.
  Rebuilding them with ESSY-0004+ renderer defaults (word-boundary subtitles,
  STATIC-default still motion, canonical narration master) is NOT guaranteed
  to reproduce their historical visual/subtitle behavior and is not treated
  as bit-exact backward compatibility. Do not rerender or retro-polish them.
- One current stage at a time; workflow.json must never disagree with reality.
