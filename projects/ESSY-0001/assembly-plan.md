# ESSY-0001 — Full Real-Asset Assembly Plan

Status: APPROVED — all 60 slots resolved (D1–D5); ready for production-renderer implementation
Governing rules: `docs/ESSY_VIDEO_PRODUCTION_PLAYBOOK.md` v1.1 §7 · Episode spec: `projects/ESSY-0001/final-assembly.md`
Derived: 2026-08-25 · Narration master total: 469.056 s (18 blocks × audio + 0.6 s trailing pause)

This is the production timeline derived from narration timing + approved sourcing
slots + actual ffprobe durations (Playbook §7). It supersedes the placeholder
visual-plan shot count for rendering. The placeholder `visual-plan.json` is kept
unmodified as historical/audit information.

## 1. Decision Log (editorial, 2026-08-25)

| ID | Decision | Effect |
| --- | --- | --- |
| D1 (=A1) | APPROVED — N003 uses S1 → S2 → S3 | N003 becomes a 3-slot block (~6.11 s each); the earlier 2-shot prototype does not constrain production |
| D2 (=A2) | REUSE NOT APPROVED — Pexels 9818697 may not appear in both N006-S3 and N008-S2 | N006-S3 keeps 9818697; N008-S2 must be replaced from the already-searched candidate pool only. Replacement pending editorial approval (§4); no re-search performed |
| D3 (=A3) | ACCEPTED — no manufactured shots to force 7–10 s guideline | N009 (5×~5.78 s), N015 (4×~5.87 s), N018 (two ~19.94 s shots) evaluated by viewing the full render |
| D4 (=A4) | ACCEPTED — at-cap sources valid for this timeline | Any future extension beyond actual ffprobe duration must raise INSUFFICIENT_SOURCE |
| D5 (2026-08-26) | APPROVED — N008-S2 replacement = v3 `pexels-video-8871841` (Kampus Production), replacing 9818697 for N008-S2 ONLY | Row 23 finalized; N006-S3 keeps 9818697; asset downloaded via existing deterministic workflow (scoped `pexels-candidates-N008-S2.json`); ⚠ delivered variant measures **1280×720 @25 fps** despite its `hd_1920_1080` URL label (provenance records as-measured) — upscale softness on this one 6.36 s shot to be judged at cut viewing |
| D6 (2026-08-30) | APPROVED — replace N001-S2 → `pexels-video-7252804`, N010-S3 → `pexels-video-8306453`, N013-S3 → `pexels-video-6231392` | Existing approved candidate pools only; all three downloaded with provenance. N001-S2 is 8.120 s, so N001 redistributes to 9.344 / 8.120 / 9.344 s. N010-S3 is a 1366×720 delivered variant and remains a cut-viewing quality warning. |

## 2. Timeline (60 shots = 51 videos + 9 photos)

Asset IDs are Pexels IDs; filenames, hashes, licenses and URLs live in
`sourcing/downloads/provenance.json`. Photos are Ken Burns stills.
| # | start | end | dur | block | slot | media | asset | src ffprobe | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.00 | 9.34 | 9.34 | n001 Adding | N001-S1 | video | 5977058 | 9.360 | OK (D6) |
| 2 | 9.34 | 17.46 | 8.12 | n001 | N001-S2 | video | 7252804 | 8.120 | AT-CAP (D6) |
| 3 | 17.46 | 26.81 | 9.34 | n001 | N001-S3 | video | 4569919 | 18.040 | OK (D6) |
| 4 | 26.81 | 34.56 | 7.75 | n002 Possibilities | N002-S1 | video | 38755800 | 12.112 | OK |
| 5 | 34.56 | 42.31 | 7.75 | n002 | N002-S2 | video | 19959356 | 10.027 | OK |
| 6 | 42.31 | 50.06 | 7.75 | n002 | N002-S3 | video | 8747384 | 7.841 | OK |
| 7 | 50.06 | 56.18 | 6.11 | n003 Something Changes | N003-S1 | video | 38748169 | 19.960 | OK (D1) |
| 8 | 56.18 | 62.29 | 6.11 | n003 | N003-S2 | video | 7593617 | 11.413 | OK (D1) |
| 9 | 62.29 | 68.40 | 6.11 | n003 | N003-S3 | video | 38516685 | 23.390 | OK (D1) |
| 10 | 68.40 | 77.77 | 9.37 | n004 Everything Has a Cost | N004-S1 | photo | 25651557 | n/a | OK |
| 11 | 77.77 | 87.14 | 9.37 | n004 | N004-S2 | video | 8297994 | 20.600 | OK |
| 12 | 87.14 | 96.50 | 9.37 | n004 | N004-S3 | photo | 13600865 | n/a | OK |
| 13 | 96.50 | 105.46 | 8.96 | n005 The Question Changes | N005-S1 | video | 35559503 | 13.213 | OK |
| 14 | 105.46 | 114.42 | 8.96 | n005 | N005-S2 | video | 34333581 | 11.011 | OK |
| 15 | 114.42 | 123.38 | 8.96 | n005 | N005-S3 | video | 6654095 | 15.920 | OK |
| 16 | 123.38 | 131.10 | 7.72 | n006 Things Accumulate | N006-S1 | video | 8580887 | 15.600 | OK |
| 17 | 131.10 | 138.82 | 7.72 | n006 | N006-S2 | video | 5224014 | 18.752 | OK |
| 18 | 138.82 | 146.54 | 7.72 | n006 | N006-S3 | photo | 9818697 | n/a | OK (kept per D2) |
| 19 | 146.54 | 154.65 | 8.10 | n007 Identities Accumulate Too | N007-S1 | video | 9057574 | 12.885 | OK |
| 20 | 154.65 | 162.75 | 8.10 | n007 | N007-S2 | video | 7792232 | 17.480 | OK |
| 21 | 162.75 | 170.86 | 8.10 | n007 | N007-S3 | video | 7546434 | 9.760 | OK |
| 22 | 170.86 | 177.22 | 6.36 | n008 Letting Go | N008-S1 | video | 4520154 | 13.313 | OK |
| 23 | 177.22 | 183.58 | 6.36 | n008 | N008-S2 | video | 8871841 | 10.325 | OK (D5; delivered 720p variant — see D5 note) |
| 24 | 183.58 | 189.94 | 6.36 | n008 | N008-S3 | video | 8581134 | 14.567 | OK |
| 25 | 189.94 | 195.72 | 5.78 | n009 The Self-Improvement Trap | N009-S1 | photo | 5831267 | n/a | OK (D3) |
| 26 | 195.72 | 201.49 | 5.78 | n009 | N009-S2 | video | 7691561 | 20.280 | OK (D3) |
| 27 | 201.49 | 207.27 | 5.78 | n009 | N009-S3 | video | 853794 | 13.760 | OK (D3) |
| 28 | 207.27 | 213.05 | 5.78 | n009 | N009-S4 | video | 5717486 | 17.960 | OK (D3) |
| 29 | 213.05 | 218.83 | 5.78 | n009 | N009-S5 | video | 32090009 | 11.000 | OK (D3) |
| 30 | 218.83 | 226.43 | 7.60 | n010 Maybe Less | N010-S1 | video | 8631882 | 7.600 | AT-CAP (D4) |
| 31 | 226.43 | 234.40 | 7.97 | n010 | N010-S2 | video | 9583986 | 15.600 | OK |
| 32 | 234.40 | 242.38 | 7.97 | n010 | N010-S3 | video | 8306453 | 17.120 | OK (D6; delivered 720p variant) |
| 33 | 242.38 | 249.33 | 6.95 | n011 Time Becomes Finite | N011-S1 | video | 34580818 | 11.678 | OK |
| 34 | 249.33 | 256.28 | 6.95 | n011 | N011-S2 | photo | 38112113 | n/a | OK |
| 35 | 256.28 | 263.23 | 6.95 | n011 | N011-S3 | video | 6289666 | 17.880 | OK |
| 36 | 263.23 | 269.57 | 6.33 | n012 The Calculation Changes | N012-S1 | video | 4440956 | 6.335 | AT-CAP (D4) |
| 37 | 269.57 | 276.83 | 7.26 | n012 | N012-S2 | video | 10567295 | 29.840 | OK |
| 38 | 276.83 | 284.10 | 7.26 | n012 | N012-S3 | video | 7643454 | 17.680 | OK |
| 39 | 284.10 | 291.36 | 7.26 | n012 | N012-S4 | video | 5483091 | 17.560 | OK |
| 40 | 291.36 | 298.40 | 7.04 | n013 What Is Worth Wanting | N013-S1 | video | 37036976 | 18.880 | OK |
| 41 | 298.40 | 305.44 | 7.04 | n013 | N013-S2 | video | 15067909 | 25.173 | OK |
| 42 | 305.44 | 312.48 | 7.04 | n013 | N013-S3 | video | 6231392 | 15.530 | OK (D6) |
| 43 | 312.48 | 319.37 | 6.89 | n014 Does Your Life Reflect It? | N014-S1 | video | 7981333 | 7.160 | OK |
| 44 | 319.37 | 326.27 | 6.89 | n014 | N014-S2 | photo | 7869666 | n/a | OK |
| 45 | 326.27 | 333.16 | 6.89 | n014 | N014-S3 | video | 6136998 | 8.542 | OK |
| 46 | 333.16 | 340.06 | 6.89 | n014 | N014-S4 | video | 8198666 | 20.200 | OK |
| 47 | 340.06 | 345.93 | 5.87 | n015 Remove | N015-S1 | video | 7845435 | 7.000 | OK (D3) |
| 48 | 345.93 | 351.80 | 5.87 | n015 | N015-S2 | video | 5699534 | 7.758 | OK (D3) |
| 49 | 351.80 | 357.68 | 5.87 | n015 | N015-S3 | video | 7223709 | 34.320 | OK (D3) |
| 50 | 357.68 | 363.55 | 5.87 | n015 | N015-S4 | video | 16747044 | 8.148 | OK (D3) |
| 51 | 363.55 | 371.04 | 7.49 | n016 Hear Yourself Again | N016-S1 | video | 36370002 | 9.360 | OK |
| 52 | 371.04 | 378.53 | 7.49 | n016 | N016-S2 | video | 8279396 | 13.250 | OK |
| 53 | 378.53 | 386.02 | 7.49 | n016 | N016-S3 | video | 6023125 | 8.960 | OK |
| 54 | 386.02 | 393.56 | 7.54 | n017 Enough | N017-S1 | video | 5252440 | 9.643 | OK |
| 55 | 393.56 | 401.10 | 7.54 | n017 | N017-S2 | photo | 5240019 | n/a | OK |
| 56 | 401.10 | 408.65 | 7.54 | n017 | N017-S3 | video | 6657873 | 8.810 | OK |
| 57 | 408.65 | 428.59 | 19.94 | n018 Editing a Life | N018-S1 | video | 27327969 | 20.960 | OK (D3) |
| 58 | 428.59 | 438.39 | 9.80 | n018 | N018-S2 | video | 4872871 | 9.800 | AT-CAP (D4) |
| 59 | 438.39 | 449.11 | 10.72 | n018 | N018-S3 | video | 34411926 | 10.719 | AT-CAP (D4) |
| 60 | 449.11 | 469.06 | 19.94 | n018 | N018-S4 | photo | 9973278 | n/a | OK (D3) |

## 3. Validation snapshot (2026-08-25)

- 60/60 approved slots accounted for; selected ↔ downloaded bijective; no extras. Re-validated 2026-08-30 after D6: **60 distinct asset assignments** (52 videos + 8 photos).
- No loops, no overlapping ranges, no INSUFFICIENT_SOURCE; blocks tile 0→469.056 s exactly.
- At-cap slots (zero headroom): rows 2 (D6), 30, 36, 58, 59.
- Known quality warnings: N008-S2 (D5) and N010-S3 (D6) are 720p variants upscaled to 1080p by the renderer; both are judged at cut viewing.

## 4. Resolved decision — N008-S2 replacement (D5, 2026-08-26)

Editorial approval received for **v3 `pexels-video-8871841`** (Kampus Production),
replacing `pexels-photo-9818697` for N008-S2 ONLY; N006-S3 unchanged.

Executed mechanical steps:

1. Selection metadata flipped in `pexels-candidates-N007-N018.json`
   (8871841 → selected; 9818697 → candidate, stale N008-S2 download fields cleared).
2. Downloaded via existing deterministic workflow against scoped
   `pexels-candidates-N008-S2.json` (no Pexels search; provenance merge replaced
   only the N008-S2 entry — all other records untouched).

Verified facts:

- HTTP 200, Content-Type `video/mp4`, Content-Length 1,254,968 (= bytes on disk)
- ffprobe: h264 + AAC, 1280×720 @25 fps, duration **10.325 s** (≥ 6.36 s need)
- SHA-256: `d8cbdccab2baaf68a840d4d741f9c239666ab20673226095cb404ec5cd0e06cb`
- ⚠ Delivered variant is **720p**, not the 1080p its URL label implied
  (`hd_1920_1080_25fps.mp4`). Provenance records as-measured values; renderer
  will upscale this one shot to 1080p. Quality to be judged at cut viewing;
  swapping later would require a new editorial decision + download.

Original candidate pool retained below for audit.

| pool rank | asset ID | media | content | creator | resolution | duration | downloaded |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1 | pexels-video-8057700 | video | elderly man grieving while looking at the photo | Pavel Danilyuk | 3840×2160 (1080p file) | 17 s | no |
| v2 | pexels-video-6565270 | video | a man looking around the house | cottonbro studio | 4096×2160 (**720p file**) | 164 s | no |
| **v3 ✅** | **pexels-video-8871841** | video | elderly woman holding a picture frame while sitting on sofa | Kampus Production | listed 3840×2160 / **delivered 1280×720** | **10.325 s** | **yes** |
| p2 | pexels-photo-6633426 | photo | person in pink sweater holding a picture frame indoors, near a candle | Kaboompics | 6720×4480 | n/a | no |

(Former p1 = 9818697 — excluded by D2.)

## 5. Next steps after approval

1. Record the approved N008-S2 asset here; finalize row 23.
2. Download ONLY that selected candidate via the existing deterministic download
   script (updates provenance; no re-search).
3. Implement renderer changes (Playbook-conformant real-asset mode) — separately approved.
4. First full real-asset render, then final-assembly QA checklist review.
