// Real-asset assembly timeline helpers (ESSY production renderer path).
//
// Pure, deterministic functions: given the approved narration block windows,
// the approved sourcing slots per block (with ACTUAL ffprobe source durations),
// and the existing narration-tied subtitle cues, they produce and validate the
// machine-readable timeline the production renderer consumes. No editorial
// decisions live here.

const MIN_CUE_SEC = 0.1;

// Canonical narration-fit trim tolerance (Gate 2 contract, max accepted 0.11s).
// Sources falling short of the NARRATION playback window by at most this amount
// are accepted; the deficit becomes extra deterministic last-frame hold. It is
// NEVER covered by looping or by charging the inter-block pause to sources.
export const MAX_NARRATION_TRIM_SEC = 0.11;

/**
 * Distribute `total` seconds across caps (ffprobe source durations) as evenly
 * as possible, never exceeding a cap. Slots whose cap cannot hold the even
 * share take their full cap; the remainder spreads over the remaining slots.
 * Throws when the caps cannot cover `total`.
 * @param {number} total
 * @param {Array<number|null>} caps null caps (still photos) are unbounded.
 * @returns {number[]}
 */
export function distributeEvenly(total, caps, maxDeficitSec = 0) {
  const result = new Array(caps.length).fill(0);
  let remaining = total;
  const pending = new Set(caps.keys());
  while (pending.size > 0) {
    const share = remaining / pending.size;
    const constrained = [...pending].filter(
      (index) => caps[index] !== null && caps[index] < share - 1e-6,
    );
    if (constrained.length === 0) {
      for (const index of pending) result[index] = share;
      remaining = 0;
      break;
    }
    for (const index of constrained) {
      result[index] = caps[index];
      remaining -= caps[index];
      pending.delete(index);
    }
    if (remaining <= 1e-6 && pending.size > 0) break;
  }
  if (remaining > 1e-6) {
    // Approved narration-fit trim tolerance (e.g. Gate 2 <= 0.11s): when the
    // sources fall deterministically short of the NARRATION playback window by
    // at most maxDeficitSec, the deficit is NOT charged to any shot; it is
    // clamped out of the visual coverage and re-emerges as extra trailing
    // hold after the last shot (the renderer freezes the last frame there).
    if (remaining > maxDeficitSec + 1e-6) {
      throw new Error(
        `INSUFFICIENT_SOURCE: durations ${JSON.stringify(caps)} ` +
          `cannot cover ${total.toFixed(3)}s (uncovered ${remaining.toFixed(3)}s).`,
      );
    }
    const covered = total - remaining;
    return distributeEvenly(covered, caps, 0);
  }
  if (
    remaining < -1e-6 ||
    result.some((duration) => !(Number.isFinite(duration) && duration > 0))
  ) {
    throw new Error(
      `INSUFFICIENT_SOURCE: durations ${JSON.stringify(caps)} ` +
        `cannot cover ${total.toFixed(3)}s (uncovered ${remaining.toFixed(3)}s).`,
    );
  }
  return result;
}

/**
 * Clip absolute (block-relative) subtitle cues into a shot window and re-base
 * them to that window. Cues shorter than MIN_CUE_SEC are dropped so no flash
 * appears. Text is preserved verbatim; only timing windows move.
 * @param {Array<{startSec:number,endSec:number,text:string}>} absCues
 * @param {number} winStart
 * @param {number} winEnd
 * @returns {Array<{startSec:number,endSec:number,text:string}>}
 */
export function sliceCues(absCues, winStart, winEnd) {
  const clipped = [];
  for (const cue of absCues) {
    const startSec = Math.max(cue.startSec, winStart);
    const endSec = Math.min(cue.endSec, winEnd);
    if (endSec - startSec < MIN_CUE_SEC) continue;
    clipped.push({
      startSec: startSec - winStart,
      endSec: endSec - winStart,
      text: cue.text,
    });
  }
  return clipped;
}

/**
 * Compute cumulative narration-master block windows.
 * @param {Array<{sentenceId:string, audioDurationSec:number, pauseAfterSec:number}>} blocks
 * @returns {Array<{sentenceId:string, startSec:number, endSec:number, durationSec:number}>}
 */
export function buildBlockWindows(blocks) {
  const windows = [];
  let cursor = 0;
  for (const block of blocks) {
    const narrationDurationSec = block.audioDurationSec;
    const durationSec = narrationDurationSec + (block.pauseAfterSec ?? 0);
    windows.push({
      sentenceId: block.sentenceId,
      startSec: cursor,
      endSec: cursor + durationSec,
      // Visual fit is against narration playback ONLY; the trailing pause is
      // rendered as a deterministic last-frame hold after the block's final
      // shot (never charged to source duration, never looped).
      narrationDurationSec,
      durationSec,
    });
    cursor += durationSec;
  }
  return windows;
}
/**
 * Build a validated real-asset assembly timeline.
 *
 * @param {object} input
 * @param {Array<{sentenceId:string, audioDurationSec:number, pauseAfterSec:number}>} input.blocks
 *   Narration master (one per narration block).
 * @param {Map<string, Array<{slotId:string, mediaType:string, sourcePath:string, sourceDurationSec:number|null}>>} input.slotsByBlock
 *   Approved sourcing slots per block, in shot order (order defines shot order).
 * @param {Map<string, Array<{startSec:number,endSec:number,text:string}>>} input.cuesByBlock
 *   Existing narration-tied subtitle cues per block in absolute block time.
 * @returns {object} validated timeline artifact
 */
export function buildAssemblyTimeline({blocks, slotsByBlock, cuesByBlock}) {
  const windows = buildBlockWindows(blocks);
  const timelineBlocks = [];
  const timelineShots = [];
  const seenSlots = new Set();
  const seenAssets = new Set();

  for (const window of windows) {
    const slots = slotsByBlock.get(window.sentenceId) ?? [];
    if (slots.length === 0) {
      throw new Error(`No approved sourcing slots for ${window.sentenceId}.`);
    }
    const caps = slots.map((slot) =>
      slot.mediaType === "video"
        ? slot.sourceDurationSec - (slot.inPointSec ?? 0)
        : null,
    );
    // Source fit is against NARRATION playback only; the inter-block pause is
    // a deterministic last-frame hold on the block's final shot.
    const durations = distributeEvenly(
      window.narrationDurationSec,
      caps,
      MAX_NARRATION_TRIM_SEC,
    );
    const narrationCoverage = durations.reduce((sum, d) => sum + d, 0);
    const trimmedSec = round3(window.narrationDurationSec - narrationCoverage);
    const trailingHoldSec = round3(
      (window.durationSec - window.narrationDurationSec) + trimmedSec,
    );
    const blockShots = [];
    let blockCursor = window.startSec;
    slots.forEach((slot, index) => {
      const renderDurationSec = durations[index];
      const isFinalShot = index === slots.length - 1;
      const holdSec = isFinalShot ? trailingHoldSec : 0;
      if (seenSlots.has(slot.slotId)) {
        throw new Error(`Duplicate slot assignment: ${slot.slotId}.`);
      }
      seenSlots.add(slot.slotId);
      if (seenAssets.has(slot.sourcePath)) {
        throw new Error(`Source asset reused across slots: ${slot.sourcePath}.`);
      }
      seenAssets.add(slot.sourcePath);
      if (slot.mediaType === "video") {
        // Fit is measured from the APPROVED in-point, not from t=0: a slot may
        // deliberately take a later cut of a longer licensed take.
        const availableSec = slot.sourceDurationSec - (slot.inPointSec ?? 0);
        if (renderDurationSec > availableSec + 1e-6) {
          throw new Error(
            `INSUFFICIENT_SOURCE ${slot.slotId}: needs ${renderDurationSec.toFixed(3)}s ` +
              `from in-point ${(slot.inPointSec ?? 0).toFixed(3)}s but only ` +
              `${availableSec.toFixed(3)}s of the source remain.`,
          );
        }
      }
      const inPointSec = slot.mediaType === "video" ? Number(slot.inPointSec ?? 0) : 0;
      const shot = {
        index: timelineShots.length,
        blockId: window.sentenceId,
        slotId: slot.slotId,
        mediaType: slot.mediaType,
        sourcePath: slot.sourcePath,
        sourceDurationSec: slot.sourceDurationSec,
        // Approved in-point inside the licensed take. The renderer seeks here, so
        // two slots that share one take show different pictures.
        inPointSec: round3(inPointSec),
        stillMotion: slot.stillMotion ?? null,
        renderDurationSec: round3(renderDurationSec),
        // Narration playback end (hold never carries subtitles or narration).
        speechEndSec: round3(blockCursor - window.startSec + renderDurationSec),
        // endSec spans narration playback + this shot's trailing hold share.
        startSec: round3(blockCursor - window.startSec),
        endSec: round3(blockCursor - window.startSec + renderDurationSec + holdSec),
        trailingHoldSec: round3(holdSec),
        absoluteStartSec: round3(blockCursor),
        absoluteEndSec: round3(blockCursor + renderDurationSec + holdSec),
      };
      blockShots.push(shot);
      timelineShots.push(shot);
      blockCursor += renderDurationSec + holdSec;
    });
    const coverage = narrationCoverage;
    if (
      Math.abs(coverage - window.narrationDurationSec) > 0.02 &&
      window.narrationDurationSec - coverage > MAX_NARRATION_TRIM_SEC + 0.02
    ) {
      throw new Error(
        `INSUFFICIENT_SOURCE block ${window.sentenceId}: ` +
          `slots cover ${coverage.toFixed(3)}s of ${window.narrationDurationSec.toFixed(3)}s narration window.`,
      );
    }
    timelineBlocks.push({
      sentenceId: window.sentenceId,
      startSec: round3(window.startSec),
      endSec: round3(window.endSec),
      audioDurationSec: round3(window.narrationDurationSec),
      pauseAfterSec: round3(window.durationSec - window.narrationDurationSec),
      trailingHoldSec,
      trimmedSec,
      durationSec: round3(window.durationSec),
      cues: (cuesByBlock.get(window.sentenceId) ?? []).map((cue) => ({
        ...cue,
        startSec: round3(cue.startSec),
        endSec: round3(cue.endSec),
      })),
      shots: blockShots,
    });
  }

  const timeline = {
    schemaVersion: "1.0",
    episode: null,
    strategy: "real-asset-sourced",
    plannedDurationSec: round3(
      timelineBlocks.length ? timelineBlocks.at(-1).endSec : 0,
    ),
    blocks: timelineBlocks,
    shots: timelineShots,
  };
  validateAssemblyTimeline(timeline);
  return timeline;
}
/**
 * Validate a timeline artifact: unique slots, unique video assets, no shot
 * exceeding its video source, blocks fully tiled, contiguous timeline.
 * Throws on any violation.
 */
export function validateAssemblyTimeline(timeline) {
  const seenSlots = new Set();
  const seenAssets = new Set();
  let expectedCursor = 0;
  for (const block of timeline.blocks ?? []) {
    if (Math.abs(block.startSec - expectedCursor) > 0.02) {
      throw new Error(
        `Block ${block.sentenceId} starts at ${block.startSec}s, expected ${expectedCursor}s.`,
      );
    }
    expectedCursor = block.endSec;
    // Shots must cover the block's NARRATION playback window exactly; the
    // inter-block pause is a deterministic last-frame hold after the final
    // shot, never charged to source duration.
    const blockCovered = (block.shots ?? []).reduce(
      (sum, shot) => sum + shot.renderDurationSec,
      0,
    );
    // Shots tile narration playback within the approved trim tolerance; the
    // deficit becomes extra deterministic last-frame hold, never looped.
    const narrationCoverage =
      block.audioDurationSec - (block.trimmedSec ?? 0);
    if (Math.abs(blockCovered - narrationCoverage) > 0.02) {
      throw new Error(
        `Block ${block.sentenceId} shots cover ${blockCovered.toFixed(3)}s, ` +
          `expected narration duration ${block.audioDurationSec.toFixed(3)}s.`,
      );
    }
    if ((block.trimmedSec ?? 0) > MAX_NARRATION_TRIM_SEC + 0.02) {
      throw new Error(
        `Block ${block.sentenceId} narration trim ${block.trimmedSec ?? 0}s ` +
          `exceeds allowed tolerance ${MAX_NARRATION_TRIM_SEC}s.`,
      );
    }
    if (
      Math.abs(
        block.audioDurationSec -
          (block.trimmedSec ?? 0) +
          (block.trailingHoldSec ?? 0) -
          block.durationSec,
      ) > 0.02
    ) {
      throw new Error(
        `Block ${block.sentenceId}: narration ${block.audioDurationSec.toFixed(3)}s ` +
          `- trim ${block.trimmedSec ?? 0}s + hold ${block.trailingHoldSec ?? 0}s ` +
          `!= block window ${block.durationSec.toFixed(3)}s.`,
      );
    }
    const lastShot = (block.shots ?? []).at(-1);
    const shotHoldTotal = (block.shots ?? [])
      .slice(0, -1)
      .reduce((sum, shot) => sum + (shot.trailingHoldSec ?? 0), 0);
    if (shotHoldTotal > 1e-6) {
      throw new Error(
        `Block ${block.sentenceId}: trailing hold found on non-final shots.`,
      );
    }
    if (Math.abs((lastShot?.trailingHoldSec ?? 0) - (block.trailingHoldSec ?? 0)) > 0.02) {
      throw new Error(
        `Block ${block.sentenceId}: final shot hold ${lastShot?.trailingHoldSec ?? 0}s ` +
          `!= block hold ${block.trailingHoldSec ?? 0}s.`,
      );
    }
    let blockCursor = block.startSec;
    for (const shot of block.shots ?? []) {
      if (seenSlots.has(shot.slotId)) {
        throw new Error(`Duplicate slot in timeline: ${shot.slotId}.`);
      }
      seenSlots.add(shot.slotId);
      if (seenAssets.has(shot.sourcePath)) {
        throw new Error(`Source asset reused across slots: ${shot.sourcePath}.`);
      }
      seenAssets.add(shot.sourcePath);
      if (shot.mediaType === "video") {
        if (
          shot.renderDurationSec >
          (shot.sourceDurationSec ?? 0) - (shot.inPointSec ?? 0) + 0.001
        ) {
          throw new Error(
            `INSUFFICIENT_SOURCE ${shot.slotId}: shot ${shot.renderDurationSec.toFixed(3)}s ` +
              `from in-point ${(shot.inPointSec ?? 0).toFixed(3)}s exceeds the remaining ` +
              `${((shot.sourceDurationSec ?? 0) - (shot.inPointSec ?? 0)).toFixed(3)}s.`,
          );
        }
      }
      if (Math.abs(shot.absoluteStartSec - blockCursor) > 0.02) {
        throw new Error(
          `Shot ${shot.slotId} absoluteStart ${shot.absoluteStartSec}s ` +
            `does not match tiled cursor ${blockCursor.toFixed(3)}s.`,
        );
      }
      blockCursor += shot.renderDurationSec;
    }
  }
  if (Math.abs(timeline.plannedDurationSec - expectedCursor) > 0.02) {
    throw new Error(
      `Timeline plannedDuration ${timeline.plannedDurationSec}s ` +
        `does not match tiled total ${expectedCursor.toFixed(3)}s.`,
    );
  }
  return timeline;
}

/**
 * Filter a validated timeline down to a subset of blocks (focused
 * production-renderer smoke tests). Narration-block-relative timing is
 * preserved so audio slices and subtitle windows stay valid.
 */
export function filterTimeline(timeline, keepBlockIds) {
  const keep = new Set(keepBlockIds);
  const blocks = (timeline.blocks ?? []).filter((block) => keep.has(block.sentenceId));
  if (blocks.length === 0) {
    throw new Error(`No blocks matched ${[...keep].join(", ")}.`);
  }
  const shots = blocks.flatMap((block) => block.shots);
  const plannedDurationSec = blocks.reduce(
    (sum, block) => sum + block.durationSec,
    0,
  );
  return {
    schemaVersion: timeline.schemaVersion,
    episode: timeline.episode,
    strategy: timeline.strategy,
    plannedDurationSec: round3(plannedDurationSec),
    blocks,
    shots,
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
