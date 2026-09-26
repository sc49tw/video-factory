// Shared ESSY opening-identity delivery semantics — single source of truth
// for review and final parity (planOpeningInsertion is the only opening
// algorithm; no renderer re-derives it).
//
// The approved v13 review opening is an INSERTION (not a pre-roll):
//   - main content starts at t=0
//   - N001 three-question hook plays normally
//   - identity insertion extends the hook's final approved shot with its own
//     unused source tail (continuing motion, no freeze, no extra sourcing)
//   - body narration/subtitles shift by exactly insertion.durationSec
//   - insertion window itself is silent and subtitle-free
//
// Assembly-timeline fields refresher (per shot):
//   renderDurationSec = source playback duration in the clip
//   trailingHoldSec   = frozen-last-frame hold appended after playback
// The delivery clip for the hook shot is therefore:
//   playback = renderDurationSec + insertion.durationSec, hold unchanged.
import {planOpeningInsertion} from './essay-opening-plan.mjs';

// Boundary tolerance: times at or after the insertion start shift; times
// below it do not (never a loose millisecond window).
const BOUNDARY_EPSILON = 1e-9;

/** Delivery offset: body content after the insertion starts this much later. */
export function openingBodyOffsetSec(opening) {
  return opening ? Number(opening.durationSec ?? 0) : 0;
}

/** Delivery time for an assembly-timeline absolute time. */
export function toDeliveryTime(assemblySec, opening) {
  const offset = openingBodyOffsetSec(opening);
  if (!opening || !(offset > 0)) return Number(assemblySec);
  return Number(assemblySec) + (Number(assemblySec) >= opening.startSec - BOUNDARY_EPSILON ? offset : 0);
}

/** Delivery start/end window for a shot's absolute window. */
export function deliveryShotWindow(shot, opening) {
  const start = Number(shot.absoluteStartSec ?? shot.startSec ?? 0);
  const end = Number(shot.absoluteEndSec ?? shot.endSec ?? start);
  if (!opening || !(openingBodyOffsetSec(opening) > 0)) return {startSec: start, endSec: end};
  return {startSec: toDeliveryTime(start, opening), endSec: toDeliveryTime(end, opening)};
}

/** Delivery start/end for a title card or subtitle cue. */
export function deliveryEventWindow({startSec, endSec}, opening) {
  return {startSec: toDeliveryTime(startSec, opening), endSec: toDeliveryTime(endSec, opening)};
}

/**
 * Render-plan for an openingIdentity delivery that both renderers consume.
 * `plan` is the exact shared planOpeningInsertion result; this only derives
 * the per-shot render changes + narration silence window + subtitle insertion.
 */
export function buildOpeningDeliveryPlan({identity, timeline}) {
  const plan = planOpeningInsertion(identity, timeline);
  if (!plan) return null;
  const offset = openingBodyOffsetSec(plan);
  const hookShot = plan.shot;
  const playbackSec = Number(hookShot.renderDurationSec) + offset;
  const holdSec = Number(hookShot.trailingHoldSec ?? 0);
  if (!(playbackSec + holdSec <= Number(hookShot.sourceDurationSec) + 0.001)) {
    throw new Error(
      `Opening delivery exceeds approved source tail for ${hookShot.slotId}: ` +
      `need ${(playbackSec + holdSec).toFixed(3)}s, have ${Number(hookShot.sourceDurationSec).toFixed(3)}s.`,
    );
  }
  const deliveryShotOverrides = new Map();
  // The delivery visual timeline extends the hook's final shot by the
  // insertion duration (same approved source tail, continuing motion);
  // every later shot keeps its approved playback+hold and shifts by offset.
  // Review 540p and 1080p final both follow this same composition.
  deliveryShotOverrides.set(hookShot.slotId, {
    mode: 'extend-source-tail',
    playbackDurationSec: playbackSec,
    trailingHoldSec: holdSec,
    sourceOffsetSec: 0,
  });
  for (const shot of timeline.shots ?? []) {
    if (deliveryShotOverrides.has(shot.slotId)) continue;
    deliveryShotOverrides.set(shot.slotId, {
      mode: 'shift-body',
      playbackDurationSec: Number(shot.renderDurationSec),
      trailingHoldSec: Number(shot.trailingHoldSec ?? 0),
      sourceOffsetSec: 0,
    });
  }
  return {
    plan,
    startSec: plan.startSec,
    durationSec: plan.durationSec,
    endSec: plan.startSec + plan.durationSec,
    bodyOffsetSec: offset,
    cards: plan.cards,
    deliveryShotOverrides,
    hookSlotId: hookShot.slotId,
    // Identity window itself carries no spoken narration.
    narrationSilenceWindow: {startSec: plan.startSec, endSec: plan.startSec + plan.durationSec},
    subtitleInsertion: {startSec: plan.startSec, durationSec: plan.durationSec},
  };
}

/**
 * 1080p title typography derived from the approved review identity style:
 * review burns channel/episode cards at 36/24px on 540p; the 1080p final
 * scales both by the resolution ratio (2x). No episode-specific constants.
 */
export function finalTitleFontSize({kind, height = 1080, reviewHeight = 540, reviewFontSize}) {
  const base = Number(reviewFontSize ?? (kind === 'channel' ? 36 : 24));
  return Math.round(base * (Number(height) / Number(reviewHeight)));
}

export {planOpeningInsertion};
