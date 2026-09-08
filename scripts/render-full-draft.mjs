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

async function main() {
  const episode = process.argv[2] && !process.argv[2].startsWith("-")
    ? process.argv[2]
    : "ESSY-0002";
  const factoryRoot = process.cwd();
  const projectRoot = path.join(factoryRoot, "projects", episode);
  const outputRoot = path.join(factoryRoot, "output", episode);
  const timelinePath = path.join(projectRoot, "assembly-timeline.json");
  const outputPath = path.join(outputRoot, `${episode}-full-draft-v1.mp4`);
  const segmentRoot = path.join(projectRoot, "temp", "full-draft-shots");

  const timeline = JSON.parse(await readFile(timelinePath, "utf8"));
  const blocks = timeline.blocks ?? [];
  if (!blocks.length) {
    throw new Error(`No narration blocks found in assembly timeline.`);
  }

  await mkdir(segmentRoot, {recursive: true});
  await mkdir(outputRoot, {recursive: true});
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
      if (!(durationSec > 0)) {
        throw new Error(`Shot ${slotId} has no positive render duration.`);
      }
      const sourcePath = shot.sourcePath;
      if (!sourcePath.startsWith("D:") && !sourcePath.startsWith("C:")) {
        throw new Error(`Non-local source path for ${slotId}: ${sourcePath}`);
      }
      const segmentPath = path.join(segmentRoot, `${slotId}.mp4`);
      expectedTotal += durationSec;
      blockTotal += durationSec;
      const windowEnd = windowStart + durationSec;

      process.stdout.write(
        `[SHOT ${slotId}] ${durationSec.toFixed(3)}s @ ${globalCursor.toFixed(3)}s ` +
          `(media ${shot.mediaType})\n`,
      );
      shotReport.push({slotId, sentenceId, startSec: globalCursor, durationSec, mediaType: shot.mediaType});
      globalCursor += durationSec;

      const loopArg = shot.mediaType === "photo" ? ["-loop", "1"] : [];
      const vf =
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p`;
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        ...loopArg,
        "-i", sourcePath,
        "-t", durationSec.toFixed(6),
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
    process.stdout.write(
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
  const usedOnce = shotReport.length === new Set(shotReport.map((r) => r.slotId)).size;
  console.log(
    `\nFull draft rendered: ${path.relative(factoryRoot, outputPath)}\n` +
      `  shots:      ${shotReport.length} sourcing-defined across ${blocks.length} blocks\n` +
      `  expected :  ${expectedTotal.toFixed(3)}s\n` +
      `  actual   :  ${actualDuration.toFixed(3)}s (drift ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}s)\n` +
      `  each slot used exactly once: ${usedOnce ? "yes" : "NO"} | loops: none | narration continuous`,
  );
}

await main();
