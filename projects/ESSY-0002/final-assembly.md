# ESSY-0002 Final Assembly

## Input
- Narration master: `temp/ESSY-0002-narration-master.m4a` (548.829 s) — deterministic assembly
  of 18 approved cached TTS mp3s at approved offsets; no TTS regenerated.
- Visuals: 64 approved shots / 18 blocks from `assembly-timeline.json`, original-resolution
  sources (`temp/final-assembly/shots/`, `sourcing/downloads/`), hard cuts, no proxy upscale.
- BGM: Dreamland — Aakash Gandhi (YouTube Audio Library, attributionRequired: false).
  New ESSY-0002-length extended master `music/dreamland-extended.wav` (553.140 s) built from
  source via equal-power crossfades anchored at low-RMS points (no loop seams). No baked gain.
- Subtitles: shared pipeline `_build-subtitle-timeline.mjs` + `subtitle-config.mjs`, approved
  v3 algorithm (206 cues, SRT byte-identical to approved review). QA PASS, gate aborts render.

## Treatment
- Cold-open title "When the Future Suddenly Becomes Visible" overlaid on shot 1, zero added
  duration: fade in 5.0 s (+0.6), fade out 8.0 s (+0.75).
- Ending hold: final shot extended +4.0 s, appended AFTER the last normal shot, centered
  "ESSY" end-card, subtle fade-in, no subtitles, no CTA.

## Mix
- Narration is master; BGM −9 dB applied only at mix-time. No ducking.
- AAC 192 kbps / 48 kHz stereo. Mean −24.5 dB, max −5.8 dB, no clipping.

## Output
`output/ESSY-0002/ESSY-0002-final-v1.mp4` — 1920×1080, 30 fps, h264 CRF 18 veryfast,
552.992 s (16590 frames) = base 548.992 + 4.0 hold. QC: `temp/final-assembly/final-assembly-qa.json`.
QA screenshots live under `projects/ESSY-0002/logs/qa-screens/` (per the output-hygiene
rule: `output/<EP>/` holds final deliverables only). Render:
`node scripts/render-essay-final.mjs ESSY-0002`.
