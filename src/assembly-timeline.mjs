// Real-asset assembly timeline helpers (ESSY production renderer path).
//
// Pure, deterministic functions: given the approved narration block windows,
// the approved sourcing slots per block (with ACTUAL ffprobe source durations),
// and the existing narration-tied subtitle cues, they produce and validate the
// machine-readable timeline the production renderer consumes. No editorial
// decisions live here.

const MIN_CUE_SEC = 0.1;

/**
 * Distribute `total` seconds across caps (ffprobe source durations) as evenly
 * as possible, never exceeding a cap. Slots whose cap cannot hold the even
 * share take their full cap; the remainder spreads over the remaining slots.
 * Throws when the caps cannot cover `total`.
 * @param {number} total
 * @param {Array<number|null>} caps null caps (still photos) are unbounded.
 * @returns {number[]}
 */
export function distributeEvenly(total, caps) {
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
  if (
    remaining > 1e-6 ||
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
    const durationSec = block.audioDurationSec + (block.pauseAfterSec ?? 0);
    windows.push({
      sentenceId: block.sentenceId,
      startSec: cursor,
      endSec: cursor + durationSec,
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
      slot.mediaType === "video" ? slot.sourceDurationSec : null,
    );
    const durations = distributeEvenly(window.durationSec, caps);
    const blockShots = [];
    let blockCursor = window.startSec;
    slots.forEach((slot, index) => {
      const renderDurationSec = durations[index];
      if (seenSlots.has(slot.slotId)) {
        throw new Error(`Duplicate slot assignment: ${slot.slotId}.`);
      }
      seenSlots.add(slot.slotId);
      if (seenAssets.has(slot.sourcePath)) {
        throw new Error(`Source asset reused across slots: ${slot.sourcePath}.`);
      }
      seenAssets.add(slot.sourcePath);
      if (slot.mediaType === "video") {
        if (renderDurationSec > slot.sourceDurationSec + 1e-6) {
          throw new Error(
            `INSUFFICIENT_SOURCE ${slot.slotId}: needs ${renderDurationSec.toFixed(3)}s ` +
              `but source is ${slot.sourceDurationSec.toFixed(3)}s.`,
          );
        }
      }
      const shot = {
        index: timelineShots.length,
        blockId: window.sentenceId,
        slotId: slot.slotId,
        mediaType: slot.mediaType,
        sourcePath: slot.sourcePath,
        sourceDurationSec: slot.sourceDurationSec,
        stillMotion: slot.stillMotion ?? null,
        renderDurationSec: round3(renderDurationSec),
        startSec: round3(blockCursor - window.startSec),
        endSec: round3(blockCursor - window.startSec + renderDurationSec),
        absoluteStartSec: round3(blockCursor),
        absoluteEndSec: round3(blockCursor + renderDurationSec),
      };
      blockShots.push(shot);
      timelineShots.push(shot);
      blockCursor += renderDurationSec;
    });
    const coverage = durations.reduce((sum, d) => sum + d, 0);
    if (Math.abs(coverage - window.durationSec) > 0.02) {
      throw new Error(
        `INSUFFICIENT_SOURCE block ${window.sentenceId}: ` +
          `slots cover ${coverage.toFixed(3)}s of ${window.durationSec.toFixed(3)}s window.`,
      );
    }
    timelineBlocks.push({
      sentenceId: window.sentenceId,
      startSec: round3(window.startSec),
      endSec: round3(window.endSec),
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
    const blockCovered = (block.shots ?? []).reduce(
      (sum, shot) => sum + shot.renderDurationSec,
      0,
    );
    if (Math.abs(blockCovered - block.durationSec) > 0.02) {
      throw new Error(
        `Block ${block.sentenceId} shots cover ${blockCovered.toFixed(3)}s, ` +
          `expected ${block.durationSec.toFixed(3)}s.`,
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
          (shot.sourceDurationSec ?? 0) + 0.001
        ) {
          throw new Error(
            `INSUFFICIENT_SOURCE ${shot.slotId}: shot ${shot.renderDurationSec.toFixed(3)}s ` +
              `exceeds source ${shot.sourceDurationSec?.toFixed(3) ?? "?"}s.`,
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
