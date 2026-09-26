# ESSY-0004 FINALIZE readiness

FINAL RENDER READINESS: READY (inputs and existing preflight; final output QA remains after rendering).

## Starting state and scope

Draft state: RENDER / final_assembly_pending. English, scenes, package and QA approvals present. Review baseline: ESSY-0004-review-540p-subtitled-v13.mp4. Working tree was already dirty; preserved. No full final video rendered, no Gate 4 approval, no workflow.json introduced, no git commit/push/reset/stash/clean.

The Runbook's older sentence saying openingIdentity final parity is unavailable is stale relative to the current renderer and shared delivery plan. Current code, preflight and the existing 13 parity tests confirm parity support. No renderer or workflow changes were made in this task.

## Files

Created:
- final-assembly.json
- music/dreamland-extended.wav
- music/bgm-plan.json
- temp/ESSY-0004-narration-master.m4a
- temp/narration-master/ fourteen cached-audio assembly segments, concat.txt and narration-master-qa.json
- temp/bgm-rms-profile.txt and temp/bgm-extended-filter.txt
- this report

Modified: series/ESSY/series.yaml, adding only currentDefaultBgm metadata with episode override allowed. This documents the editorial default; renderers continue consuming explicit per-episode final-assembly.json music settings.

All paths above are relative to projects/ESSY-0004 unless stated otherwise. Approved assembly, opening metadata, subtitles, TTS, WordBoundary, asset selections and provenance were not edited. ESSY-0001/0002/0003 artifacts were read only.

## Music evidence and preparation

Canonical source: projects/ESSY-0001/music/candidates/Dreamland - Aakash Gandhi.mp3 (usable, probed 180.000 s, stereo 44.1 kHz).

Evidence: final-assembly.json in completed ESSY-0001/0002/0003 all record Dreamland, Aakash Gandhi, YouTube Audio Library, attributionRequired=false, the same source path, gainDb=-9, crossfadeDurationSec=4, finalFadeOutDurSec=4 and ducking=false. ESSY-0001/music/bgm-plan.json and final-assembly.md establish the equal-power construction; ESSY-0003/music/bgm-plan.json records the generic builder convention. Metadata is inherited repository evidence, not a new external license verification.

Reused original source; no search/download. Materialized a new episode-length master because previous extended masters have different end/fade timestamps. Canonical command:

`pnpm video:build-bgm ESSY-0004 --target 394.976`

Target derived from shared plan: 386.976 approved assembly + 4.000 opening insertion + 4.000 ending hold = 394.976 s. Explicit target is necessary because the builder's default adds only ending hold to the unshifted narration master.

Result: music/dreamland-extended.wav, 394.976 s, PCM s16le / 48 kHz stereo. Three source passes, equal-power qsin/qsin crossfades at 174–178 and 330.5–334.5 s. Final fade 390.976–394.976 s. Gain not baked in; final mix applies -9 dB. No ducking, stretching or pitch change.

## Final decisions and narration

final-assembly.json uses schemaVersion 1.0, episode ESSY-0004, title Who Am I Beyond My Roles?, endCard.source=seriesTitle, endingHoldSec=4, and the music settings above. No dedicated final-assembly schema/validator was found; JSON parsing, current identity/ending resolvers and canonical final preflight succeeded.

Canonical command: `pnpm video:build-narration-master ESSY-0004`.

Narration path: projects/ESSY-0004/temp/ESSY-0004-narration-master.m4a.
Measured duration: 386.997 s; expected base duration: 386.976 s; +0.021 s encoding/container difference is inside the existing 0.050 s builder tolerance. All fourteen source MP3 durations fit their original block windows; existing pauses were preserved.

This master intentionally remains on the base assembly timeline. Do not insert another silence into it: the current final renderer reads buildOpeningDeliveryPlan and inserts silence at mix time. It splits the base master at 13.368, concatenates head + 4.000 s silence + full tail, and pads only for ending duration. No in-place mute deletes narration. Content starts at t=0; identity is 13.368–17.368; N002 nominal delivery start is 17.368, first word/cue 17.468; all later content shifts by exactly +4.000 s. The existing AAC tolerance above is not claimed as sample-exact waveform alignment. No second timing metadata was introduced.

## Readiness checks

- `pnpm video:preflight ESSY-0004 final`: passed=true; missingFinalInputs=[]; 14 blocks, 35 shots; shared opening parity READY; no pre-roll.
- `node --test scripts/_test-opening-parity.mjs`: 13 passed, 0 failed; validates shared insertion, preserved body offsets, silence-window semantics, subtitle insertion, ending, typography and real approved episode metadata. Tests were rerun outside sandbox after spawn EPERM; no full suite was run.
- Canonical narration QA passed (+21 ms within 50 ms tolerance).
- Canonical BGM duration QA passed, actual=target=394.976 s.
- JSON/identity/ending resolver checks passed.

Expected final program: nominal 394.976 s (~6:34.976); final encoded duration is determined by the renderer's frame-quantized visual concat and must be verified after rendering.

Blocker: none identified by this readiness checkpoint. This is not Gate 4 or a claim that an unrendered final master has passed visual/listening QA.

Git summary: existing modified/untracked work preserved. This task adds only the ESSY-0004 final inputs/report and modifies the series default metadata. No earlier-episode production artifact, renderer code, draft approval state or approved review MP4 was changed.

Full final rendered: NO.
Gate 4 approved: NO.

NEXT (not executed):
`pnpm video:render-final ESSY-0004 --label v1`
