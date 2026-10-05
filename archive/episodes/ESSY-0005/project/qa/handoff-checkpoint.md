# ESSY-0005 Handoff Checkpoint — 2026-10-02

## Git State
- **Branch**: `agent/publish-video-factory-worktree`
- **HEAD**: `8ca4e0852f7f4671351825321d34432cd33f2c6e`
- **Dirty files**: 12 modified (workflow.json, state.yaml, scripts, series YAML); 50+ untracked (inbox/, projects/, scripts/oneoff/, temp/)

## Authoritative Physical v02 Paths (git-ignored, under root `temp/`)
```
D:\Git\video-factory\temp\essy-0005-roughcut-v02\
├── selection.json              # 43-slot visual QA (flags, reviewRequired, editorial notes)
├── motion-QA-report.md         # NO_MOTION_STILLS PASS (N004-S1, N011-S2)
├── qa/
│   ├── motion-checks.json      # machine-readable motion QA
│   └── v03-repair/
│       └── analysis/
│           └── v03-screening-note.md  # v03 candidate decisions
├── ESSY-0005-roughcut-v02.mp4            # full roughcut
├── ESSY-0005-roughcut-v02-nomotion-preview.mp4
├── visual-master.mp4
└── clips/, media/             # per-slot source clips
```

## Motion Metrics (source-video-motion-metrics.json — 43 clips from v01 media)
| Verdict | Count | Note |
|---------|-------|------|
| PASS    | 10    | camera effectively locked |
| REVIEW  | 5     | mild wobble / slow pan / rotation |
| REJECT  | 28    | zoom, pan, shake, rotation, handheld sig |
**Total: 43** — **REJECT ≠ editorial rejection**; metrics measure camera stability only.

## Existing v03 Proposal Assets & Decisions (v03-screening-note.md)
| Slot | Status | Candidate | Notes |
|------|--------|-----------|-------|
| N002-S3 | **LOCKED** | 8860235 (Pexels) | 41s, static cam, older man at window, no TV |
| N004-S2 | **BLOCKED** | — | No candidate satisfies identity (5319077) + home/idle (6263197) simultaneously. Need human choice (a/b/c). |
| N008-S2 | **PROVISIONAL** | 7681168 (Mikhail Nilov) | 15s, pen held over notebook. Must verify continuity vs N008-S1. Backup: 7307974. |
| N016-S2 | **BLOCKED** | — | No viable candidate for "older looking toward younger at distance". |

## NO_MOTION_STILLS Status
- **PASS** — N004-S1 (ssim=0.9873), N011-S2 (ssim=0.9903)
- No time-varying still filters in build.mjs, _still-motion.mjs, render-lesson.mjs, render-essay-final.mjs

## Gate 2 / PACKAGE Approval Status (state.yaml)
- `concept.approved: true`
- `english.approved: true`
- `scenes.approved: true`
- **`package.approved: false`** — no human approval on clip selections
- **Current stage: PACKAGE** (in_progress)
- N003-S1 Gate 2 vision check blocked (MiMo API unavailable)

## Known Errors in Latest Triage Summary
- N003-S1 shows as PASS in motion metrics (AI-generated, locked camera) but **Gate 2 blocked** — cannot proceed without vision check
- N004-S2 shows REJECT in motion metrics (current v01 clip: +25% zoom, 8.5% pan, 1.68 shake) but **v03 candidates exist** — metrics reflect v01 media, not v03 proposals
- N008-S2 shows REJECT in motion metrics (v01 clip: +1.5% zoom, 9.3% pan, 4.8 shake) but **v03 primary 7681168 unmeasured** — must re-measure if locked
- v03 proposals are **independent temp artifacts**; not wired into workflow, no Gate 2, no PACKAGE approval

## Exact Next Task
**Playback-based editorial triage** — human reviews v02 roughcut + contact sheets + motion metrics + v03 proposals to confirm/override per-slot actions:
1. **Keep** (11 slots with PASS metrics + no visual flags)
2. **Playback review** (17 slots with REVIEW metrics or visual flags)
3. **Replace with v03 candidate** (N002-S3 locked; N004-S2, N008-S2 pending adjudication)
4. **Source new** (N003-S1, N016-S2, any REJECT slots without v03 proposal)

**Do NOT** run new sourcing/download/build. **Do NOT** modify workflow state. **Do NOT** commit/push/reset/stash.