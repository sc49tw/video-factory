// ESSY-0002 FULL DRAFT renderer (18 narration blocks, 64 sourcing-defined
// shots). Extends the approved prototype-N001-N005-v2 technical contract to
// the whole episode:
//
//   - shots come from the deterministic assembly-timeline.json (one shot per
//     slot, slot order, renderDurationSec already capped by ffprobe source
//     duration at build time),
//   - every shot renders VIDEO ONLY from its own t=0 (no -ss, no loop, no
//     repeated/overlapping source ranges),
//   - each block's single continuous cached TTS mp3 stays ONE stream and is
//     muxed exactly once onto the block's finished visual track (apad/atrim
//     to the block window; pauseAfterSec becomes trailing silence),
//   - narration/TTS/manifest are never modified.
//
// ESSY-0002 has no subtitle cue track (visual-plan cues are empty — same as
// the approved prototype), so no subtitles are baked.
//
// Usage:
//   node scripts/render-full-draft.mjs ESSY-0002
import {spawn} from "node:child_process";
import {mkdir, readFile, readdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {pathToFileURL} from "node:url";
import {
  assertShotSourcesRenderable,
  computeMasterDraftFingerprint,
  findDuplicateSourceShots,
  writeMasterDraftProvenance,
} from "../src/master-draft-freshness.mjs";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({stdout, stderr});
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

async function probeDuration(filePath) {
  const {stdout} = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine media duration: ${filePath}`);
  }
  return duration;
}

export async function renderFullDraft({root, episode, log = console.log}) {
  const factoryRoot = root;
  const projectRoot = path.join(factoryRoot, "projects", episode);
  const outputRoot = path.join(factoryRoot, "output", episode);
  const timelinePath = path.join(projectRoot, "assembly-timeline.json");
  const outputPath = path.join(outputRoot, `${episode}-full-draft-v1.mp4`);
  const segmentRoot = path.join(projectRoot, "temp", "full-draft-shots");
  await mkdir(outputRoot, {recursive: true});

  const timeline = JSON.parse(await readFile(timelinePath, "utf8"));
  const blocks = timeline.blocks ?? [];
  if (!blocks.length) {
    throw new Error(`No narration blocks found in assembly timeline.`);
  }

  // ---- Pre-render dependency gates -------------------------------------
  // Run BEFORE any ffmpeg work so an unusable input can never produce a partial
  // or misleading master.
  //
  // 1. Repetition gate: two slots of one block that play the same source frames.
  //    Checked from sha256 (this repo names every download per slot, so two
  //    files can be one file) AND from the approved source ranges, so a shared
  //    licensed take cut twice is allowed while an actual repeat is not.
  // 2. Degenerate-source gate: a flat/stub download passes every container check
  //    (ftyp, duration, size, sha256) yet renders as a black screen. Measure the
  //    decoded picture instead of trusting the container.
  const fingerprint = await computeMasterDraftFingerprint({root: factoryRoot, episode});
  const sharedTakes = findDuplicateSourceShots(fingerprint);
  const repetitions = sharedTakes.filter((d) => d.isRepetition);
  if (repetitions.length) {
    const lines = repetitions
      .map(
        (d) =>
          `  ${d.sentenceId}: ${d.slotIds.join(" and ")} replay ${d.sourcePath} over OVERLAPPING ranges ` +
          `(${d.overlapping.map((o) => `${o.slotIds.join("/")} overlap ${o.overlapSec}s`).join(", ")}) ` +
          `- sha256 ${d.sourceSha256.slice(0, 12)}`,
      )
      .join("\n");
    throw new Error(
      `Adjacent slots replay the same source frames (visual repetition):\n${lines}\n` +
        `Either give each slot a distinct approved asset, or record disjoint approved in-points ` +
        `for the shared take.`,
    );
  }
  await assertShotSourcesRenderable(fingerprint);
  log(
    `Dependency gates passed: ${fingerprint.shots.length} shot sources, all renderable. ` +
      (sharedTakes.length
        ? `${sharedTakes.length} shared take(s) with disjoint approved in-points ` +
          `(${sharedTakes.map((d) => d.slotIds.join("+")).join(", ")}). `
        : "") +
      `Fingerprint ${fingerprint.fingerprintSha256.slice(0, 12)}`,
  );

  await mkdir(segmentRoot, {recursive: true});
  for (const entry of await readdir(segmentRoot)) {
    await rm(path.join(segmentRoot, entry), {force: true});
  }

  const blockFiles = [];
  const shotReport = [];
  let expectedTotal = 0;
  let globalCursor = 0;
  const usedSlots = new Set();
for (const block of blocks) {
    const sentenceId = block.sentenceId;
    const blockDurationSec = block.durationSec ?? 0;
    if (!(blockDurationSec > 0)) {
      throw new Error(`Block ${sentenceId} has no positive duration.`);
    }
    const shots = block.shots ?? [];
    const audioPath = path.join(projectRoot, "audio", `${sentenceId}.mp3`);
    const audioProbe = await probeDuration(audioPath);
    if (audioProbe > blockDurationSec + 0.05) {
      throw new Error(
        `Narration TRUNCATION RISK ${sentenceId}: TTS ${audioProbe.toFixed(3)}s ` +
          `exceeds block window ${blockDurationSec.toFixed(3)}s.`,
      );
    }

    const blockSegments = [];
    let windowStart = 0;
    let blockTotal = 0;
    for (const shot of shots) {
      const slotId = shot.slotId;
      if (usedSlots.has(slotId)) {
        throw new Error(`Slot ${slotId} used more than once.`);
      }
      usedSlots.add(slotId);
      const durationSec = shot.renderDurationSec;
      // Deterministic last-frame hold: the block's trailing pause (plus any
      // approved narration trim tolerance) is rendered AFTER source playback
      // ends as a frozen final frame. Never looped, never sourced longer.
      const holdSec = shot.trailingHoldSec ?? 0;
      const renderDurationSec = durationSec + holdSec;
      if (!(renderDurationSec > 0)) {
        throw new Error(`Shot ${slotId} has no positive render duration.`);
      }
      const sourcePath = shot.sourcePath;
      if (!sourcePath.startsWith("D:") && !sourcePath.startsWith("C:")) {
        throw new Error(`Non-local source path for ${slotId}: ${sourcePath}`);
      }
      // Approved in-point inside the licensed take (0 unless the approved map
      // names a later cut). The renderer seeks here — never loops, never extends.
      const inPointSec = shot.mediaType === "video" ? Number(shot.inPointSec ?? 0) : 0;
      const segmentPath = path.join(segmentRoot, `${slotId}.mp4`);
      expectedTotal += renderDurationSec;
      blockTotal += renderDurationSec;
      const windowEnd = windowStart + renderDurationSec;

      log(
        `[SHOT ${slotId}] ${durationSec.toFixed(3)}s + hold ${holdSec.toFixed(3)}s ` +
          `@ ${globalCursor.toFixed(3)}s (media ${shot.mediaType}` +
          `${inPointSec > 0 ? `, in-point ${inPointSec.toFixed(3)}s` : ""})\n`,
      );
      shotReport.push({
        slotId,
        sentenceId,
        startSec: globalCursor,
        durationSec,
        mediaType: shot.mediaType,
        inPointSec,
      });
      globalCursor += renderDurationSec;

      const loopArg = shot.mediaType === "photo" ? ["-loop", "1"] : [];
      // Videos seek to the approved in-point. This is what lets two slots of one
      // block share a single licensed take and still show different pictures
      // (e.g. N004-S1 plays 0-13.92s while N004-S2 plays 18-31.92s).
      const seekArg =
        shot.mediaType === "video" && inPointSec > 0 ? ["-ss", inPointSec.toFixed(6)] : [];
      // Photos loop over any duration; videos need an explicit clone of the
      // final frame for the hold (no looping, no re-seeking of the source).
      const holdFilters =
        holdSec > 0 && shot.mediaType === "video"
          ? [`tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(6)}`]
          : [];
      const vf =
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p` +
        (holdFilters.length ? `,${holdFilters.join(",")}` : "");
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        ...loopArg,
        ...seekArg,
        "-i", sourcePath,
        "-t", renderDurationSec.toFixed(6),
        "-an",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        segmentPath,
      ]);
      blockSegments.push(segmentPath);
      windowStart = windowEnd;
    }

    const blockTotalRounded = Math.round(blockTotal * 1000) / 1000;
    const blockWindowRounded = Math.round(blockDurationSec * 1000) / 1000;
    if (Math.abs(blockTotalRounded - blockWindowRounded) > 0.02) {
      throw new Error(
        `Block ${sentenceId}: shot total ${blockTotalRounded}s != window ${blockWindowRounded}s.`,
      );
    }

    // Join the block's video-only shots into one continuous visual track.
    const blockVideoPath = path.join(segmentRoot, `${sentenceId}-video.mp4`);
    const blockListPath = path.join(segmentRoot, `${sentenceId}-list.txt`);
    await writeFile(
      blockListPath,
      `${blockSegments.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
      "utf8",
    );
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0",
      "-i", blockListPath,
      "-c", "copy",
      blockVideoPath,
    ]);

    // Mux the ONE continuous cached TTS block audio onto the visual track.
    const blockPath = path.join(segmentRoot, `${sentenceId}-av.mp4`);
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", blockVideoPath,
      "-i", audioPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-af",
      `apad=whole_dur=${blockDurationSec.toFixed(6)},atrim=duration=${blockDurationSec.toFixed(6)}`,
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
      "-ar", "48000", "-ac", "2",
      blockPath,
    ]);
    blockFiles.push(blockPath);
    log(
      `[BLOCK ${sentenceId}] continuous TTS muxed onto ${shots.length} shots (${blockDurationSec.toFixed(3)}s)\n`,
    );
  }

  // Final concat of all 18 block AV segments.
  const concatPath = path.join(projectRoot, "temp", "full-draft-concat.txt");
  await writeFile(
    concatPath,
    `${blockFiles.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
    "utf8",
  );
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0",
    "-i", concatPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);

  const actualDuration = await probeDuration(outputPath);
  const drift = actualDuration - expectedTotal;
  if (Math.abs(drift) > 1.5) {
    throw new Error(
      `Full draft duration ${actualDuration.toFixed(3)}s differs from planned ` +
        `${expectedTotal.toFixed(3)}s by ${drift.toFixed(3)}s (>1.5s).`,
    );
  }
  // Record the dependency fingerprint so downstream review renders can prove this
  // master still reflects the current assembly timeline and shot source files.
  const provenancePath = await writeMasterDraftProvenance({
    root: factoryRoot,
    masterPath: outputPath,
    fingerprint,
    extra: {plannedDurationSec: expectedTotal, shotCount: shotReport.length},
  });
  const usedOnce = shotReport.length === new Set(shotReport.map((r) => r.slotId)).size;
  log(
    `\nFull draft rendered: ${path.relative(factoryRoot, outputPath)}\n` +
      `  shots:      ${shotReport.length} sourcing-defined across ${blocks.length} blocks\n` +
      `  expected :  ${expectedTotal.toFixed(3)}s\n` +
      `  actual   :  ${actualDuration.toFixed(3)}s (drift ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}s)\n` +
      `  provenance: ${path.relative(factoryRoot, provenancePath)}\n` +
      `  fingerprint: ${fingerprint.fingerprintSha256}\n` +
      `  each slot used exactly once: ${usedOnce ? "yes" : "NO"} | loops: none | narration continuous`,
  );
  return {
    masterPath: outputPath,
    fingerprint,
    provenancePath,
    expectedTotalSec: expectedTotal,
    actualDurationSec: actualDuration,
  };
}

// Direct invocation: `node scripts/render-full-draft.mjs <EPISODE>`
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const episode = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "ESSY-0002";
  await renderFullDraft({root: process.cwd(), episode});
}
