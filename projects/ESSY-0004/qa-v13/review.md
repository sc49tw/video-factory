# ESSY-0004 v13 review — 2026-09-25

Artifact: output/ESSY-0004/ESSY-0004-review-540p-subtitled-v13.mp4
Status: review ready; no human QA approval or final-assembly approval recorded.

## Changes

- Removed the standalone black title pre-roll. Hook starts immediately.
- Series title appears at 13.368–15.368 s, episode title at 15.368–17.368 s, using the current package's sequential identity plan.
- Continued the original approved N001-S2 footage into its unused tail (10.984 s used of 12.756667 s available), without freezing or sourcing replacement footage.
- Body narration and shared-builder subtitle offsets moved together by 4 s. N002 first displayed cue begins at 17.468 s. All 14 original cached audio blocks are used in full with their original pauses; no title speech was generated.
- Rebuilt narration from original block MP3s to avoid carrying the draft's cumulative AAC concat padding into the new audio master.
- Corrected libass's 288-unit script-canvas scaling for the shared 540p pixel-based subtitle style; shared outline is black, matching previous final masters.
- Existing full-draft body visuals were reused. Original assembly timeline, narration text, source audio, and approved asset selections were not edited.

## Verification

- Output: H.264 960x540 at 30 fps, AAC, 394.976 s.
- Video duration 394.966 s; audio duration 394.976 s.
- Full-file decode: no errors/warnings (decode.log).
- Shared subtitle QA passed: 126 cues. No cue intersects the identity window.
- Opening frame checks at 1, 12, 14, 16, 18, 19 s confirm title order, continuing footage, and complete first body sentence.
- Identity audio measurement at 13.4–17.3 s: -91 dBFS (digital silence in volumedetect).
- Ending sampled at 389–394 s: held final footage and series-only title, without subtitles.
- 9 opening/identity regression tests passed; subtitle regression suite passed. Syntax and whitespace checks passed.

## Remaining work

- Human review of opening rhythm, subtitle size, full-length listening and motion comfort. This report does not claim a real-time listen-through.
- BGM selection/mix and final master remain pending.
- The legacy final renderer does not yet support the new insertion composition. It now fails explicitly for openingIdentity episodes rather than silently producing a mismatched opening. Port the shared insertion plan, matching narration offsets, and subtitle builder insertion argument to the final path before final rendering.
- Existing draft body visuals have small prior encoding/frame-rounding offsets; this review does not claim frame-exact alignment of every visual cut with block starts. Narration/subtitle timing is constructed from the same block offsets.

v11/v12 were unsuccessful render attempts and were moved into project temp as failed-review-v11/v12.mp4, leaving them out of the delivery directory. v10 remains available.
