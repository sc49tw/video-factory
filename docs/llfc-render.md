# LLFC first-cut renderer

Run from the Video Factory root after `vf:llfc:tts`:

```powershell
pnpm vf:llfc:render -- projects/llfc/llfc-001-a-modern-theme-park
```

The renderer:

- composes every timeline scene at 1920×1080;
- preserves the complete source image and pads non-16:9 artwork;
- concatenates generated scene narration;
- mixes the existing projector loop and projector click sounds;
- uses the existing transition sound at the first lesson;
- burns in the generated ASS subtitles;
- writes a project-local `output/final.mp4`;
- copies the master to the factory `output/` location;
- writes `render/render-report.json`;
- updates `manifest.json` and `status.json`.

Use `--force` to intentionally replace a previous generated first cut.
