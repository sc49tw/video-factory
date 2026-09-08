# ESSY Brand Assets

Brand assets for the ESSY video essay series and YouTube channel:

**A Second Look at Life**

This directory contains the canonical visual identity assets shared across
ESSY episodes.

---

## Brand Identity

### Channel Name

**A Second Look at Life**

### Editorial Character

ESSY is a reflective video essay series about the second half of life,
including themes such as:

- time
- work
- aging
- family
- identity
- responsibility
- life choices
- what still matters

The tone should feel:

- calm
- mature
- reflective
- cinematic
- editorial
- observational

Avoid motivational, preachy, sensational, or clickbait presentation.

---

## Canonical Assets

### `avatar.png`

Canonical YouTube channel avatar.

Use for:
- YouTube channel avatar
- channel identity where a square/circular image is required

Do not add episode-specific text or imagery.

---

### `banner.png`

Canonical YouTube channel banner.

The central title and tagline must remain readable within YouTube's
cross-device safe area.

Peripheral scenery may be cropped on smaller devices.

Do not place essential text or branding outside the safe area.

---

### `logo.svg`

Canonical vector logo, if available.

Use when a scalable or transparent brand mark is required.

Do not recreate the logo manually when this asset is available.

---

### `palette.json`

Canonical brand color definitions.

Use these colors as guidance for:
- thumbnails
- titles
- channel graphics
- publication assets

The visual identity should generally use:

- charcoal / near-black
- warm off-white
- muted gold
- restrained warm-neutral photography

Gold is an accent color, not the dominant background color.

---

### `thumbnail-reference.png`

Reference image for the canonical ESSY thumbnail visual language.

This is a style reference, not an episode asset and not a template that
must be reproduced literally.

Episode thumbnails live under:

`projects/<EPISODE-ID>/publication/thumbnail.png`

---

## Thumbnail Visual Language

ESSY thumbnails should generally use:

- one primary person or object
- cinematic environmental context
- natural or golden-hour light where appropriate
- quiet, contemplative body language
- strong negative space for typography
- editorial serif typography
- charcoal / off-white text
- muted gold emphasis on selected words
- small, consistent `A SECOND LOOK AT LIFE` branding

Prefer side views, back views, silhouettes, or naturally observed subjects
over exaggerated facial expressions.

The image should communicate the emotional or conceptual tension of the
episode rather than literally illustrate every part of the narration.

### Thumbnail Copy

Thumbnail copy should be derived from the approved episode narration,
not merely copied or shortened from the video title.

The thumbnail and video title should complement each other.

Prefer a short conceptual hook that remains readable at mobile size.

Avoid:
- long subtitles
- explanatory taglines
- all-caps shouting for emphasis
- bright clickbait yellow
- red arrows
- reaction faces
- collage layouts
- excessive text

---

## Current Thumbnail Examples

Examples of the intended editorial direction:

- ESSY-0001 — `WHAT STILL MATTERS?`
- ESSY-0002 — `WHEN THEY START TO AGE`
- ESSY-0003 — `WHAT IS YOUR TIME WORTH?`

These phrases are episode-specific and are not reusable templates.

The reusable element is the visual and editorial system behind them.

---

## Asset Ownership

Series-level brand assets belong here:

`brand/ESSY/`

Episode-specific publication assets belong under:

`projects/<EPISODE-ID>/publication/`

For example:

projects/ESSY-0003/publication/
├── thumbnail.png
├── youtube.json
└── publication-record.json

Renderer deliverables remain under:

`output/<EPISODE-ID>/`

Do not mix brand assets or publication packaging into renderer output.

---

## Change Policy

Treat the assets in this directory as canonical.

Do not regenerate, overwrite, or materially redesign them as part of
normal episode production.

A brand-level change should be intentional and reviewed separately from
episode production.

New episodes should adapt their imagery and thumbnail hook while preserving
the established ESSY visual identity.

---

## Related Documentation

Production workflow and editorial rules remain defined by the canonical
ESSY production documentation.

This README defines brand asset usage only. It does not replace the ESSY
Episode Runbook or Video Production Playbook.