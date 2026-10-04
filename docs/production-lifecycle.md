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
  → ENGLISH → compression pass (Playbook §2.1, projects/<DRAFT-ID>/compression-review.md)
            → user approval of the compressed script
  → STORYBOARD → user approval
  → PACKAGE → series-specific schema validation (LLFC uses the LLFC-only
    production-package contract; ESSY has its own essy-production-package
    contract and no CONCEPT gate) → user approval
  → ASSETS → machine validation (ESSY only; no human gate) → RENDER
  → REVIEW (draft-backed: governed by state.yaml; do not create a competing
    workflow.json) → Gate 3 QA approval via `approve <EP> qa` → FINAL-ASSEMBLY
  → RENDER → QA approval
  → FINAL-ASSEMBLY (ESSY) → final-assembly approval
  → completed
```

Codex reads state before every action and cannot submit or approve a later
stage. The compression pass is an EDITORIAL step inside ENGLISH, not a new
workflow stage: its artifact is `projects/<DRAFT-ID>/compression-review.md`,
and the ENGLISH approval covers the compressed script. Historical episodes
(ESSY-0001–0003) were not produced under this gate; their retrospective
compression reviews are diagnostic only and their approved scripts are frozen.
The small `runtime/current-stage.txt` file references repository
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

The command accepts only completed, approved episodes and moves their three
working directories to:

```text
archive/episodes/<EPISODE>/
  inbox/
  project/
  output/
  archive.json
```

Archival is never automatic.

The authoritative record is resolved draft-first, so both episode kinds archive
through the same command:

- Draft-backed episodes (current ESSY): `projects/_drafts/<EPISODE>/state.yaml`
  must be `completed` with both `qa` and `finalAssembly` approved. Archival
  then transitions that draft to `archived`, records `archivedAt`, and appends
  an `episode-archived` history event. `currentStage` stays at the stage where
  production finished (`RENDER`); only `status` changes, so an archived episode
  is never left behind as a dangling `completed` draft and is never offered by
  `video:workflow continue` as unfinished work.
- Workflow-backed episodes (legacy): `projects/<EPISODE>/workflow.json` is
  gate-refreshed first and must reconcile to `completed` with QA approved, then
  is marked `archived` with `archivedAt`.

`archive.json` is written last and follows the existing convention
(`episode`, `archivedAt`, `reason`, `locations`, plus `stateSource` naming the
record that authorized the transition). It is also what `video:publication
check` reads to report `archived`.

Archival is transactional. Eligibility, the `--published` confirmation and the
archive targets are all validated first; if any move or the final commit fails,
the moves and the authoritative record are rolled back and the episode is left
exactly as it was. An existing `archive.json` or an existing archive target is
refused rather than overwritten.

Regression tests: `pnpm test:archive`.

## Publication package

`completed` and `published/archived` are different states. A completed episode
with a valid publication package reports `READY TO PUBLISH` and nothing more:
the CLI never uploads, never marks an episode published, and never archives.

The canonical publication layout is the one defined in
[ESSY brand README](../brand/ESSY/README.md) (Asset Ownership):

```text
projects/<EPISODE>/publication/
  thumbnail.png            canonical episode thumbnail
  youtube.json             publication metadata (human-authored)
  publication-record.json  provenance record written by the import CLI
```

Renderer deliverables stay under `output/<EPISODE>/`, and production artifacts
stay under `projects/<EPISODE>/`. Publication packaging is never mixed into
renderer output.

### Import the thumbnail

After the human downloads the selected thumbnail through the browser:

```bash
pnpm video:publication import ESSY-0005 thumbnail
```

The command resolves the repository root by walking up from its own script
directory (never a hard-coded checkout), resolves the Downloads directory from
`USERPROFILE`/`HOME`, and selects the newest supported image (`.png`, `.jpg`,
`.jpeg`, `.webp`). It COPIES the download; the file in Downloads is never moved
or deleted. A PNG source is copied byte-for-byte, and any other container is
converted to `thumbnail.png` with ffmpeg.

Safety rules:

- Non-image sources are rejected; no supported image and no recent download are
  explicit failures. The default candidate window is 7 days (`--within-days <n>`
  widens it), so an unrelated older download is reported instead of guessed at.
  `--list` prints the candidates, `--from <path>` imports an explicit file.
- An existing canonical thumbnail is never overwritten without `--replace`.
- The download is measured before anything is written, and a failing image is
  reported FAIL rather than cropped or resized to force a pass.

Metadata (title, description, tags) is human-authored in
`projects/<EPISODE>/publication/youtube.json`; `import` only moves the
thumbnail. Thumbnail rules, validation, and the provenance record live in
`scripts/video-publication.mjs` and `src/publication.mjs`.

### Check the package

```bash
pnpm video:publication check ESSY-0005
```

Read-only. It validates Title, Description, Thumbnail, and Video, and reports
the episode lifecycle as `completed`, `archived`, or `not ready`. The final
master is resolved from the renderer's own QA record
(`projects/<EP>/temp/final-assembly/final-assembly-qa.json` → `output`), never
by assuming a `final-v1` label. Add `--json` for the machine-readable report.

Regression tests: `pnpm test:publication`.

## Essay render pipeline (MVP, known non-final)

The ESSY renderer is intentionally a simple pipeline. It is acceptable for the
current volume but is NOT the final production implementation; segment caching
or a single-pass timeline renderer should be revisited before scaling up.

Current flow:

1. One cached TTS pass per narration block (`projects/<EP>/audio/*.mp3`,
   keyed by text + voice settings). For ESSY the synthesis session
   (`scripts/generate-essy-tts.py`) also emits the canonical word-boundary
   timing artifact `temp/<sentenceId>.words.json`; `temp/*.vtt` carries the
   block parent window. New-generation ESSY manifests record
   `subtitleTiming.policy = "word-boundary-required"`; missing or mismatched
   word timing fails subtitle QA before render, legacy episodes fall back
   with an explicit warning.
2. A deterministic visual plan (`src/visual-plan.mjs` +
   `contracts/visual-plan.schema.json`) splits every block into shots cut on
   TTS sentence boundaries and distributes each block's ACTUAL ffprobe audio
   duration across its shots automatically. Manual `durationSec` overrides
   exist in the schema for future extension but are never generated or used.
   `pauseAfterSec` extends only a block's FINAL shot; burned subtitles always
   end with the spoken narration and never remain visible during the trailing
   pause. The validated plan is stored as `projects/<EP>/visual-plan.json`.
3. Each shot renders to an intermediate MP4 (still-image motion per
   `stillMotion` policy — see `scripts/_still-motion.mjs`; STATIC default,
   `stillMotion:"slow-push"` for an explicit editorially-justified stable center
   push-in; no index-parity alternation — over the section image, audio sliced
   from the block TTS, subtitles burned from shot-local cues):
   `projects/<EP>/segments/<block>-essay-shot-NNN.mp4`.
4. Intermediates are concatenated with the ffmpeg concat demuxer (`-c copy`)
   into `temp/concatenated.mp4`, then muxed (optional background-music mix)
   into `output/<EP>/<EP>.mp4`.

Known costs of this MVP: one encode per shot, no partial re-render of changed
shots, and concat-level frame rounding (~tens of milliseconds per boundary).
