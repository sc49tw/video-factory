# Video Factory

## Start every new video in Codex

Codex is the only creative workflow entry point. Give Codex the series and
movie or source concept:

```text
開始一支新的 LLFC 影片。
電影是 Home Alone。
```

Codex creates a persistent draft in `projects/_drafts/<DRAFT-ID>/`, reads
`state.yaml` before every action, and works on exactly one current stage. The
equivalent CLI checkpoint operation is:

```bash
pnpm video:workflow start LLFC default --source "Home Alone"
pnpm video:workflow continue <DRAFT-ID>
```

The gated path is:

```text
REQUEST → CONCEPT → approve concept
        → ENGLISH → approve english
        → STORYBOARD → approve scenes
        → PACKAGE → validate schema → approve package
        → ASSETS → existing renderer → QA
```

Codex saves each proposed artifact before requesting its one approval:

```bash
pnpm video:workflow submit <DRAFT-ID> CONCEPT concept.json
pnpm video:workflow approve <DRAFT-ID> concept
pnpm video:workflow submit <DRAFT-ID> ENGLISH script.json
pnpm video:workflow approve <DRAFT-ID> english
pnpm video:workflow submit <DRAFT-ID> STORYBOARD storyboard.json
pnpm video:workflow approve <DRAFT-ID> scenes
pnpm video:workflow submit <DRAFT-ID> PACKAGE production-package.json
pnpm video:workflow approve <DRAFT-ID> package
```

A submission or approval for a later stage fails until the current gate has
passed. Rollback is explicit:

```bash
pnpm video:workflow rollback <DRAFT-ID> ENGLISH
```

Rules have one version-controlled source:

- `workflows/episode-production.workflow.yaml`: stages, validation, approvals,
  transitions, and rollback rules.
- `series/LLFC/series.yaml`: LLFC worldview, language, visual, and creative
  rules.
- `contracts/production-package.schema.json`: production JSON structure.
- `prompts/stages/`: reusable stage instructions.
- `state.yaml`: durable per-draft stage, approvals, and artifact pointers.

Codex writes a small internal task to
`projects/_drafts/<DRAFT-ID>/runtime/current-stage.txt`. There is no external
Chat handoff or `import-chat` step. The user only approves the current proposal,
requests a revision, or requests a rollback.

The previous external-Chat implementation is preserved under
`archive/legacy-chat-workflow/` for history only and is not called by package
scripts.

### Asset handoff boundary

After package approval, Codex enters `ASSETS`. Use the approved package to
prepare an asset manifest and the existing `inbox/<EPISODE>/lesson.json`.
`inbox/` is now a renderer handoff area populated by Codex/pipeline, not a
place for the user to copy Chat output. It remains read-only during render.
Automatic image generation is not assumed. Missing images stop the existing
gate; once images exist, run `pnpm video:render <EPISODE>` as before.

### Completed episode archival

QA completion does not automatically move an episode. After publication, the
user can explicitly approve archival:

```bash
pnpm video:workflow archive <EPISODE> --published
```

The episode's inbox, project, and output are moved under
`archive/episodes/<EPISODE>/`. See `docs/production-lifecycle.md`.

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

Start a Codex-controlled LLFC draft:

```bash
pnpm video:workflow start LLFC default --source "Home Alone"
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
