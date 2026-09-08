// ---------------------------------------------------------------------------
// Shared ESSY still-image motion policy (canonical, P1).
//
// Editorial decision (validated via the P1 motion-comfort + geometry
// experiments and human review):
//   "Calm frame, meaningful motion."
//   - STATIC is the default treatment for still images.
//   - Motion must be explicitly declared per shot via `stillMotion` metadata.
//   - Shot index parity must NEVER select motion (old odd/even Ken Burns
//     alternation was rejected by human review).
//   - Canonical production values: "static" | "slow-push".
//     ("slow-pull" and "pan" are NOT approved production treatments yet.)
//   - Unknown/unsupported values resolve to STATIC (never guess motion).
//
// slow-push geometry (from the P1 geometry experiment):
//   - fixed center anchor (crop center = exact image center every frame)
//   - scale only, no translation, spans the FULL shot (no early freeze)
//   - zoom crop is quantized at 4x supersample then lanczos-downscaled, so
//     quantization error is <= 0.25 output px (prevents perceptual wobble)
//
// SLOW_PUSH_ZOOM_MAX is an IMPLEMENTATION DEFAULT, not an editorial
// requirement. Do not treat 1.035 as a validated perceptual amplitude.
// ---------------------------------------------------------------------------

export const STILL_MOTION_VALUES = ["static", "slow-push"];

// Restrained implementation default for slow-push end zoom.
export const SLOW_PUSH_ZOOM_MAX = 1.035;

const ZOOMPAN_SUPERSAMPLE = 4;

/**
 * Resolve the still-image motion treatment for a shot.
 * Absent metadata -> STATIC. Only photo/still shots are passed here by the
 * renderers; video shots never reach this policy.
 */
export function resolveStillMotion(shot) {
  const value = shot?.stillMotion;
  if (value === "slow-push") return "slow-push";
  if (value === "static" || value == null || value === "") return "static";
  console.warn(
    `[still-motion] unsupported stillMotion "${value}" on shot ` +
      `${shot.slotId ?? shot.id ?? "?"}; falling back to STATIC.`,
  );
  return "static";
}

/**
 * ffmpeg video filter chain for a still image.
 * static    -> scale/crop only (no motion).
 * slow-push -> stable center zoom 1.0 -> SLOW_PUSH_ZOOM_MAX across the
 *              complete shot duration.
 */
export function stillImageFilter({width, height, fps, frameCount, stillMotion}) {
  const motion = stillMotion ?? "static";
  if (motion !== "slow-push") {
    return (
      `scale=${width * ZOOMPAN_SUPERSAMPLE}:${height * ZOOMPAN_SUPERSAMPLE}:` +
      `force_original_aspect_ratio=increase:flags=lanczos,` +
      `crop=${width * ZOOMPAN_SUPERSAMPLE}:${height * ZOOMPAN_SUPERSAMPLE},` +
      `fps=${fps},` +
      `scale=${width}:${height}:flags=lanczos`
    );
  }
  const ss = ZOOMPAN_SUPERSAMPLE;
  const frames = Math.max(2, frameCount);
  return (
    `scale=${width * ss}:${height * ss}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width * ss}:${height * ss},` +
    `zoompan=z='1+(${SLOW_PUSH_ZOOM_MAX}-1)*on/${frames - 1}':` +
    `x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':` +
    `d=${frames}:s=${width * ss}x${height * ss}:fps=${fps},` +
    `scale=${width}:${height}:flags=lanczos`
  );
}
