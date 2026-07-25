# Language Shadowing Factory

Version: 1.0

## Project Status

Daily development priority is defined only by **docs/roadmap.md**.

- Current implementation facts: **docs/architecture-as-is.md**
- Current development priority: **docs/roadmap.md**
- Long-term architecture: **docs/architecture-target.md**
- Full migration backlog and risks: **docs/architecture-migration.md**

Do not assume planned modules already exist. The target architecture is not the current task list.

## Purpose

Language Shadowing Factory is a production system for creating consistent, reusable language-learning lessons and videos.
It currently operates through external/manual content creation, file import and the existing renderer.

## Current Operational Workflow

External lesson JSON and images

→ Import through the current compatibility checks

→ Render with the package-selected prototype renderer

→ MP4

Current operational capability does not include a repository lesson generator, schema-backed standalone validator or publisher.

## Target Workflow

This is planned capability, not a description of completed generator, validator or publisher modules.

Idea

→ Select series and visual style

→ Generate a canonical lesson

→ Validate

→ Generate or import assets

→ Render

→ Prepare publishing metadata

Actual implementation order is controlled only by **docs/roadmap.md**.

## Factory Principles

- Consistency is more important than creativity.
- Reuse existing assets and specifications before creating new ones.
- Keep lesson content separate from renderer code.
- Do not invent a new lesson format without aligning the canonical contract.
- Rendering is optional unless the user explicitly requests it.
- Prefer deterministic, maintainable and reversible workflows.

## Document Loading

This file is the Factory document entry point. Load only documents required by the task.

- Lesson work: schema and **docs/specs/**
- Series work: **docs/series/**
- Visual-style work: **docs/styles/**
- Character work: **docs/characters/**
- Architecture/migration work: the three architecture documents
- Development priority: **docs/roadmap.md**

Some indexed documents or directories are planned or empty. Their existence and current status must be checked before use.

## Directory Roles

- **schemas/**: lesson data contract; currently being aligned in v0.2
- **docs/specs/**: explanatory rules, not a competing runtime contract
- **docs/series/**: series guidance
- **docs/styles/**: visual-style guidance
- **docs/characters/**: character guidance; currently planned if absent
- **courses/**: course reference material
- **prompts/**: planned prompt resources
- **lessons/**: lesson instances
- **assets/**: media assets
- **scripts/**: current executable implementation; target role is CLI/compatibility
- **src/**: planned formal implementation location; currently placeholder
- **output/**: generated media and temporary artifacts

## Responsibilities

The Factory coordinates lesson creation, consistency, prompts, metadata and optional rendering.
It does not imply that generator, validator, publisher or the target src modules are already implemented.

## Current Scope

Current production priority is English micro-story shadowing:

1. STORY
2. REPEAT
3. SHADOW

Japanese support, publishing automation, web UI, database and advanced generation remain planned unless the roadmap says otherwise.