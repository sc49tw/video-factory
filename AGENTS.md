# Video Factory

This repository renders production videos from approved episode assets.

## Workflow

When the user says `開始影片`, `繼續影片`, or asks for production status:

1. Codex is the only creative entry point and workflow orchestrator.
2. Run `pnpm video:workflow start`, `continue`, or `status` to load the exact
   current stage from `projects/_drafts/<ID>/state.yaml`.
3. Codex completes only the current stage, writes and validates its artifact,
   then presents the result to the user.
4. The user only approves the next transition or requests a rollback. Never
   ask the user to operate a Chat handoff, edit JSON, or run CLI commands.
5. Never create a later-stage artifact before the current approval is stored.
6. `state.yaml` is the draft source of truth. Episode renderer gates continue
   to use `projects/<EPISODE>/workflow.json`.
7. Run `pnpm video:workflow discover` only for renderer inputs already in
   `inbox/` and not yet registered.
8. `inbox/<EPISODE>/` is the read-only renderer handoff area. In the new flow,
   Codex/pipeline creates it from an approved production package; it is no
   longer a Chat output inbox.
9. Preserve approved text and images exactly.
10. Run `pnpm video:render <EPISODE>` only after content and image gates pass.
11. Keep production files in `projects/<EPISODE>/` and final MP4 files in
    `output/<EPISODE>/`.
12. After render, review QA and record approval with
    `pnpm video:workflow approve <EPISODE> qa`.
12a. For ESSY episodes, the final 1080p master requires its own gate: after
    frame-verifying `output/<EP>/<EP>-final-v1.mp4`, record
    `pnpm video:workflow approve <EPISODE> final-assembly`. A rendered final
    MP4 alone never marks the episode completed.
13. Never auto-archive after QA. Completed episodes remain in place until the
    user confirms publication and explicitly approves archival.
14. Archive only with `pnpm video:workflow archive <EPISODE> --published`.

Never modify story, English, or images during rendering.

Never modify story, English, or images during rendering.

## ESSY subtitle architecture (shared, mandatory)

ESSY subtitles MUST use the shared subtitle timeline builder
(`scripts/_build-subtitle-timeline.mjs` + `scripts/subtitle-config.mjs`).
Do not implement subtitle splitting independently in render scripts, and do
not add text-specific exceptions for any episode.

Architecture:

- Source VTT timing (edge-tts) is authoritative; it is never re-estimated.
- Generated child cues preserve monotonic, absolute timing inside the parent
  narration window (char-weighted).
- Subtitle timing is independent of visual shot boundaries. The visual
  timeline must NEVER be used to derive subtitle cue boundaries.
- DP balanced segmentation with phrase-aware breakpoint scoring prevents
  widow/orphan cues (defaults: MAX_CHARS 44, MAX_LINES 2, no generated
  1-word orphans, strongly avoid generated 2-word children, no generated
  cue below 700 ms).
- Global non-overlap normalization guarantees one active cue at a time
  (deterministic 1 ms clamp; cue start times are preserved).
- Subtitle QA is a mandatory render gate: the review renderer aborts before
  ffmpeg if QA fails (`overlapCountAfterNormalization`, `invalidDurationCueCount`,
  `orphanChildCueCount`, `twoWordChildCueCount`,
  `generatedCueDurationBelow700msCount`, or `maxRenderedLines > 2`).
- All limits and the burn-in style live in `scripts/subtitle-config.mjs`.
  Normal ESSY episodes need no episode override.

Pipeline order: narration approved → TTS/VTT → visual assembly → subtitle
timeline build → subtitle QA → 540p review (`pnpm video:subtitle-review
<EPISODE>`) → human QA approval → 1080p final render.

Regression tests: `pnpm test:subtitle`.

If required assets are missing, stop and ask for them.

The output must be a production-ready MP4.
