# ESSY render stabilization

## Outcome and honest current status

ESSY-0004 v13 fixed the episode review. It did not finish a reusable end-to-end
renderer. The final path still rejects openingIdentity. Before the next normal
episode BUILD, complete the parity work below; do not repeat it inside another
episode's production run. No new human approval gate is introduced.

## What cost time

| Failure | Durable prevention | Current status |
| --- | --- | --- |
| Metadata changed but the renderer ignored it | One validated composition plan used by review and final | Shared opening plan exists; final integration pending |
| Missing named exports found when rendering | Cheap import/export preflight before ffmpeg | Basic preflight implemented |
| Full render used to discover opening/layout defects | Short opening, body transition, ending samples first | Required operating procedure; automatic sample command pending |
| Identity window overlapped spoken body | Insert time, preserve local audio/VTT timing, shift body together | Review implemented; regression fixture passes |
| libass and final renderer interpreted style differently | Shared units and color; pixel comparison at both resolutions | Review conversion fixed; automated cross-resolution comparison pending |
| FFmpeg graph failed during full encode | Stage visual inputs; promote output only after successful process | Review staged; full QA-before-promotion still pending |
| Repeated fixes did not establish final readiness | Track capability gaps, require review/final parity | Final explicitly blocked instead of silently wrong |

## Next implementation work, in order

1. Unify composition: opening, block offsets, subtitle offsets, ending and
   music windows must come from one delivery plan. Review and final may differ
   in resolution/encoding only, not editorial timing. Port the existing review
   insertion to final without creating an episode-specific workaround.
2. Add one short smoke-render command covering the hook → identity → body
   boundary and ending, using the same production path at 540p and 1080p.
   Check frames and audio before a full render. Stop on the first failed
   checkpoint; do not launch the next full encode speculatively.
3. Freeze a small reusable fixture from synthetic timing/media: narration text
   and duration preserved, no spoken/subtitle title window, first body word
   retained, title order correct, end card without subtitle, equivalent layout
   at both resolutions. Do not rerender published episodes as regression tests.
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
6. `pnpm video:preflight <EP> final` must pass before approved final work.
   Currently it intentionally fails for openingIdentity; that is an unfinished
   capability, not a request for the user to override the check.

## Definition of convergence

Do not declare the process stabilized because documentation or unit tests
exist. Require: the same fixture succeeds through review and final; a new
episode can use approved metadata without renderer edits; no missing input or
opening/style failure is first discovered in a full encode; and the run log
records the actual number of rerenders and elapsed time. Target one full review
plus one final encode, excluding user-requested creative revisions. This is a
target to measure, not a promised completion time.

Episode evidence: projects/ESSY-0004/qa-v10/review.md and qa-v13/review.md.
