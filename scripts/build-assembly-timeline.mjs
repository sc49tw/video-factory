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
const bySlot = new Map();
for (const item of provenance.items ?? []) {
  if (/^N\d{3}-S\d+$/.test(item.slotId)) bySlot.set(item.slotId, item);
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
      return {
        slotId,
        mediaType: item.mediaType,
        sourcePath,
        sourceDurationSec: isVideo ? probeMedia(sourcePath) : null,
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
    `planned=${timeline.plannedDurationSec}s`,
);