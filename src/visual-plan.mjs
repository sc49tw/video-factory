import {readFileSync} from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";

// Essay visual planning. A visual plan splits each narration block into one or
// more visual shots at TTS sentence boundaries and distributes the block's
// ACTUAL ffprobe audio duration across those shots automatically. Manual shot
// durations (durationSec) exist in the contract for future extension only;
// automatic planning never emits them.
//
// Timing rules enforced here:
//   1. Shots of a block tile [0, durationSec] exactly (no gaps, no overlaps).
//   2. Every cut lands on a sentence-cue boundary.
//   3. pauseAfterSec extends ONLY the block's final visual shot.
//   4. Subtitle cues are rebased per shot and clamped to the spoken window;
//      they never remain visible during a trailing pause.

const schema = JSON.parse(
  readFileSync(new URL("../contracts/visual-plan.schema.json", import.meta.url), "utf8"),
);
const validateSchema = new Ajv2020({allErrors: true, strict: false}).compile(schema);

/** Epsilon for floating-point time comparisons (sub-millisecond). */
const EPSILON = 1e-6;

/**
 * Validates a plan against contracts/visual-plan.schema.json and enforces the
 * timing invariants that the renderer relies on.
 */
export function validateVisualPlan(plan) {
  if (!validateSchema(plan)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Visual plan schema validation failed: ${details}`);
  }
  assertPlanInvariants(plan);
  return true;
}

export function assertPlanInvariants(plan) {
  const seenIds = new Set();
  const byBlock = new Map();
  for (const [index, shot] of plan.shots.entries()) {
    if (seenIds.has(shot.id)) {
      throw new Error(`Visual plan has duplicate shot id "${shot.id}".`);
    }
    seenIds.add(shot.id);
    if ((shot.index ?? index) !== index) {
      throw new Error(`Visual plan shot ${shot.id} is out of order.`);
    }
    if (shot.endSec + EPSILON < shot.speechEndSec) {
      throw new Error(
        `Visual plan shot ${shot.id} ends before its spoken narration ends.`,
      );
    }
    for (const cue of shot.cues ?? []) {
      if (cue.endSec > shot.speechEndSec - shot.startSec + EPSILON) {
        throw new Error(
          `Visual plan shot ${shot.id} keeps subtitles visible past the ` +
            `spoken narration (trailing pause must be subtitle-free).`,
        );
      }
    }
    if (!byBlock.has(shot.sentenceId)) byBlock.set(shot.sentenceId, []);
    byBlock.get(shot.sentenceId).push(shot);
  }
  for (const [sentenceId, shots] of byBlock.entries()) {
    shots.forEach((shot, index) => {
      const expectedStart = index === 0 ? 0 : shots[index - 1].endSec;
      if (Math.abs(shot.startSec - expectedStart) > EPSILON) {
        throw new Error(
          `Visual plan shots of block "${sentenceId}" do not tile the block ` +
            `timeline continuously at ${shot.id}.`,
        );
      }
    });
  }
  return true;
}

/**
 * Builds the shot list.
 *
 * @param {object} options
 * @param {Array<{sentenceId:string, sectionId:string, image:string,
 *   durationSec:number, pauseAfterSec:number,
 *   cues:Array<{startSec:number,endSec:number,text:string}>|null}>} options.blocks
 *   One entry per narration block, in timeline order. `durationSec` MUST be
 *   the actual ffprobe duration of the block's TTS audio. `cues` are
 *   sentence-level cues in block-audio time; null falls back to one
 *   whole-block cue.
 * @param {number} options.targetShots Total shot budget for the episode.
 */
export function planVisualShots({blocks, targetShots}) {
  if (!Number.isInteger(targetShots) || targetShots < 1) {
    throw new Error(
      `targetShots must be a positive integer, received ${targetShots}.`,
    );
  }
  const normalized = blocks.map(normalizeBlock);
  const totalDuration = normalized.reduce((sum, b) => sum + b.durationSec, 0);
  if (!(totalDuration > 0)) {
    throw new Error("Visual planning requires at least one block with audio.");
  }

  const counts = allocateShotCounts(normalized, targetShots);

  const shots = [];
  for (const block of normalized) {
    const scaled = scaleCues(block.cues, block.durationSec);
    const count = counts[normalized.indexOf(block)];
    const cutIndices = chooseCutIndices(scaled, count);
    const boundaries = [0, ...cutIndices.map((i) => scaled[i].endSec)];
    if (Math.abs(boundaries[boundaries.length - 1] - block.durationSec) > EPSILON) {
      boundaries.push(block.durationSec);
    }
    for (let k = 0; k < boundaries.length - 1; k += 1) {
      const isFinal = k === count - 1;
      const startSec = boundaries[k];
      const speechEndSec = isFinal ? block.durationSec : boundaries[k + 1];
      const endSec = isFinal
        ? block.durationSec + block.pauseAfterSec
        : speechEndSec;
      const globalIndex = shots.length;
      shots.push({
        id: `shot-${String(globalIndex + 1).padStart(3, "0")}`,
        index: globalIndex,
        sentenceId: block.sentenceId,
        sectionId: block.sectionId,
        image: block.image,
        motionIndex: globalIndex % 2,
        startSec: round6(startSec),
        speechEndSec: round6(speechEndSec),
        endSec: round6(endSec),
        ...(isFinal && block.pauseAfterSec > 0
          ? {pauseAfterSec: round6(block.pauseAfterSec)}
          : {}),
        cues: rebaseCues(scaled, startSec, speechEndSec),
      });
    }
  }

  return {
    schemaVersion: "1.0",
    planning: {
      strategy: "sentence-boundary-proportional",
      durationSource: "ffprobe",
      targetShots,
    },
    shots,
  };
}

function normalizeBlock(block) {
  const durationSec = Number(block.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(
      `Block ${block.sentenceId ?? "?"} has invalid ffprobe duration ${block.durationSec}.`,
    );
  }
  const pauseAfterSec = Number(block.pauseAfterSec ?? 0) || 0;
  if (pauseAfterSec < 0) {
    throw new Error(`Block ${block.sentenceId} has negative pauseAfterSec.`);
  }
  const rawCues =
    Array.isArray(block.cues) && block.cues.length > 0
      ? block.cues
      : [{startSec: 0, endSec: durationSec, text: String(block.text ?? "")}];
  const cues = rawCues
    .map((cue) => ({
      // Clamp both ends into the actual ffprobe window; VTT drift can push
      // trailing cue ends slightly past the probed audio duration.
      startSec: Math.max(0, Math.min(durationSec, Number(cue.startSec) || 0)),
      endSec: Math.min(durationSec, Number(cue.endSec) || 0),
      text: String(cue.text ?? "").trim(),
    }))
    .filter((cue) => cue.endSec > cue.startSec + EPSILON);
  return {
    sentenceId: String(block.sentenceId),
    sectionId: String(block.sectionId ?? ""),
    image: String(block.image),
    durationSec,
    pauseAfterSec,
    cues:
      cues.length > 0 ? cues : [{startSec: 0, endSec: durationSec, text: ""}],
  };
}

/**
 * Linearly rescales cue timings so the last cue ends exactly at the block's
 * actual ffprobe duration. This distributes the real audio duration across
 * shots instead of trusting VTT wall-clock drift.
 */
function scaleCues(cues, durationSec) {
  const lastEnd = cues[cues.length - 1].endSec;
  if (!(lastEnd > 0)) return cues.map((cue) => ({...cue}));
  const scale = durationSec / lastEnd;
  if (Math.abs(scale - 1) < EPSILON) return cues.map((cue) => ({...cue}));
  return cues.map((cue) => ({
    ...cue,
    startSec: round6(Math.min(cue.startSec * scale, durationSec)),
    endSec: round6(Math.min(cue.endSec * scale, durationSec)),
  }));
}

/**
 * Picks count-1 cut indices at sentence-cue boundaries. For each ideal equal
 * division k*duration/count the closest cue-end boundary wins; monotonicity
 * is preserved so every shot keeps at least one cue.
 */
function chooseCutIndices(scaledCues, count) {
  if (count <= 1) return [];
  const total = scaledCues[scaledCues.length - 1].endSec;
  const lastIndex = scaledCues.length - 1;
  const cuts = [];
  // Sentinel: no cut placed yet; the first cut may follow cue 0.
  let previous = -1;
  for (let k = 1; k <= count - 1; k += 1) {
    const ideal = (total * k) / count;
    // Leave exactly (count - 1 - k) internal boundaries for later cuts, and
    // never cut at the final cue (its end IS the block duration).
    const maxIndex = Math.min(lastIndex - (count - 1 - k), lastIndex - 1);
    let best = -1;
    let bestDiff = Infinity;
    for (let i = previous + 1; i <= maxIndex; i += 1) {
      const diff = Math.abs(scaledCues[i].endSec - ideal);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = i;
      }
    }
    if (best === -1) break;
    cuts.push(best);
    previous = best;
  }
  return cuts;
}

/** Clips cues to [startSec, speechEndSec] and rebases them to shot-local time. */
function rebaseCues(scaledCues, startSec, speechEndSec) {
  const cues = [];
  for (const cue of scaledCues) {
    const start = Math.max(0, cue.startSec - startSec);
    const end = Math.min(cue.endSec, speechEndSec) - startSec;
    if (cue.text && end > start + EPSILON) {
      cues.push({startSec: round6(start), endSec: round6(end), text: cue.text});
    }
  }
  return cues;
}

/**
 * Distributes targetShots across blocks proportionally to their ffprobe
 * durations (largest-remainder method), capped by each block's cue capacity.
 */
function allocateShotCounts(blocks, targetShots) {
  const total = blocks.reduce((sum, b) => sum + b.durationSec, 0);
  const capacities = blocks.map((b) => b.cues.length);
  const ideals = blocks.map((b) => (targetShots * b.durationSec) / total);
  const counts = ideals.map((ideal, i) =>
    Math.min(capacities[i], Math.floor(ideal)),
  );
  const remainderOrder = ideals
    .map((ideal, index) => ({index, fraction: ideal - Math.floor(ideal)}))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  let remaining = targetShots - counts.reduce((sum, c) => sum + c, 0);
  let guard = 0;
  while (remaining > 0 && guard < targetShots * 4 + 8) {
    guard += 1;
    const candidate =
      remainderOrder.find(({index}) => counts[index] < capacities[index]) ??
      remainderOrder
        .slice()
        .sort(
          (a, b) => counts[a.index] - counts[b.index] || a.index - b.index,
        )
        .find(({index}) => counts[index] < capacities[index]);
    if (!candidate) break;
    counts[candidate.index] += 1;
    remaining -= 1;
  }
  // Safety: no block may end up with zero shots while another keeps two or
  // more (only reachable when blocks outnumber the shot budget).
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] > 0) continue;
    const donor = counts.findIndex((count) => count >= 2);
    if (donor === -1) break;
    counts[donor] -= 1;
    counts[i] = 1;
  }
  return counts;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
