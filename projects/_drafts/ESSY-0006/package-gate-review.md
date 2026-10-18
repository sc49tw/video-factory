# ESSY-0006 PACKAGE Gate review — BLOCKED

This is a review record, not a production package or an approval. Draft state is
`PACKAGE / in_progress`; English and Scenes are approved, PACKAGE is not.

## Findings

- The ESSY package contract requires an `approvedAssets` reference. No
  `projects/ESSY-0006/sourcing/approved-slot-asset-map.json` exists. The
  approved storyboard's selection revision identifies N004-S4 (Pexels
  39889654) and N006-S2 (6756335); the other 29 planned sources appear in
  `temp/essy-0006-roughcut-v01/provenance-preview.json` as provisional
  `candidate` / `approved: false`, not an approved production selection map.
  They must not be silently relabelled as approved.
- `state.yaml` records PREPARE as completed with `totalDurationSec: 349.248`,
  whereas the current canonical eight-block manifest, files and WordBoundary
  artifacts agree on **436.536 seconds**. This stale PREPARE summary needs a
  workflow-consistent resolution before relying on the package handoff.
- The current provisional `roughcut-v03-shot-list.json` still uses the old
  N006-S2 asset and timing. It is not an approved asset map or a completed
  package allocation. It must be corrected after the approval issues are
  resolved, without changing the approved storyboard or narration.

## Non-rendering checks

- All eight canonical MP3 durations match the current manifest; all eight
  Azure WordBoundary artifacts match their manifest text hash and audio
  duration. Their total is 436.536 seconds.
- All 31 planned source files, including N004-S4 39889654 and N006-S2
  6756335, exist and match their provenance SHA-256. Their ffprobe durations
  cover the provisional allocations, including the N006 replacement timing.
  This is a technical fit check, not asset-selection approval.
- N006 provisional unquantized allocation: S1 14.965s, S2 17.069s,
  S3 8.216667s, S4 21.141333s, total 61.392s. The reviewed 30-fps S2
  is 512 frames (17.066667s); its end at block-relative 32.033333s is
  0.000667s before the `At` WordBoundary at 32.034s. `Nothing.` is at
  30.222–31.097s. Frame quantization must remain explicit in any assembly.
- `pnpm test:essy-package`: 9 tests passed. These are contract regression
  tests, not validation of a complete ESSY-0006 package or asset approvals.

## Human decisions

Review and explicitly approve or revise the 29 remaining provisional source
selections as a complete slot-to-asset map. Resolve the stale PREPARE record
using the supported workflow without assuming the existing summary describes
the current 436.536-second audio. Then prepare and validate the canonical
package for a separate PACKAGE Gate decision. No PACKAGE approval is recorded.
