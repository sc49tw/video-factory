# Language Shadowing Factory

Language Shadowing Factory is a planned automated content generation pipeline for language shadowing materials. The long-term goal is to generate structured lessons, TTS audio, subtitles, images, short-form videos, and publishing metadata from course topics.

## Initial Target Courses

- English review for weak Taiwan junior-high Grade 9 students
- Japanese shadowing for JLPT N4 adult learners

## Planned Pipeline

```text
topic
  |
lesson generator
  |
lesson.json
  |
validator
  |
TTS / subtitles / images
  |
video renderer
  |
output
  |
publisher
```

## Project Structure

```text
courses/
  en-junior-high/
  ja-n4/
prompts/
schemas/
  lesson.schema.json
src/
  generator/
  validator/
  tts/
  image/
  renderer/
  publisher/
lessons/
  examples/
    en-junior-high.example.json
    ja-n4.example.json
output/
package.json
README.md
```

## Current Phase

This repository is currently in the bootstrap and data-contract phase only. It contains the initial project structure, the first `lesson.json` schema, and example lesson files. No generation pipeline, application code, dependencies, frameworks, validation libraries, or publishing integrations have been added yet.

## Import a Downloaded Lesson

Put one lesson JSON, four scene images, and one YouTube thumbnail among the newest downloads in the current Windows user's `Downloads` folder, then run:

```powershell
pnpm lesson:import
```

The importer scans `lessons/en-junior-high/`, chooses the next lesson number, and uses the newest JSON plus the newest five PNG images. A uniquely named image containing `thumbnail`, `thumb`, `youtube`, or `yt` is selected automatically. Otherwise, the command lists the five candidates and asks which one is the thumbnail. The other four images become `scene01` through `scene04` in oldest-to-newest download order.

Before moving files, it validates the segment structure, candidate count, references, and destination paths. Existing targets are never overwritten. It updates `lesson_id`, scene and thumbnail paths, and `output_path`, validates all imported images, then renders `output/<lesson_id>.mp4`.

For a non-interactive terminal, select the thumbnail explicitly:

```powershell
pnpm lesson:import -- --thumbnail 5
pnpm lesson:import -- --thumbnail downloaded-thumbnail.png
```

For an import-only verification without rendering, run `pnpm lesson:import -- --no-render`.

