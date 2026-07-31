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
