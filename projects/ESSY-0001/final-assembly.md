# ESSY-0001 — Final Assembly Spec

Episode: ESSY-0001 — Why Life Starts Feeling Different After 40
Status: final-assembly rendered — v1 defect fixed, re-render passed QA; awaiting user viewing review
Governing rules: `docs/ESSY_VIDEO_PRODUCTION_PLAYBOOK.md` v1.1, Section 7 (Real-Asset Timeline Rules)

This document records verified production decisions for ESSY-0001 that are
episode-specific. It is a specification only; nothing in it has been implemented
in the final assembly yet.

## 1. Verified Prototype Record (N001–N003)

Corrected real-asset prototype: `output/ESSY-0001/prototype-N001-N003.mp4`
(visually reviewed 2026-08-25).

Verified result:

- duration ≈ 68.465 s
- 1920×1080 @ 30 fps
- continuous narration
- 8 real-asset visual shots
- every selected source asset used exactly once
- no source looping
- no overlapping source-time ranges
- no visible repeated-footage defect around 36 s / 42 s

Final prototype mapping:

| Block | Shot order (one use per slot) |
| --- | --- |
| N001 | N001-S1 → N001-S2 → N001-S3 |
| N002 | N002-S1 → N002-S2 → N002-S3 |
| N003 | N003-S1 → N003-S2 |

N002 now reads approximately: train → airport → open mountain road,
with ~7.75 s per shot.

This replaced the previous prototype behavior S1 → S2 → S3 → S1 → S2 → S3,
which caused recognizable repeated footage.

## 2. Subtitle Style — Final-Assembly Requirement (NOT yet implemented)

The prototype's current large semi-transparent black subtitle panel is NOT
approved as the final ESSY subtitle style. Do not treat the prototype's burned-in
subtitle look as the target. Implementation is deferred to final assembly;
this section records the requirement only.

Final target:

- white text
- subtle dark outline and/or shadow for readability
- no large full-width black subtitle panel
- maximum 2 lines
- visually secondary to footage
- safe bottom margin
- narration-synchronized timing
- no subtitle during intentional trailing pause

## 3. Music State (decision already reached)

- Selected track: Dreamland — Aakash Gandhi
- Source: YouTube Audio Library
- Attribution required: false
- Extended master: `projects/ESSY-0001/music/dreamland-extended.wav`
- Technical status: extended prototype verified
- Duration: 469.350 s
- Construction: three overlapping source passes with 4 s equal-power crossfades
- Transition windows: 174.000–178.000 s and 326.500–330.500 s
- Final fade: 465.350–469.350 s
- Audition-approved nominal BGM mix gain: −9 dB

Important notes:

- −9 dB is a MIX-TIME parameter. It must NOT be baked into the BGM master.
- Dynamic ducking is NOT yet approved or required.
- The final full-episode mix still requires listening QA.

Machine-readable counterpart: `projects/ESSY-0001/music/bgm-plan.json`.

## 4. Final-Assembly QA Checklist

Work through this checklist during final-assembly QA for this episode.

VISUAL

- [ ] every approved sourcing slot accounted for
- [ ] no asset duplicated merely to satisfy shot count
- [ ] no unintended loops
- [ ] no overlapping source ranges
- [ ] no visually recognizable repeated footage
- [ ] actual source durations checked with ffprobe
- [ ] no INSUFFICIENT_SOURCE condition ignored

AUDIO

- [ ] narration continuous
- [ ] no missing narration segment
- [ ] no accidental silence/dropout
- [ ] Dreamland BGM present
- [ ] nominal mix begins from −9 dB reference
- [ ] narration remains clearly dominant
- [ ] no clipping
- [ ] final BGM fade correct

SUBTITLES

- [ ] synchronized to narration
- [ ] max 2 lines
- [ ] no large black panel
- [ ] readable over bright/dark footage
- [ ] no subtitle leaking into trailing pauses

TIMELINE

- [ ] visual cuts do not alter narration timing
- [ ] final duration consistent with narration master
- [ ] no old placeholder shot-count requirement enforced

EDITORIAL

- [ ] visual sequence feels calm and deliberate
- [ ] no obvious stock-footage repetition
- [ ] visuals support mood/idea rather than mechanically illustrating every spoken noun
- [ ] pacing remains appropriate for reflective essay style


## 5. Render & QA Record — ESSY-0001-final-v1

Deliverable: `output/ESSY-0001/ESSY-0001-final-v1.mp4`

### QA numbers (post-fix re-render, 2026-08-30)

- duration: 473.056 s (ffprobe, matches narration master)
- audio mix peak: max −6.0 dB (no clipping, narration dominant)
- concat order verified: `… N018-S3 → N018-S4 → ending-hold.mp4`
- ending hold frames 470.5 s / 472.8 s: subtitle-free (extracts
  `projects/ESSY-0001/temp/final-assembly/qa-fix-hold470.png`,
  `qa-fix-hold472.png`)
- title frame 6.5 s normal (`qa-fix-title.png`)

### Defect found in first render (v1, pre-fix)

Subtitle "How to edit it." (final shot N018-S4's last cue, absolute
466.425→468.442 s) bled into the 4 s ending hold.

Root cause: in `scripts/render-essay-final.mjs`, the ending-hold clip was
pushed to `clips` before the final shot's clip, so the concat order became
`…N018-S3 → ending-hold → N018-S4`. This shifted the visual timeline by the
hold length, moving the last cue to ~470.4→472.4 s on screen. Subtitle
timing itself (`sliceCues`/cue #121) was correct.

Fix: reordered the clip pushes (shot clip first, then ending hold) plus an
explicit `continue`; re-rendered in full and re-mixed. Verification batch
(concat tail order, frame extracts, ffprobe duration) all passed.

### Known open issue (renderer tooling, not this episode)

`render-essay-final.mjs --only=` with `=` syntax parses to a null shot
filter, silently triggering a full re-render. Harmless here; fix separately.

## 6. References

- `docs/ESSY_VIDEO_PRODUCTION_PLAYBOOK.md` v1.1 — Section 7 stable rules
  (real-asset timeline, source reuse policy, shot-duration policy,
  narration/subtitle independence)
- `projects/ESSY-0001/manifest.json` — episode metadata (read-only reference)
- `projects/ESSY-0001/visual-plan.json` — placeholder plan retained as
  historical/audit information; not authoritative for shot count
- `projects/ESSY-0001/music/bgm-plan.json` — BGM construction metadata
