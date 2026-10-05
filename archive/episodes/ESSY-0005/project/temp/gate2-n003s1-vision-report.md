# Gate 2 Vision Capability Check — Pexels 8865291 vs N003-S1

**Status: BLOCKED — the model never received the frames. No visual analysis was executed. No suitability verdict exists.**

- Date: 2026-09-30
- Episode: ESSY-0005 (draft), slot `N003-S1`
- Candidate: Pexels video `8865291`
- Intended model: **MiMo-V2.6-Flash** (Xiaomi, multimodal)
- Gate 2 result: **UNVERIFIED** (blocked on missing API credentials)

---

## 1. Purpose

Verify that MiMo-V2.6-Flash can judge slot fit from the *actual frames* of Pexels
video 8865291 — not from its title, tags, or any metadata. A PASS requires the
model to receive image inputs and return an analysis; anything less is BLOCKED.

## 2. Slot criteria the model was to judge against

Source: `projects/_drafts/ESSY-0005/storyboard.yaml` (N003 block, windowSec 54.648–67.704):

| Field | Value |
|---|---|
| slotId | `N003-S1` |
| editorialFunction | Register the refusal as one person's reaction, not a general truth about aging. |
| visualIntent | A middle-aged adult at home turning away mid-glance from a photograph rack or a screen; the body language of looking aside rather than a posed reaction. The object stays largely out of frame. |
| avoid | gazing at old photographs; hand over mouth in shock; horror at the mirror; dramatic acting or a startle cut |
| query | middle aged person looking away from photos at home candid |

## 3. Intended model input (never delivered)

- Model: `MiMo-V2.6-Flash` via OpenAI-compatible endpoint `https://api.xiaomimimo.com/v1` (`/v1/chat/completions`)
- Input modality: 6 PNG frames as `image_url` content parts (base64), plus the slot criteria above as the prompt
- Output expected: frame-grounded description + fit / not-fit reasoning against `visualIntent` and `avoid`
- **Delivery result: NOT DELIVERED.** See section 6.

## 4. Assets prepared (input side is complete)

Preview file (legal Pexels preview download, temporary):

- `D:\Git\video-factory\temp\gate2-n003s1-vision\preview-8865291.mp4`
- ffprobe: 1280x720, 30000/1001 fps (~29.97), duration **9.5095 s**, size 3,081,105 bytes

Extracted frames (all under `D:\Git\video-factory\temp\gate2-n003s1-vision\`):

| # | Timestamp | File | Bytes |
|---|---|---|---|
| 1 | 0.5 s | `frame-t00.5s.png` | 747,828 |
| 2 | 2.5 s | `frame-t02.5s.png` | 759,703 |
| 3 | 4.5 s | `frame-t04.5s.png` | 755,499 |
| 4 | 6.5 s | `frame-t06.5s.png` | 731,963 |
| 5 | 8.0 s | `frame-t08.0s.png` | 738,818 |
| 6 | 9.2 s | `frame-t09.2s.png` | 686,273 |

## 5. What was NOT done

- The frames were **not** sent to MiMo-V2.6-Flash (no request with image parts was ever accepted by the API).
- No suitability verdict was produced by the model — and **none is fabricated here**.
- The candidate's Pexels title/tags/metadata were **not** used as a substitute for visual analysis.
- No storyboard, narration, `state.yaml`, `narrative-review-data.json`, or any workflow file was modified.

## 6. BLOCKED — evidence

| Check | Result |
|---|---|
| `MIMO_API_KEY` environment variable | **NOT SET** |
| `.env` contains any `MIMO` / `XIAOMI` entry | none (grep returned no matches) |
| `GET https://api.xiaomimimo.com/v1/models` (no key) | **HTTP 401** — `{"error":{"code":"401","type":"invalid_key","message":"Invalid API Key","param":"Please provide valid API Key"}}` |
| Endpoint reachability | reachable (authenticated layer responds; only authorization fails) |
| Local runtime substitute (Ollama) | `qwen3.5:9b-32k`, `qwen3.5:9b-16k`, `qwen3.5:9b`, `qwen3:8b` only — **no MiMo model installed** |

Substituting another model (e.g. qwen3.5) would not satisfy Gate 2: the gate is
explicitly a test of **MiMo-V2.6-Flash**'s video/frames understanding. A PASS
from a different model is not a PASS.


## 7. Unlock condition / retry procedure

1. Obtain a valid `MIMO_API_KEY` (Xiaomi MiMo platform).
2. Set it for the session (`$env:MIMO_API_KEY = "..."`) or add it to `.env`.
3. Re-run the check: POST the 6 frames (section 4) as image content parts to
   `https://api.xiaomimimo.com/v1/chat/completions`, model `MiMo-V2.6-Flash`,
   prompt = slot criteria (section 2) + "judge fit from the images only; if the
   images do not show the required action, say so."
4. Record the model's frame-grounded answer in this report and evaluate it
   against `visualIntent` / `avoid`.
5. Optionally extend the same harness to the other queued candidates:
   `7225752` (previously watched for N002-S4) and `34374462` (N003-S2).

## 8. Risks and recommendations

- **Length mismatch:** preview is 9.51 s but the N003 block window is 13.056 s (54.648–67.704). Even if the model passes the content check, the clip needs a duration plan (loop/extend or alternate shot) before it can fill the slot.
- **Resolution:** preview is 720p; the final master is 1080p. If this candidate is later approved, confirm the download-quality variant is used for render.
- **Single-scene clip:** all 6 frames come from one continuous interior scene, so one pass of 6 frames is representative of the whole clip — but a second sample near scene changes should be added if the clip turns out to be multi-shot.
- **Do not skip the gate:** until a real MiMo response is attached to this report, N003-S1 must remain unfilled by 8865291 and the Gate 2 vision-capability item must remain OPEN.

## 9. Appendix — frame content notes (NOT MiMo output; NOT a verdict)

Recorded by the agent during asset prep for human reference only. This is a
plain description of the pixels, explicitly **not** the model's analysis and
**not** a Gate 2 result; only a captured MiMo-V2.6-Flash response can close the gate.

- All 6 frames: same interior bedroom scene — exposed brick wall, wall-mounted bookshelf full of books above a headboard, lit table lamp with a dotted shade on a wooden nightstand, bed with pillows at frame right, switch panel at frame left. Warm lamp-lit, evening interior, near-static framing.
- 0.5 s: silver-haired woman in a blue-grey blouse seen from behind/side, arm raised reaching toward the shelf books.
- 2.5 s: seated, holding an open book, reading, back to camera.
- 4.5 s: holding an open book with pages fanned, similar framing.
- 6.5 s: standing, holding a book up to the shelf (taking or replacing it).
- 8.0 s: holding a book with both hands near chest height.
- 9.2 s: seated, reading an open book by lamplight.
