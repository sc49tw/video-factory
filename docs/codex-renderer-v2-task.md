# Codex Task: Implement Easy English Renderer v2

Read these files first:

```text
docs/renderer-v2-spec.md
scripts/render-english-prototype.mjs
scripts/lesson-import.mjs
lessons/en-junior-high/en-junior-high-008.json
lessons/en-junior-high/en-junior-high-009.json
```

## Task

Implement:

```text
scripts/render-english-v2.mjs
```

Follow `docs/renderer-v2-spec.md` exactly.

## Non-negotiable constraints

- Preserve `scripts/render-english-prototype.mjs` unchanged.
- Preserve `scripts/lesson-import.mjs` unchanged.
- Do not add dependencies.
- Remain backward-compatible with existing lesson JSON.
- Do not redesign the repository or rendering architecture.
- Reuse the current FFmpeg, TTS, font, sequence, and validation logic.
- Create a new renderer rather than replacing v1.

## Required checks

Run:

```bash
node --check scripts/render-english-v2.mjs
```

If the local environment contains the required assets and FFmpeg, also run:

```bash
node scripts/render-english-v2.mjs lessons/en-junior-high/en-junior-high-008.json
node scripts/render-english-v2.mjs lessons/en-junior-high/en-junior-high-009.json
```

## Final response

Report:

1. Files created or changed.
2. Main behavior changes.
3. Validation commands run and results.
4. Any assumptions or limitations.
5. Exact commands the user should run to regenerate #008 and #009.

Do not make unrelated cleanup changes.
