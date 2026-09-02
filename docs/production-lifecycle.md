# Production lifecycle

## Ownership

Codex owns workflow orchestration and repository writes. The user makes only
one decision at a time: approve the proposed current-stage artifact, request a
revision, or approve a rollback. CLI commands are implementation details run by
Codex.

## Creative draft

`projects/_drafts/<DRAFT-ID>/state.yaml` is the source of truth.

```text
REQUEST
  → CONCEPT → user approval
  → ENGLISH → user approval
  → STORYBOARD → user approval
  → PACKAGE → schema validation → user approval
  → ASSETS
  → RENDER → QA approval
  → FINAL-ASSEMBLY (ESSY) → final-assembly approval
  → completed
```

Codex reads state before every action and cannot submit or approve a later
stage. The small `runtime/current-stage.txt` file references repository
contracts and current approved artifacts; it is not a prompt for an external
Chat session.

## Inbox

`inbox/<EPISODE>/` remains because the existing renderer needs a stable,
read-only input boundary containing `lesson.json` and approved images.

In the new flow:

1. Codex creates the production package after all creative approvals.
2. Codex/pipeline materializes `lesson.json`, asset manifest, and approved
   assets into `inbox/<EPISODE>/`.
3. The renderer reads the inbox without modifying it.

The user no longer copies a Chat package into `inbox/`.

## Completion and archival

QA approval marks an episode `completed`, but does not archive it. Files remain
under `inbox/`, `projects/`, and `output/` while the user prepares thumbnails,
metadata, and publication.

After the user confirms publication and explicitly approves archival, Codex
runs:

```bash
pnpm video:workflow archive <EPISODE> --published
```

The command accepts only completed, QA-approved episodes and moves their three
working directories to:

```text
archive/episodes/<EPISODE>/
  inbox/
  project/
  output/
  archive.json
```

Archival is never automatic.

## Essay render pipeline (MVP, known non-final)

The ESSY renderer is intentionally a simple pipeline. It is acceptable for the
current volume but is NOT the final production implementation; segment caching
or a single-pass timeline renderer should be revisited before scaling up.

Current flow:

1. One cached TTS pass per narration block (`projects/<EP>/audio/*.mp3`,
   keyed by text + voice settings), with edge-tts sentence cues in
   `temp/*.vtt`.
2. A deterministic visual plan (`src/visual-plan.mjs` +
   `contracts/visual-plan.schema.json`) splits every block into shots cut on
   TTS sentence boundaries and distributes each block's ACTUAL ffprobe audio
   duration across its shots automatically. Manual `durationSec` overrides
   exist in the schema for future extension but are never generated or used.
   `pauseAfterSec` extends only a block's FINAL shot; burned subtitles always
   end with the spoken narration and never remain visible during the trailing
   pause. The validated plan is stored as `projects/<EP>/visual-plan.json`.
3. Each shot renders to an intermediate MP4 (Ken Burns over the section image,
   audio sliced from the block TTS, subtitles burned from shot-local cues):
   `projects/<EP>/segments/<block>-essay-shot-NNN.mp4`.
4. Intermediates are concatenated with the ffmpeg concat demuxer (`-c copy`)
   into `temp/concatenated.mp4`, then muxed (optional background-music mix)
   into `output/<EP>/<EP>.mp4`.

Known costs of this MVP: one encode per shot, no partial re-render of changed
shots, and concat-level frame rounding (~tens of milliseconds per boundary).
