# Easy English Shadowing Renderer v2 Specification

## Objective

Create a new renderer:

```text
scripts/render-english-v2.mjs
```

Do not modify or delete:

```text
scripts/render-english-prototype.mjs
```

The new renderer must remain backward-compatible with all existing lesson JSON files.

---

## Existing pipeline

1. GPT creates:
   - script
   - scene01.png–scene04.png
   - lesson.json
   - thumbnail.png
2. `lesson-import.mjs` moves the files into the project and invokes a renderer.
3. GPT creates the YouTube title and description.

For lessons #008 and #009, the assets and lesson JSON already exist. They should be regenerated from step 2b only: render the existing lesson JSON without importing or moving files again.

---

## Required video flow

Use this sequence:

```text
Hook
Story transition
Complete story
Practice transition
Listen and repeat
Final-round transition
Shadow without subtitles
Ending challenge
```

Target total duration: approximately 60–75 seconds for a four-sentence lesson.

---

## 1. Hook

### Purpose

The first frame must create curiosity immediately instead of presenting a conventional course title card.

### Duration

Default:

```text
1.8 seconds
```

Allow override:

```json
{
  "production": {
    "hook": {
      "duration_seconds": 1.8
    }
  }
}
```

### Background image

Use this priority:

1. `lesson.production.hook.background_image`
2. Last story segment image
3. First story segment image
4. Existing fallback image

The image should fill the 1920×1080 frame. A dark blur or overlay may be applied to keep text readable.

### Hook text priority

1. `lesson.youtube.hook`
2. `lesson.hook`
3. `lesson.title`

Example:

```json
{
  "youtube": {
    "hook": "He waved at the wrong person."
  }
}
```

### On-screen text

Primary line:

```text
<resolved hook>
```

Secondary line:

```text
Easy English Story
```

Do not show the episode number or series title in the first frame.

---

## 2. Story transition

### Duration

```text
1.2 seconds
```

### Text

```text
STORY
Watch and listen
```

Remove:

```text
Step 1 of 3
Watch and listen to the complete story
Just listen first
```

---

## 3. Complete story

Play every story segment once.

Display:

- Scene image
- English sentence
- Progress indicator
- Phase: `STORY`
- Hint: `Watch and listen`

### Progress format

For four segments:

```text
Sentence 1 of 4   ● ○ ○ ○
Sentence 2 of 4   ● ● ○ ○
Sentence 3 of 4   ● ● ● ○
Sentence 4 of 4   ● ● ● ●
```

Generate the same pattern dynamically for any number of segments.

---

## 4. Practice transition

### Duration

```text
1.0 second
```

### Text

```text
LET'S PRACTICE
Listen, then repeat.
```

Use the existing transition sound when available.

---

## 5. Listen and repeat

For each segment:

1. Play the sentence audio while displaying:
   - phase: `REPEAT`
   - sentence text
   - progress
   - hint: `Listen`
2. Keep the configured silent response interval.
3. During the silent interval, display:
   - the same sentence
   - the same progress
   - hint: `Your turn`

Do not show a `3, 2, 1` countdown.

### Pause configuration

Continue supporting the existing values:

```json
{
  "shadowing": {
    "sequence": [
      {
        "type": "repeat",
        "pause_after_seconds": 3
      }
    ]
  }
}
```

Fallback remains 3 seconds.

---

## 6. Final-round transition

### Duration

```text
1.5 seconds
```

### Text

```text
FINAL ROUND
No subtitles. Just shadow.
```

Use the existing final-round cue when available.

---

## 7. Shadow pass

Play the full story again using the shadow sequence.

Display the scene images without sentence text.

Do not display:

- subtitles
- progress
- hints
- countdown

The learner should listen and speak along.

---

## 8. Ending challenge

### Duration

Default:

```text
2.0 seconds
```

### Text

Phase:

```text
GREAT WORK
```

Primary line priority:

1. `lesson.youtube.cta`
2. Dynamically generated fallback:
   - Four segments: `Can you say all four sentences?`
   - Other counts: `Can you say the whole story?`

Secondary line:

```text
New stories every week
```

Use the existing ending audio.

Example:

```json
{
  "youtube": {
    "cta": "Can you shadow the whole story?"
  }
}
```

---

## 9. Typography and mobile readability

Keep the existing 1920×1080 resolution and overall layout.

Adjust the lesson subtitle style:

- Increase English text size slightly where practical.
- Increase text border width from 4 to approximately 6.
- Keep high-contrast white text with a dark outline.
- Preserve automatic text fitting for long sentences.
- Do not place critical text near the outer edges.

Do not introduce external font dependencies beyond the existing font candidates.

---

## 10. Compatibility requirements

The renderer must continue supporting:

- `lesson.content.segments`
- `lesson.segments`
- `lesson.content_segments`
- `lesson.shadowing.sequence`
- `lesson.learning_flow`
- existing scene image resolution logic
- Edge TTS with Windows SAPI fallback
- current cue audio files
- current FFmpeg and ffprobe resolution
- current output naming:
  `output/<lesson_id>.mp4`

Old lesson JSON files without `youtube.hook` or `youtube.cta` must render successfully.

---

## 11. Error handling

Preserve the existing fail-fast behavior for:

- missing lesson ID
- missing lesson title
- missing segments
- invalid sequence segment IDs
- failed FFmpeg execution
- unavailable fonts
- unavailable FFmpeg or ffprobe

Do not silently skip failed clips.

---

## 12. Code constraints

- Do not rewrite the pipeline architecture.
- Reuse the existing helper functions where practical.
- Avoid adding npm dependencies.
- Keep the implementation in a single `.mjs` file.
- Preserve Windows compatibility.
- Use only Node.js built-in modules plus the existing command-line tools.
- Do not modify `lesson-import.mjs` in this task.
- Do not modify `render-english-prototype.mjs`.

---

## 13. Validation

Run:

```bash
node --check scripts/render-english-v2.mjs
```

Then render:

```bash
node scripts/render-english-v2.mjs lessons/en-junior-high/en-junior-high-008.json
node scripts/render-english-v2.mjs lessons/en-junior-high/en-junior-high-009.json
```

Confirm:

- Both MP4 files are produced.
- Resolution is 1920×1080.
- Video and audio durations are close.
- No countdown numerals appear.
- Hook uses the last scene when no explicit hook background is supplied.
- Old lesson JSON remains valid.
