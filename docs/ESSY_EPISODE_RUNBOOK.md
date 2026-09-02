# ESSY Episode Runbook (end-to-end)

Canonical, minimal path from a raw script to a finished 1080p master.
This is the exact path proven by ESSY-0001 and ESSY-0002. Editorial rules
live in `docs/ESSY_VIDEO_PRODUCTION_PLAYBOOK.md` (authoritative for
editorial/sourcing decisions); renderer mechanics live in
`docs/production-lifecycle.md`. This document is the step-by-step sequence
and the single entry point for "make a new ESSY episode from scratch".

## Stage 0 — Creative (per Playbook, human-approved)

1. Split the approved script into semantic narration blocks (N001, N002, ...).
2. Design a visual arc per block; split into sourcing slots (~7–10 s each),
   each with `editorialFunction`, `visualIntent` and an `avoid` list.
3. Run the sequence-level literalness check BEFORE generating search queries.
4. Search Pexels (video-first), review candidates via contact sheet, select.
   Generic helpers: `scripts/search-pexels.mjs`, `scripts/download-selected-pexels.mjs`
   (episode-specific one-offs are kept in `scripts/oneoff/` for reference only).
5. Record decisions in `projects/<EP>/final-assembly.md` (subtitle style, BGM
   state, mix params, QA checklist) and `projects/<EP>/script.md`.

Gate: user approves script + selections. Story/English/images are frozen
from here on.

## Stage 1 — Renderer inputs

```bash
node scripts/prepare-essy-real-input.mjs <EPISODE>   # builds inbox/<EP>/lesson.json
pnpm video:render <EPISODE>                          # TTS+VTT, visual plan, shot renders
```

Artifacts: `projects/<EP>/audio/*.mp3`, `temp/*.vtt` (authoritative timing),
`projects/<EP>/visual-plan.json`, `projects/<EP>/segments/*.mp4`.

## Stage 2 — Subtitled 540p review (mandatory gate)

```bash
pnpm video:subtitle-review <EPISODE>
```

Renders a continuous 540p burn-in proxy. Aborts on subtitle QA failure
(overlaps, orphans, <700 ms cues, >2 lines — see `scripts/subtitle-config.mjs`).
Human QA reviews the proxy; record approval with
`pnpm video:workflow approve <EPISODE> qa` (workflow must be registered;
do NOT register retroactively).

## Stage 3 — Final assembly (1080p master)

```bash
pnpm video:build-narration-master <EPISODE>          # continuous narration master
pnpm video:build-bgm <EPISODE>                       # extended BGM master (optional)
pnpm video:render-final <EPISODE> --label v1         # final-assembly.json required
```

`render-essay-final.mjs` applies cold-open title, ending hold + end card,
BGM mix-at-time, and the shared subtitle pipeline with its QA gate. It is
shot-incremental: `--only=N001-S1,N002-S3` re-renders just those shots.
Verify a re-render by extracting frames and matching them against cue
windows in `projects/<EP>/temp/<EP>-subtitles.srt`.

Output: `output/<EP>/<EP>-final-v1.mp4`. Keep exactly ONE final master;
delete superseded labels to avoid shipping stale subtitles.

Output hygiene: `output/<EP>/` holds final deliverables (and review proxies)
only. QA screenshots and render diagnostics go to
`projects/<EP>/logs/qa-screens/`.

Final QA gate: a rendered final MP4 does NOT complete the episode. After
frame-verifying the master against `projects/<EP>/temp/<EP>-subtitles.srt`,
record the human sign-off:

```bash
pnpm video:workflow approve <EPISODE> final-assembly
```

The renderer itself keeps the workflow at stage `final-assembly` and records a
`final-render-succeeded` history event (and invalidates any earlier
final-assembly approval when a new label is rendered), so workflow state can
never run ahead of the artifacts.

## Stage 4 — Done

Final-assembly approval (`approve <EP> final-assembly`) completes the episode.
Archival is never automatic and never inferable from production state:
`pnpm video:workflow archive <EPISODE> --published` only after the user
confirms EXTERNAL publication.

## Hard rules (recap)

- Audio is the master timeline; never slice narration per shot.
- Subtitle timing comes only from TTS VTT, never from shot boundaries.
- Subtitles always use the shared timeline builder + QA gate.
- Never modify approved story/English/images during rendering.
- One current stage at a time; workflow.json must never disagree with reality.
