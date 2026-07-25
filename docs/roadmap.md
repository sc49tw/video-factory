# Language Shadowing Factory Roadmap

Status: Active
Updated: 2026-07-21

## Purpose

This document defines the current development priority.

**The target architecture is not the current task list.** Work is selected by the active roadmap phase.

It does not replace:

- **architecture-as-is.md** for current facts
- **architecture-target.md** for long-term direction
- **architecture-migration.md** for detailed migration analysis

## Current Operational Version

### v0.1 — Manual Content, Automated Import and Render

Status: Working

Current workflow:

1. Create lesson JSON, scene images and thumbnail outside the repository.
2. Place downloaded files in Windows Downloads.
3. Run **pnpm lesson:import**.
4. Import lesson data and assets.
5. Render the MP4 using the current prototype renderer.

Available:

- English lesson and asset import
- English TTS and FFmpeg rendering
- STORY / REPEAT / SHADOW flow
- Completed lessons 001–009

Known limitations:

- Lesson formats are inconsistent.
- JSON Schema is not connected to runtime validation.
- The package command uses the prototype renderer.
- Renderer variants have diverging features.
- **src/** has no production implementation.

## Current Focus

### v0.2 — Stable Lesson Contract

Status: Active — the only current development focus

Goal: define one canonical lesson format for all new lessons.

Current tasks:

- [ ] Compare **schemas/lesson.schema.json** with existing lessons.
- [ ] Compare schema fields with importer and renderer behavior.
- [ ] Decide the canonical format for new lessons.
- [ ] Define the legacy compatibility policy.
- [ ] Update schema and human-readable documentation.
- [ ] Add non-blocking validation.

Not included:

- Moving renderer code into **src/**
- Automatic lesson generation
- Japanese rendering
- YouTube publishing automation
- Removing legacy renderer files

Exit criteria:

- New lessons have exactly one canonical format.
- Import and render agree on required fields.
- Existing lessons remain renderable through compatibility handling.
- Schema validation runs without blocking legacy production.

## Next Phase

### v0.3 — Canonical Renderer

Status: Planned

Planned goals:

- Compare prototype, v1.1 and v2.
- Select the canonical feature set.
- Preserve required branch features.
- Add regression checks.
- Expose one official render command.

This phase does not begin until v0.2 is complete.

## Later Phases

### v0.4 — Core Modules in src/

Status: Planned

- Shared validator
- Canonical renderer
- TTS module
- Thin CLI wrappers

### v0.5 — Assisted Lesson Generation

Status: Planned

- Series and visual-style rules
- Prompt generation
- Lesson candidate generation

### v0.6 — Publishing Support

Status: Planned

- YouTube metadata
- Chapters and thumbnail metadata
- Optional publishing integration

### v1.0 — Integrated Factory

Status: Planned

Target workflow:

Idea → series/style → canonical lesson → validation → assets → rendering → publishing package

## Current Rule

Only work on v0.2 unless:

- a blocking defect prevents current production;
- documentation must be corrected to actual behavior; or
- the user explicitly authorizes a later phase.

Do not perform broad refactoring merely because it appears in the target architecture.