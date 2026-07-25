# Codex Task: Add Direct Opening (B Version) and Like/Subscribe/Bell Overlay

## Target file

Modify only:

```text
scripts/render-english-v1.1.mjs
```

Do not create another renderer unless necessary.

Do not modify:

- `render-english-prototype.mjs`
- `lesson-import.mjs`
- unrelated scripts
- package configuration
- existing lesson behavior outside the two features below

---

# Feature 1 — B version: direct story opening

Add support for:

```json
"production": {
  "opening_mode": "direct"
}
```

Supported values:

```text
classic
direct
```

Default:

```text
classic
```

Use:

```js
const openingMode = lesson.production?.opening_mode ?? "classic";
```

## `classic`

Keep the current v1.1 behavior unchanged:

1. Hook
2. Intro title
3. STORY transition
4. Story scenes

## `direct`

Skip all three opening clips:

- Hook
- Intro title
- STORY transition

The first rendered clip must be Story Scene 1 with its existing image, subtitle, TTS, progress, phase and layout.

Do not alter any story/repeat/final-round/ending behavior after that point.

Implementation should be minimal:

```js
if (openingMode !== "direct") {
  // existing hook
  // existing intro
  // existing STORY transition
}
```

Do not duplicate the story rendering code.

---

# Feature 2 — top-right Like / Subscribe / Bell animation

Add optional configuration:

```json
"production": {
  "subscribe_overlay": {
    "enabled": true,
    "asset": "assets/overlays/like-subscribe-bell.mov",
    "start_phase": "final_round",
    "delay_seconds": 1.5,
    "duration_seconds": 3.5,
    "width": 360,
    "margin_right": 40,
    "margin_top": 40
  }
}
```

Defaults:

```js
enabled = false
start_phase = "final_round"
delay_seconds = 1.5
duration_seconds = 3.5
width = 360
margin_right = 40
margin_top = 40
```

The asset is expected to be a transparent-background video, preferably:

```text
MOV with ProRes 4444 alpha
```

WebM with alpha may also work if FFmpeg supports it.

---

## Overlay behavior

The overlay must:

- appear in the upper-right corner
- preserve transparent background
- preserve aspect ratio
- appear only during the subtitle-free Final Round story playback
- begin `delay_seconds` after the first Final Round scene starts
- remain visible for `duration_seconds`
- disappear automatically
- never extend or shorten the underlying lesson clips
- never replace the original audio
- not cover the main lower subtitle area
- be disabled safely when the asset is absent

If:

```js
enabled === true
```

but the asset file does not exist, print a warning and render normally without the overlay.

Example warning:

```text
Subscribe overlay asset not found; rendering without overlay.
```

---

# Recommended implementation

Because each lesson scene is currently rendered as a separate clip, the easiest safe implementation is to add overlay parameters to `makeVideoClip()` and apply the animation only to Final Round clips.

Extend `makeVideoClip()` with optional parameters:

```js
overlayVideoPath
overlayStartSeconds
overlayDurationSeconds
overlayWidth
overlayMarginRight
overlayMarginTop
```

Do not change behavior when `overlayVideoPath` is empty.

When the overlay exists:

1. Add it as an additional looping video input.
2. Scale it to `overlayWidth` while preserving aspect ratio.
3. Preserve alpha.
4. Overlay it using:

```text
x=W-w-marginRight
y=marginTop
```

5. Enable it only during:

```text
between(t, overlayStartSeconds, overlayStartSeconds + overlayDurationSeconds)
```

The overlay asset should not contribute audio. Explicitly ignore its audio stream.

Suggested FFmpeg filter concept:

```text
[overlayInput:v]
scale=OVERLAY_WIDTH:-1,
format=rgba,
setpts=PTS-STARTPTS
[cta];

[base][cta]
overlay=
x=W-w-MARGIN_RIGHT:
y=MARGIN_TOP:
enable='between(t,START,END)'
[v]
```

Keep the existing `[v]` chain intact except for inserting the overlay immediately before final `format=yuv420p`.

---

## Applying only during Final Round

Update `addFullLessonPass()` to accept optional overlay configuration.

Example:

```js
function addFullLessonPass({
  clips,
  segments,
  fontPath,
  clipIndex,
  phase,
  hint,
  key,
  audioOnly = false,
  overlay
})
```

Only pass overlay configuration here:

```js
clipIndex = addFullLessonPass({
  clips,
  segments: shadowSegments,
  fontPath,
  clipIndex,
  phase: "SHADOW",
  hint: "Speak along",
  key: "shadow",
  audioOnly: true,
  overlay: subscribeOverlay
});
```

Do not pass it to Story or Repeat clips.

---

## Handling overlay timing across multiple Final Round clips

The overlay should start relative to the beginning of the whole Final Round sequence, not restart on every sentence.

Maintain elapsed Final Round time while creating clips.

For each clip:

```js
const clipStart = elapsedSeconds;
const clipEnd = clipStart + duration;
const overlayGlobalStart = delaySeconds;
const overlayGlobalEnd = delaySeconds + durationSeconds;
```

Determine intersection:

```js
const localStart = Math.max(0, overlayGlobalStart - clipStart);
const localEnd = Math.min(duration, overlayGlobalEnd - clipStart);
```

Apply overlay only when:

```js
localEnd > localStart
```

Then pass:

```js
overlayStartSeconds: localStart
overlayDurationSeconds: localEnd - localStart
```

This prevents the animation from restarting on each sentence.

If the overlay asset itself is shorter than the configured duration, do not loop indefinitely unless required. Prefer playing once. Clamp visible duration to the asset duration if necessary.

---

# Example lesson.json for B version plus animation

```json
{
  "production": {
    "opening_mode": "direct",
    "subscribe_overlay": {
      "enabled": true,
      "asset": "assets/overlays/like-subscribe-bell.mov",
      "start_phase": "final_round",
      "delay_seconds": 1.5,
      "duration_seconds": 3.5,
      "width": 360,
      "margin_right": 40,
      "margin_top": 40
    }
  }
}
```

Expected flow:

```text
Story Scene 1
Story Scene 2
Story Scene 3
Story Scene 4
LET'S PRACTICE
Repeat section
FINAL ROUND transition
Final Round Scene 1
  after 1.5 seconds: overlay appears in upper-right
Final Round continues
overlay disappears after 3.5 seconds
Ending CTA
```

---

# Validation

Run:

```bash
node --check scripts/render-english-v1.1.mjs
```

Render lesson 008 with:

```bash
node scripts/render-english-v1.1.mjs lessons/en-junior-high/en-junior-high-008.json
```

Confirm:

1. With `opening_mode: "direct"`, the first frame is Story Scene 1.
2. No Hook, Intro or STORY transition appears.
3. `LET'S PRACTICE`, Repeat, Final Round and Ending remain unchanged.
4. The three-part animation appears only in the Final Round.
5. It appears in the upper-right.
6. Alpha transparency is preserved.
7. It does not restart for every sentence.
8. It does not alter lesson duration.
9. It does not add or replace audio.
10. Missing asset produces only a warning.
11. Without the new JSON fields, current v1.1 behavior is unchanged.
12. Output remains 1920×1080.

Before finishing, inspect the diff and remove all unrelated changes.
