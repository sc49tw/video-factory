# Repository / Push Policy — video-factory

This document is the **single source of truth** for what belongs in this Git
repository. It exists so that a reader (including an AI agent like GPT) can
clone the repo and understand the entire *pipeline + rules + decisions* of a
production **without** the repo ballooning with regenerable media.

Guiding principle:

> Git keeps the recipe and the decisions. Git does NOT keep the baked cake or
> the downloaded ingredients.

- Save: pipeline source, rules, canonical/authoritative inputs, and
  episode/editorial decisions + provenance.
- Do NOT save: anything that can be reliably regenerated from the above, or
  that was downloaded from an external source, or any large media artifact.

## What Git saves

### Pipeline & rules (always)
- `AGENTS.md`, `README.md`, all `docs/*.md`
- `scripts/**` (`*.mjs`), `scripts/oneoff/**`, `src/**` (`*.mjs`), `package.json`
- `config/**`, `contracts/**`, `prompts/**`, `series/**`, `workflows/**`
- `test/**`, `Story-IP-Library/**` (story/status JSON, templates)

### Episode decisions & canonical inputs
- `projects/<EP>/workflow.json` — workflow state
- `projects/<EP>/final-assembly.json`, `final-assembly.md` — final-assembly decisions
- `projects/<EP>/manifest.json`, `retrospective.json` — production record
- `projects/<EP>/assembly-plan.md`, `visual-plan.json`, `assembly-timeline.json`
- `projects/<EP>/source/lesson.json` — **canonical structured input (keep)**
- `projects/<EP>/script.md`, other hand-authored episode text
- `projects/<EP>/sourcing/*.json` (candidate / selection / provenance metadata,
  NOT the downloaded media)
- manual QA decision / approval records as JSON/Markdown
- `inbox/<EP>/lesson.json` — canonical structured input (keep)

### Reusable source assets (evaluate, not blanket-excluded)
- `assets/overlays/*.mov` (e.g. `like-subscribe-bell-alpha.mov`)
- reusable logos / SVGs / per-series templates that are part of the pipeline
  identity, not an episode's generated output.

## What Git does NOT save (regenerated / downloaded / large media)

- `projects/<EP>/temp/**` — TTS caches, concat lists, `*.vtt`/`*.srt` cues
- `projects/<EP>/audio/**` — TTS-generated narration (`*.mp3`/`*.wav`/`*.m4a`)
- `projects/<EP>/segments/**` — rendered per-shot intermediates
- `projects/<EP>/logs/**` — machine-generated render/QA logs
  (manual QA *decisions* are kept; see above)
- `projects/<EP>/qa/**` — QA screenshots (`.png`)
- `projects/<EP>/sourcing/downloads/**` — downloaded stock media
- `projects/<EP>/source/*.png` — pipeline-generated scene images
  (only `lesson.json` and hand-authored text stay in `source/`)
- `output/**`, `*.mp4`
- `node_modules/**`

Exceptions (whitelist) that are kept because they are genuinely reusable
source identity, not generated output:
- `assets/overlays/**` — the reusable overlay alpha .mov(s)
- `assets/audio/**` — curated reusable sound/score used as a *pipeline input*
  across episodes (this is an input library, not TTS output)

## `.gitignore` implementation notes

Prefer **semantic directory ignores** over global extension ignores. Do NOT
write a blanket `*.png` / `*.vtt` / `*.srt` rule — it would strip the
canonical `source/lesson.json`, `inbox/<EP>/lesson.json`, provenance JSON,
and Story-IP-Library text that the policy explicitly keeps.

Use scoped patterns such as:
```gitignore
projects/**/temp/
projects/**/audio/*.mp3
projects/**/audio/*.wav
projects/**/audio/*.m4a
projects/**/segments/
projects/**/logs/*.log
projects/**/qa/
projects/**/sourcing/downloads/
projects/**/source/*.png
```

## Removing files already tracked

History-rewrite-free cleanup uses `git rm --cached <path>` (keeps the file on
disk, only untracks it) after adding the matching ignore rule. Categories:

- **A — clearly regenerated artifacts**: `temp/`, `audio/`, `segments/`,
  `logs/*.log`, `qa/*.png`, generated `source/*.png`. Untrack without review.
- **B — downloaded external assets**: `assets/audio/raw/**`,
  `assets/images/<episode-series>/**` scene sets, `inbox/*/scene*.png`,
  `sourcing/downloads/**`. Untrack without review.
- **C — ambiguous / needs human review**: reusable scene assets whose source
  status is unclear (e.g. `assets/images/en-junior-high-*/`), thumbnails,
  banners/logos, `inbox/<EP>/approved/**`. NOT auto-untracked.

Class C is intentionally excluded from any automated `git rm --cached` run.
Only a human may decide to move class C to class A or B.

## Hard rule

No history rewrite, no force push, no LFS migration, and no second "rules
repo". `video-factory` remains the single source of truth for pipeline +
rules + decisions; media is regenerated or re-downloaded on demand.