# Video Factory

Video Factory guides a production from creative development through approved
assets, TTS, rendering, QA, and retrospective. Edge TTS and FFmpeg produce the
final double-pass shadowing video.

## Requirements

- Node.js 20+
- pnpm
- FFmpeg and ffprobe
- Edge TTS, either on `PATH` or installed at `.venv/bin/edge-tts`

## Episode input

Place each episode in `inbox/<EPISODE>/`. The inbox is read-only during render.

```text
inbox/CT001/
  lesson.json
  scene01.png
  scene02.png
```

Recommended lesson format:

```json
{
  "episode": "ESSD-0012",
  "series": "ESSD",
  "subtype": "classic-twisted",
  "title": "The Tortoise and the Hare",
  "language": "en",
  "renderMode": "double-pass-shadowing",
  "countdownSeconds": 4,
  "tts": {
    "provider": "edge",
    "voice": "en-US-JennyNeural",
    "rate": "+0%"
  },
  "video": {
    "width": 1920,
    "height": 1080,
    "fps": 30
  },
  "scenes": [
    {
      "image": "scene01.png",
      "sentences": [
        "Once upon a time, a tortoise challenged a hare to a race."
      ]
    }
  ]
}
```

Existing lessons using `lesson_id`, `segments`, `text`, `narration`, or `lines`
remain supported.

## Render

Discover existing productions and show the next gate:

```bash
pnpm video:workflow discover
pnpm video:workflow start
pnpm video:workflow continue ESSD-0011
```

Start a creative draft and generate its Chat handoff prompt:

```bash
pnpm video:workflow start ESSD classic-twisted
pnpm video:workflow start ESSD movie-explained-badly
pnpm video:workflow start LLFC default
```

Import Chat's final JSON package and approve it:

```bash
pnpm video:workflow import-chat <DRAFT-ID> package.json
pnpm video:workflow approve <DRAFT-ID> content
```

Episode IDs use `ESSD-0001` for ESSD subtypes and `LLFC-0001` for LLFC.
Series and subtype are recorded in `lesson.json` and `workflow.json`.

Render only after the content and image gates pass:

```bash
pnpm video:render ESSD-0012
```

Options:

```bash
pnpm video:render ESSD-0012 --force
pnpm video:render ESSD-0012 --clean
pnpm video:render ESSD-0012 --no-cache
```

Production assets, `workflow.json`, `manifest.json`, and `retrospective.json`
are saved under `projects/ESSD-0012/`. The final video is
`output/ESSD-0012/ESSD-0012.mp4`.

## Common errors

- `lesson.json does not exist`: check the episode folder and ID.
- `Scene ... image does not exist`: correct the image path in `lesson.json`.
- `Required command is unavailable`: install FFmpeg/ffprobe and Edge TTS.
- Edge TTS connection failures require working network access.
