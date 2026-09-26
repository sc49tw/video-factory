# ESSY Series Grammar

> Canonical ESSY editorial rules governing opening, identity, body, and ending structure.
> Version 1.0 — codified from retrospective analysis of completed ESSY-0001/0002/0003.

## Overview

ESSY is a reflective video-essay series. This document defines the editorial
structure that all ESSY episodes follow, derived from retrospective analysis
of completed episodes (ESSY-0001/0002/0003).

This grammar is **editorial** — it governs WHAT appears and WHEN, not HOW
the renderer implements it. Renderer implementation lives in the render scripts
and shared identity helpers.

---

## G1: Narration starts immediately (t=0)

Normal ESSY does NOT begin with a silent standalone title/pre-roll.
Narration (the content hook) begins at t=0 on the main timeline.

- N001 (the first narration block) is the content hook
- Footage begins at t=0 simultaneously with narration
- Subtitles begin with narration if applicable
- There is NO silent pre-roll by default

A standalone silent pre-roll/title card before content is NOT the normal
ESSY default. Any such pre-roll requires an explicit episode-level editorial
decision documented in the episode metadata.

---

## G2: Content hook precedes identity

The opening narration block (typically N001) is the content hook. It plays
in full before ANY series/episode identity reveal.

- N001 hook content plays completely
- During N001: narration ON, subtitles ON, footage plays
- Identity does NOT appear until after N001 ends

The hook establishes the essay's thematic question/premise before the
series and episode titles appear.

---

## G3: Identity reveal occurs over continuing visual timeline

The default ESSY identity reveal occurs AFTER the hook, over CONTINUING
visual footage.

- Footage CONTINUES (no cut to separate title card or black screen)
- Identity reveal OVERLAYS the continuing footage
- Standalone pre-roll/title card is NOT the normal ESSY default
- Any standalone pre-roll requires explicit episode-level editorial decision

---

## G4: Opening identity contains series title AND episode title

The opening identity reveal contains both the series title and episode title.

- Series title (e.g., "A SECOND LOOK AT LIFE")
- Episode title (e.g., "Who Am I Beyond My Roles?")

Both titles appear in the opening, over the continuing visual timeline.

---

## G5: Identity parameters are episode-level editorial decisions

These aspects of identity reveal are episode-level editorial parameters,
represented in canonical metadata (openingIdentity):

- **Timing**: When identity appears (start time, duration)
- **Presentation**: Single vs sequential reveal of titles
- **Narration suppression**: Whether narration is suppressed during identity
- **Subtitle suppression**: Whether subtitles are suppressed during identity

These are NOT hardcoded series rules — they are per-episode editorial
decisions expressed in the openingIdentity metadata field.

---

## G6: Essay continues seamlessly after identity

After the identity reveal, the essay body continues seamlessly.

- N002 (next narration block) begins normally
- Narration resumes
- Subtitles resume (if applicable)
- Footage continues the visual timeline

There is NO visual or editorial break between identity and body.

---

## G7: Ending = final footage hold + series title ONLY

The ending consists of:

- **Final footage hold**: Last approved visual shot holds after narration ends
- **Series title ONLY**: Series title appears — episode title does NOT appear
- **No narration**: Narration has ended before/during the hold
- **BGM**: May finish/fade according to episode metadata

---

## G8: Narration ends during ending hold; BGM follows episode metadata

- Narration has ended before the ending hold begins
- BGM may finish naturally or fade per episode music metadata
- Ending hold itself carries NO narration
- Subtitles are NOT displayed during ending hold

---

## Metadata Contract: openingIdentity

The openingIdentity field in the production package expresses the episode's
opening identity editorial decisions.

Required fields:
- seriesTitle: The series title text
- episodeTitle: The episode title text
- timing.startSec: Absolute start time on main timeline (seconds from t=0)
- timing.durationSec: Duration of identity reveal (seconds)

Optional fields:
- presentation.mode: "simultaneous" (both titles together) or
  "sequential" (series first, then episode)
- narrationSuppression.enabled: Whether narration is suppressed (default: true)
- subtitleSuppression.enabled: Whether subtitles are suppressed (default: true)

---

## Pre-roll (explicit only, NOT default)

A standalone pre-roll (silent title card before main program) is NOT the
normal ESSY default. It may be used ONLY when explicitly requested per episode.

When a pre-roll IS explicitly requested:
- It is a separate SEGMENT prepended to the main program
- Main program's t=0 remains the start of N001
- Pre-roll has NO narration, NO subtitles
- Pre-roll duration = delivery offset for main program

The default is: NO standalone pre-roll.

---

## Cold open experiment (ESSY-0003 backward compatibility)

ESSY-0003's coldOpenExperiment metadata remains backward compatible.
Episodes using this mechanism are unaffected by the openingIdentity contract.

---

## Renderer Contract

BOTH renderers MUST consume the same openingIdentity semantics:

1. Hook boundary: N001 end / identity start
2. Identity timing: startSec + durationSec from metadata
3. Title text: seriesTitle + episodeTitle from metadata
4. Presentation order: Simultaneous or sequential
5. Visual continuation: Footage continues (NOT separate card)
6. Narration suppression: Muted during identity window
7. Subtitle suppression: Suppressed during identity window
8. Body resume: N002 begins normally after identity

---

## Backward Compatibility

- ESSY-0001/0002: Legacy title timing fields. Behavior preserved as-is.
- ESSY-0003: coldOpenExperiment. Backward compatible; not migrated.
- ESSY-0004+: openingIdentity is the preferred canonical path.

