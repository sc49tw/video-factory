# Codex Task: Create render-english-v1.1.mjs with exactly five behavioral changes

## Source of truth

Start from:

```text
scripts/render-english-prototype.mjs
```

Create:

```text
scripts/render-english-v1.1.mjs
```

Do **not** use `render-english-v2.mjs` as the base.

The objective is to preserve the proven v1 presentation and rendering behavior, while making exactly five narrowly scoped improvements.

---

## Absolute constraints

1. Copy `render-english-prototype.mjs` to `render-english-v1.1.mjs`.
2. Do not modify `render-english-prototype.mjs`.
3. Do not modify `lesson-import.mjs`.
4. Do not add dependencies.
5. Do not refactor, rename, reorder, reformat, or clean up unrelated code.
6. Keep all existing:
   - image sizes and positions
   - fonts and font sizes
   - text colors
   - border widths
   - story transition
   - final-round transition
   - TTS behavior
   - FFmpeg behavior
   - audio cues
   - lesson JSON compatibility
   - output naming
7. The final diff against v1 must contain only code needed for the five changes below.

---

# The five changes

## Change 1 — Add a short opening hook before the existing v1 intro

Add one new hook clip immediately before the existing v1 title/intro clip.

### Hook content

Text priority:

```js
lesson.youtube?.hook ?? lesson.hook ?? lesson.title
```

Background priority:

```js
storySegments.at(-1)?.image ?? storySegments[0]?.image
```

### Hook presentation

- Duration: 1.8 seconds
- Use the existing v1 full-screen title-image layout.
- Keep the image sharp.
- Do not add Gaussian blur.
- Do not redesign the title layout.
- Show only the resolved hook text.
- Do not show `Easy English Story`.
- Do not remove or alter the existing v1 intro/title clip that follows it.
- Use the existing intro cue only on the existing intro clip, not on the new hook clip.

Old lesson JSON without `youtube.hook` must still work through the fallback to `lesson.title`.

---

## Change 2 — Rename the practice transition only

In the existing practice transition, change:

```text
YOUR TURN
Listen. Then repeat.
```

to:

```text
LET'S PRACTICE
Listen, then repeat.
```

Do not change its duration, layout, background, font, colors, or cue audio.

---

## Change 3 — Add progress dots without changing layout

Where v1 currently produces:

```text
Sentence 1 of 4
```

change the generated progress string to:

```text
Sentence 1 of 4   ● ○ ○ ○
```

For later sentences:

```text
Sentence 2 of 4   ● ● ○ ○
Sentence 3 of 4   ● ● ● ○
Sentence 4 of 4   ● ● ● ●
```

Requirements:

- Generate dots dynamically for any segment count.
- Use the existing progress text position, font size, and color.
- Apply this to the normal story pass and repeat pass wherever v1 currently displays sentence progress.
- Do not display progress during the subtitle-free shadow pass.

A small helper such as `formatProgress(segmentIndex, totalSegments)` is allowed.

---

## Change 4 — Remove the numeric countdown but preserve the full pause

V1 currently generates one clip per countdown number.

Replace that loop with one silent `Your turn` clip whose duration equals the configured repeat pause.

Example:

```js
const repeatPauseSeconds = getRepeatPauseSeconds(repeatSequence, segmentIndex);
```

Then create a single clip:

- duration: `repeatPauseSeconds`
- hint: `Your turn`
- countdown: empty
- same image
- same sentence
- same phase
- same progress

Do not shorten the learner response time.

Do not remove the existing `countdown` parameter or countdown rendering support elsewhere unless removal is strictly required. Minimal change is preferred.

---

## Change 5 — Replace only the ending message with a lesson CTA

Keep the existing v1 ending clip layout, background, duration, and ending audio.

Replace:

```text
GREAT WORK
See you next time.
```

with:

```text
GREAT WORK
<resolved CTA>
```

CTA priority:

```js
lesson.youtube?.cta
  ?? (storySegments.length === 4
    ? "Can you say all four sentences?"
    : "Can you say the whole story?")
```

Do not add another line such as `New stories every week`.

---

# Explicitly prohibited changes

Do not:

- enlarge or shrink scene images
- move subtitles
- change subtitle font size
- change `borderw`
- change colors
- blur hook or scene images
- remove the original intro/title
- shorten or remove the STORY transition
- modify the FINAL ROUND wording
- modify shadow-pass behavior
- change `repoRoot`
- change FFmpeg paths
- modify importer behavior
- edit package scripts
- touch v2
- reformat the whole file

---

# Validation

Run:

```bash
node --check scripts/render-english-v1.1.mjs
```

If lesson assets are available, render:

```bash
node scripts/render-english-v1.1.mjs lessons/en-junior-high/en-junior-high-008.json
```

Confirm:

1. Hook appears before the original v1 intro.
2. Original v1 intro remains unchanged.
3. Story layout looks identical to v1.
4. Practice transition says `LET'S PRACTICE`.
5. Progress dots appear.
6. No countdown numerals appear.
7. The silent response time is unchanged.
8. Final round remains identical to v1.
9. Ending uses the CTA.
10. Output remains 1920×1080.

---

# Diff audit

Before finishing, compare:

```bash
git diff --no-index scripts/render-english-prototype.mjs scripts/render-english-v1.1.mjs
```

Review every changed line.

Remove any change that is not strictly required for one of the five behaviors above.

---

# Final response

Report:

1. The file created.
2. The five implemented changes.
3. Syntax-check result.
4. Render-test result, if run.
5. Confirmation that v1 and `lesson-import.mjs` were not modified.
6. Any unavoidable assumption.

Do not make unrelated changes.
