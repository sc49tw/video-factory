# LLFC-001 — A Modern Theme Park

Pipeline: LLFC
Stage: assets_ready
Next stage: TTS

The inbox source was copied, not moved. manifest.json contains the normalized
asset paths, dimensions, and SHA-256 checksums. Non-16:9 source images must be
composed without cropping their text.

Generated TTS, subtitles, timelines, QA frames, render reports, and video
outputs are intentionally not stored in Git. After a fresh clone, install the
prerequisites listed in the repository README, then run:

```powershell
pnpm vf:llfc:tts -- projects/llfc/llfc-001-a-modern-theme-park
pnpm vf:llfc:render -- projects/llfc/llfc-001-a-modern-theme-park
```
