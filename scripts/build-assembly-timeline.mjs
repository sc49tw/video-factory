// Builds the validated real-asset assembly timeline artifact for an episode.
//
// Data-driven and deterministic: reads ONLY approved state —
//   - sourcing/downloads/provenance.json (slot -> selected asset + local path),
//   - source/lesson.json                (narration blocks, pauseAfterSec),
//   - manifest.json                     (cached TTS durations per block),
//   - visual-plan.json                  (existing narration-tied subtitle cues),
// and probes ACTUAL ffprobe durations for every selected video.
// No editorial decisions are made here; D1–D5 (incl. N008-S2 = 8871841 and
// N006-S3 = 9818697) are already encoded in provenance.
//
// Usage:
//   node scripts/build-assembly-timeline.mjs ESSY-0001
// Output:
//   projects/ESSY-0001/assembly-timeline.json
import {execFileSync} from "node:child_process";
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {buildAssemblyTimeline} from "../src/assembly-timeline.mjs";

const episode = process.argv[2] && !process.argv[2].startsWith("-")
  ? process.argv[2]
  : "ESSY-0001";
const factoryRoot = process.cwd();
const projectRoot = path.join(factoryRoot, "projects", episode);
const downloadsRoot = path.join(projectRoot, "sourcing", "downloads");

function probeMedia(filePath) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ], {encoding: "utf8"});
  const duration = Number(out.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine media duration: ${filePath}`);
  }
  return duration;
}

const provenance = JSON.parse(
  await readFile(path.join(downloadsRoot, "provenance.json"), "utf8"),
);
const lesson = JSON.parse(
  await readFile(path.join(projectRoot, "source", "lesson.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "manifest.json"), "utf8"),
);
const visualPlan = JSON.parse(
  await readFile(path.join(projectRoot, "visual-plan.json"), "utf8"),
);

// Approved slots in deterministic order (block then S-number).
//
// A re-sourced slot legitimately leaves TWO provenance records behind (the
// superseded one and the approved one). Resolving by "last one read wins" makes
// the timeline depend on array order, so an appended-then-reordered provenance
// file could silently reinstate a superseded asset. Resolution is therefore
// explicit and keyed on ASSET IDENTITY, never on record order or filename:
//   - exactly one record for the slot            -> that record
//   - several records (a re-source happened)     -> the one whose id equals the
//     approved-slot-asset-map assetId; anything else is a hard error
const approvedAssetBySlot = new Map();
{
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === "object") {
      if (typeof node.slotId === "string" && node.assetId) approvedAssetBySlot.set(node.slotId, node.assetId);
      else Object.values(node).forEach(collect);
    }
  };
  collect(JSON.parse(await readFile(path.join(projectRoot, "sourcing", "approved-slot-asset-map.json"), "utf8")));
}

const recordsBySlot = new Map();
for (const item of provenance.items ?? []) {
  if (!/^N\d{3}-S\d+$/.test(item.slotId)) continue;
  const list = recordsBySlot.get(item.slotId) ?? [];
  list.push(item);
  recordsBySlot.set(item.slotId, list);
}

const supersededSlots = [];
const bySlot = new Map();
for (const [slotId, records] of recordsBySlot) {
  if (records.length === 1) {
    const approvedAssetId = approvedAssetBySlot.get(slotId);
    if (approvedAssetId && records[0].id && records[0].id !== approvedAssetId) {
      throw new Error(
        `Asset-map/provenance disagreement for ${slotId}: approved-slot-asset-map names ` +
          `${approvedAssetId} but the only provenance record is ${records[0].id} ` +
          `(${records[0].originalFilename}). Re-run the asset materializer for this slot.`,
      );
    }
    bySlot.set(slotId, records[0]);
    continue;
  }
  const approvedAssetId = approvedAssetBySlot.get(slotId);
  const matching = records.filter((r) => r.id === approvedAssetId);
  if (matching.length !== 1) {
    throw new Error(
      `Provenance cannot be resolved unambiguously for ${slotId}: the approved-slot-asset-map names ` +
        `asset ${approvedAssetId} but ${matching.length} of ${records.length} provenance records match it ` +
        `(records: ${records.map((r) => `${r.originalFilename}=${r.id}`).join(", ")}). ` +
        `Re-run the asset materializer so the superseded records are removed.`,
    );
  }
  supersededSlots.push(`${slotId} (dropped ${records.filter((r) => r !== matching[0]).map((r) => r.id).join(", ")})`);
  bySlot.set(slotId, matching[0]);
}
const slotIds = [...bySlot.keys()].sort();
const blockIds = [...new Set(slotIds.map((id) => id.slice(0, 4)))].sort();

// Editorial still-image motion (P1): resolved from the approved visual-plan shots
// that carry a `slotId` when available, otherwise passthrough from the slot record
// itself(none carry it today→ static by default. Never inferred from shot order).
const stillMotionBySlot = new Map();
for (const shot of visualPlan.shots ?? []) {
  if (shot.slotId && /^N\d{3}-S\d+$/.test(shot.slotId)) {
    stillMotionBySlot.set(shot.slotId, shot.stillMotion ?? null);
  }
}

// sentence-00X <-> N00X mapping.
function sentenceIdForBlockId(blockId) {
  return `sentence-${blockId.slice(1)}`;
}

// Cached TTS durations per sentence from the manifest.
const ttsDuration = new Map(
  (manifest.audio ?? []).map((record) => [record.id, record.durationSec]),
);

// Narration master: block window = cached TTS duration + trailing pause.
const blocks = [];
for (const blockId of blockIds) {
  const sentenceId = sentenceIdForBlockId(blockId);
  const section = (lesson.sections ?? []).find(
    (entry) => String(entry.id).toUpperCase() === blockId,
  );
  const narration = section?.narration?.[0];
  if (!narration) throw new Error(`No narration block found for ${blockId}.`);
  const audioDurationSec = ttsDuration.get(sentenceId);
  if (!audioDurationSec) {
    throw new Error(`No cached TTS duration for ${sentenceId}.`);
  }
  blocks.push({
    sentenceId,
    audioDurationSec,
    pauseAfterSec: narration.pauseAfterSec ?? 0.6,
  });
}

// Approved in-point per slot. The approved-slot-asset-map records, per slot,
// where in the licensed take the shot must start (e.g. N004-S2 takes the
// 18.0-31.92s cut of the same take as N004-S1 precisely so the two shots are
// NOT the same pictures). That decision is authoritative and must reach the
// renderer; it is not an inference made here.
const approvedInPointBySlot = new Map();
{
  const collect = (node) => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (node && typeof node === "object") {
      if (typeof node.slotId === "string" && Number.isFinite(node.inPointSec)) {
        approvedInPointBySlot.set(node.slotId, Number(node.inPointSec));
      } else Object.values(node).forEach(collect);
    }
  };
  collect(JSON.parse(await readFile(path.join(projectRoot, "sourcing", "approved-slot-asset-map.json"), "utf8")));
}

// Actual source durations (ffprobe) per approved slot.
const slotsByBlock = new Map();
for (const blockId of blockIds) {
  const sentenceId = sentenceIdForBlockId(blockId);
  const slots = slotIds
    .filter((id) => id.startsWith(blockId))
    .map((slotId) => {
      const item = bySlot.get(slotId);
      const isVideo = item.mediaType === "video";
      const sourcePath = path.join(factoryRoot, item.localPath);
      const sourceDurationSec = isVideo ? probeMedia(sourcePath) : null;
      const inPointSec = isVideo ? (approvedInPointBySlot.get(slotId) ?? 0) : 0;
      if (inPointSec < 0) {
        throw new Error(`Negative inPointSec for ${slotId}: ${inPointSec}`);
      }
      if (isVideo && sourceDurationSec !== null && inPointSec >= sourceDurationSec) {
        throw new Error(
          `inPointSec ${inPointSec}s for ${slotId} is at or past the end of its ` +
            `${sourceDurationSec.toFixed(3)}s source.`,
        );
      }
      return {
        slotId,
        mediaType: item.mediaType,
        sourcePath,
        sourceDurationSec,
        inPointSec,
        // P1 editorial still motion: visual-plan shot (when slotId present) wins}}}provenance passthrough.

        stillMotion:
          stillMotionBySlot.has(slotId)
            ? stillMotionBySlot.get(slotId)
            : (item.stillMotion ?? null),
      };
    });
  slotsByBlock.set(sentenceId, slots);
}

// Existing narration-tied subtitle cues, lifted to absolute block time.
const cuesByBlock = new Map();
for (const shot of visualPlan.shots ?? []) {
  const blockId = String(shot.sectionId ?? "").toUpperCase();
  const sentenceId = sentenceIdForBlockId(blockId);
  if (!blockIds.includes(blockId)) continue;
  const absCues = cuesByBlock.get(sentenceId) ?? [];
  for (const cue of shot.cues ?? []) {
    absCues.push({
      startSec: shot.startSec + cue.startSec,
      endSec: shot.startSec + cue.endSec,
      text: cue.text,
    });
  }
  cuesByBlock.set(sentenceId, absCues);
}
for (const [key, cues] of cuesByBlock) {
  cuesByBlock.set(key, cues.sort((a, b) => a.startSec - b.startSec));
}

const timeline = buildAssemblyTimeline({blocks, slotsByBlock, cuesByBlock});
timeline.episode = episode;
timeline.createdAt = new Date().toISOString();

const outputPath = path.join(projectRoot, "assembly-timeline.json");
await writeFile(outputPath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${path.relative(factoryRoot, outputPath)}\n` +
    `  blocks=${timeline.blocks.length} shots=${timeline.shots.length} ` +
    `videos=${timeline.shots.filter((s) => s.mediaType === "video").length} ` +
    `photos=${timeline.shots.filter((s) => s.mediaType === "photo").length} ` +
    `planned=${timeline.plannedDurationSec}s` +
    (supersededSlots.length ? `\n  superseded provenance records dropped: ${supersededSlots.join("; ")}` : ""),
);