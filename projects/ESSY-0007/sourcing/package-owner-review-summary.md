# ESSY-0007 — PACKAGE Owner Review Summary

**Workflow:** `PACKAGE / in_progress`
**Scope:** draft PACKAGE only. PACKAGE approval, production-asset download, rendering, commit, and push were not run.

## Delivery-time Opening Identity

The Owner-approved identity is a delivery-time insertion, not a pre-roll or an overlay over N002. Canonical TTS, VTT, WordBoundary bytes, block-relative timing, approved script, storyboard, and approved asset map remain unchanged.

| Delivery interval | Content | Result |
|---|---|---|
| `[0.000, 32.568)` | N001, unchanged | PASS |
| `[32.568, 36.568)` | 4.000 s identity; sequential series then episode title; continuous N001-S4 footage; narration/subtitles suppressed | PASS |
| `36.568` | N002 block delivery start (`32.568 + 4.000`) | PASS |
| `36.618` | N002 first WordBoundary speech (`32.618 + 4.000`) | PASS |
| `[36.568, 282.616)` | N002–N008, each delivery timestamp is canonical timestamp +4.000 s | PASS |

The source narration-master duration remains **278.616 s**. The delivery programme base becomes **282.616 s** before any separately approved ending hold.

### Continuous-background handle

N001-S4 uses approved moving source `pexels-video-6279151`. Its approved canonical playback is `[23.132, 32.568)` = 9.436 s; the reviewed decoded source is 15.750 s. Continuing the same source for the identity requires 13.436 s total source playback and leaves **2.314 s** of verified tail. The shared plan therefore uses `extend-source-tail`: no loop, freeze, substitute, black frame, or standalone title-card segment.

## Renderer support matrix

| Component | Delivery insertion support | Result |
|---|---|---|
| 1080p production renderer | `buildOpeningDeliveryPlan()` extends the hook source, shifts later shots, uses the same insertion for subtitles, and inserts `anullsrc` silence into the narration mix | PASS |
| 540p review renderer | Uses the same grammar/plan; rebuilds narration from original block MP3s with a 4.000 s `anullsrc` segment and the same subtitle insertion | PASS |
| Shared subtitle builder | Keeps VTT/WordBoundary block-relative; shifts blocks at/after boundary by exactly insertion duration and rejects identity overlaps | PASS |
| Narration master | Source master stays unchanged; delivery mix cuts at 32.568 s, inserts 4.000 s stereo silence, then resumes sample sequence | PASS |
| Visual / BGM / ending timing | N001-S4 extends only into verified unused source tail; N002–N008 shift +4.000 s; visual master and BGM use delivery duration; ending hold remains distinct | PASS |
| Renderer parity | Review and production require the same ESSY grammar for ESSY-0007 and consume the same shared plan/subtitle insertion | PASS |

## PACKAGE validation

| Area | Result | Evidence / remaining action |
|---|---|---|
| Frozen English / title metadata | PASS | `script.md` has N001–N008; `titles.json` remains visual-only and outside TTS. |
| Storyboard / approved selection | PASS | 32 canonical storyboard slots match 32 approved-map items. Gate 2 map has 28 unique assets with only two declared continuous-use exceptions. |
| Source-duration fit / reuse | PASS (selection evidence) | All 32 duration records cover their canonical narration slot. N002-S1/S2 share 69.72 s for 16.343 s continuously; N008-S1–S4 use 20.56 s for 20.328 s. |
| Opening background source tail | PASS (selection evidence) | N001-S4 has 2.314 s reviewed tail remaining after its 4.000 s delivery extension. Production bytes will be re-probed after approval. |
| Provenance | PASS | Pexels URLs/license and decoded/integrity evidence are indexed by the approved map into v1–v4 review records. |
| TTS / WordBoundary / narration timing | PASS | 8 Azure MP3s, VTT parent windows, and WordBoundary artifacts are retained. Manifest total is 278.616 s across 8 blocks. |
| Draft package contract | PASS | Schema-supported `openingIdentity` records title/timing/presentation/suppression. Delivery insertion semantics live in the shared delivery-plan contract rather than unsupported duplicate metadata. |
| Real media assembly preflight | WARN — deferred by design | Formal production assets and `assembly-timeline.json` do not exist before PACKAGE approval. The preflight re-probes downloaded approved bytes and rejects insufficient tail before render. |
| PACKAGE approval / workflow | NOT RUN | Draft remains `PACKAGE / in_progress`; no approval command or state transition was run. |

## Validation commands and results

| Command | Result |
|---|---|
| `pnpm test:opening` | PASS — shared insertion, silence window, subtitle shift/suppression, source-tail guard, renderer parity, legacy compatibility |
| `pnpm test:essy-package` | PASS — package schema/runtime validation, including the ESSY-0007 identity regression |
| `pnpm run typecheck` | PASS — syntax checks for renderer, opening-plan/delivery, subtitle, package, and contract modules |

## Remaining Owner action

The draft is technically ready for Owner PACKAGE review, subject only to the intentionally deferred ASSETS-stage production-byte probe. No PACKAGE approval has been inferred or recorded.
