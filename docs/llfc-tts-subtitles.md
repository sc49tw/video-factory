# LLFC TTS and subtitle workflow

Run from the Video Factory root:

```powershell
pnpm vf:llfc:tts -- projects/llfc/llfc-001-a-modern-theme-park
```

The command reads the project's `project.json` and generates:

- one 48 kHz stereo WAV narration file per narrated scene;
- one scene-level WebVTT file per narrated scene;
- merged SRT, ASS, and WebVTT subtitles for the full episode;
- `render/timeline.json`, timed from the generated audio;
- `generated/tts/tts-manifest.json`;
- updated project `manifest.json` and `status.json`.

Explicit `timingCues` in a scene are rendered as real periods of silence in
the scene audio. The workflow does not rewrite narration.

Generated output is not overwritten by default. To intentionally regenerate
it:

```powershell
pnpm vf:llfc:tts -- projects/llfc/llfc-001-a-modern-theme-park --force
```
