# ESSY render stabilization

## Outcome and honest current status

ESSY-0004 v13 fixed the episode review, and the final path now consumes the
same shared opening-identity plan (ESSY-0004 `output/…-final-v1.mp4` rendered
395.162 s with the identity intact). The remaining gaps below are engineering
follow-ups, not a blocked final renderer; complete them before the next normal
episode BUILD rather than repeating the work inside another episode's
production run. No new human approval gate is introduced. The authoritative
opening/identity semantics live in [ESSY_SERIES_GRAMMAR.md](ESSY_SERIES_GRAMMAR.md);
this document does not restate them.

## What cost time

| Failure | Durable prevention | Current status |
| --- | --- | --- |
| Metadata changed but the renderer ignored it | One validated composition plan used by review and final | Shared opening plan consumed by both renderers and covered by regression tests |
| Missing named exports found when rendering | Cheap import/export preflight before ffmpeg | Basic preflight implemented |
| Full render used to discover opening/layout defects | Short opening, body transition, ending samples first | Required operating procedure; automatic sample command pending |
| Identity window overlapped spoken body | Insert time, preserve local audio/VTT timing, shift body together | Review implemented; regression fixture passes |
| libass and final renderer interpreted style differently | Shared units and color; pixel comparison at both resolutions | Review conversion fixed; automated cross-resolution comparison pending |
| FFmpeg graph failed during full encode | Stage visual inputs; promote output only after successful process | Review staged; full QA-before-promotion still pending |
| Repeated fixes did not establish final readiness | Track capability gaps, require review/final parity | Final explicitly blocked instead of silently wrong |

## Next implementation work, in order

1. ~~Unify composition~~ **Done.** Opening, block offsets, subtitle offsets,
   ending and music windows come from one delivery plan
   (`scripts/essay-opening-plan.mjs` → `scripts/essay-opening-delivery.mjs`),
   consumed by both renderers; review and final differ in resolution/encoding
   only. Regression coverage: `pnpm test:opening`.
2. Add one short smoke-render command covering the hook → identity → body
   boundary and ending, using the same production path at 540p and 1080p.
   Check frames and audio before a full render. Stop on the first failed
   checkpoint; do not launch the next full encode speculatively.
3. ~~Freeze a small reusable fixture~~ **Done.** `pnpm test:opening` holds a
   synthetic fixture plus the approved ESSY-0004 metadata; it asserts narration
   text and duration preservation, a subtitle-free identity window, the first
   body word, title order, the end card without subtitles, and equivalent
   layout at both resolutions. Published episodes are never rerendered as
   regression tests.
4. Cache stages by input/config/renderer hashes. Reuse unchanged TTS, source
   media and visual segments; invalidate only affected stages. Record cache
   hits, failed encodes, render wall time and manual correction rounds.

## Operating sequence

1. Read authoritative draft state and approved inputs; inventory renderer
   changes. Do not treat an edited package as retroactively approved.
2. `pnpm video:preflight <EP> review` checks current exports, input presence,
   hook boundary, and enough unused approved footage for identity. This is a
   basic readiness check, not a complete production gate.
3. Run subtitle and identity/insertion regressions for relevant code changes.
4. Render and inspect short boundary samples. A metadata-only episode should
   not require shared renderer edits; if it does, resolve the missing generic
   capability before continuing full production.
5. Render one full review, technical QA, then human review under existing gates.
6. `pnpm video:preflight <EP> final` must pass before approved final work. For
   an `openingIdentity` episode it reports the shared plan and
   `finalParity: READY`; it still fails legitimately when the identity timing
   does not follow the complete hook or the hook shot lacks enough unused
   approved footage, and that failure is a real finding, never a reason to
   override the check.

## Definition of convergence

Do not declare the process stabilized because documentation or unit tests
exist. Require: the same fixture succeeds through review and final; a new
episode can use approved metadata without renderer edits; no missing input or
opening/style failure is first discovered in a full encode; and the run log
records the actual number of rerenders and elapsed time. Target one full review
plus one final encode, excluding user-requested creative revisions. This is a
target to measure, not a promised completion time.

Episode evidence: projects/ESSY-0004/qa-v10/review.md and qa-v13/review.md.
