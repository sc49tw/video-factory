// ---------------------------------------------------------------------------
// Shared ESSY still-image policy — NO_MOTION_STILLS (canonical, project-wide).
//
// Rule: still images MUST be frame-identical from first to last frame.
// Only fixed-ratio scale + center crop. No Ken Burns, no push-in,
// no pan, no scale animation, no random drift, no simulated handheld shake.
// Composition (scale + crop center) is constant for the whole shot.
//
// - resolveStillMotion() ALWAYS returns "static". The legacy "slow-push"
//   value is accepted on input but resolves to STATIC (no motion) so old
//   metadata can never re-enable motion. Per-slot motion exceptions require
//   explicit human approval and a code-level opt-in (not metadata alone).
// - stillImageFilter() NEVER emits time-varying x/y / zoom.
//   Static path only: scale=increase + center crop + fps + lanczos downscale.
// ---------------------------------------------------------------------------

export const STILL_MOTION_VALUES = ["static"];

// Kept for backward-compatible import only. No longer used to produce motion.
export const SLOW_PUSH_ZOOM_MAX = 1.0;

/**
 * Resolve the still-image motion treatment for a shot.
 * NO_MOTION_STILLS: always STATIC. Video shots never reach this policy.
 */
export function resolveStillMotion(shot) {
  const value = shot?.stillMotion;
  if (value != null && value !== "" && value !== "static") {
    console.warn(
      `[NO_MOTION_STILLS] stillMotion "${value}" on shot ` +
        `${shot.slotId ?? shot.id ?? "?"} ignored; STATIC enforced. ` +
        `Per-slot motion needs explicit human approval + code opt-in.`,
    );
  }
  return "static";
}

/**
 * ffmpeg video filter chain for a still image.
 * STATIC ONLY: fixed scale + center crop. No time-varying expr.
 */
export function stillImageFilter({width, height, fps}) {
  // NOTE: no frameCount / stillMotion inputs by design — motion cannot be
  // re-enabled via parameters. Fixed-ratio scale + center crop, identical
  // every frame.
  return (
    `scale=${width}:` +
    `${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height}:x=(in_w-out_w)/2:y=(in_h-out_h)/2,` +
    `fps=${fps}`
  );
}

