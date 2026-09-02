// GENERIC ESSY Final-Assembly renderer (episode-agnostic).
//
// Builds the Final-Assembly master from the episode's APPROVED assembly
// timeline WITHOUT re-sourcing, reordering or re-timing assets:
//
//   A. Cold open   — title overlay fade (per-episode decisions, zero added
//                    duration, subtitles unobscured).
//   B. Ending hold — extends the final shot by endingHoldSec, no subtitles/CTA,
//                    centered end-card text fade (hold appended AFTER the last
//                    subtitle-bearing shot clip — see QA defect note in
//                    projects/ESSY-0001/final-assembly.md §5).
//   C. Music       — pre-built extended BGM master (build-bgm-extended.mjs,
//                    approved equal-power crossfade / low-RMS-anchor method),
//                    gain applied at MIX TIME only (never baked in).
//   D. Subtitles   — MANDATORY shared pipeline: _build-subtitle-timeline.mjs +
//                    subtitle-config.mjs + QA gate (render aborts on QA fail).
//                    Style is derived from subtitle-config.mjs (no second
//                    constant set). Subtitle timing is narration/TTS-driven
//                    and NEVER derived from visual shot boundaries.
//   F. Audio       — the approved continuous narration master
//                    (build-narration-master.mjs) is reused unchanged.
//
// Usage: node scripts/render-essay-final.mjs <EPISODE> [--label v1] [--only=...] [--mix-only]
import {copyFile, mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {buildSubtitleTimeline} from "./_build-subtitle-timeline.mjs";
import {SUBTITLE_CONFIG} from "./subtitle-config.mjs";
import {readWorkflow, refreshEpisodeWorkflow, recordEvent} from "../src/workflow.mjs";
import {
  buildOpeningTitleFilters,
  resolveEndingCardText,
  resolveEssayIdentity,
} from "./essay-identity-config.mjs";

const factoryRoot = process.cwd();
const episode = process.argv[2] ?? "ESSY-0001";

const projectRoot = path.join(factoryRoot, "projects", episode);
const outputRoot = path.join(factoryRoot, "output", episode);
const tempRoot = path.join(projectRoot, "temp", "final-assembly");
const shotRoot = path.join(tempRoot, "shots");

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;

// ---- Subtitle style: DERIVED from the shared subtitle configuration ----
// subtitle-config.mjs style is authored for the 540p review proxy; the final
// 1080p master scales it by the resolution ratio. No second constant set.
const SUBTITLE_SCALE = HEIGHT / 540;
const FINAL_SUBTITLE_STYLE = {
  fontSize: SUBTITLE_CONFIG.STYLE.FONT_SIZE * SUBTITLE_SCALE,
  maxChars: SUBTITLE_CONFIG.MAX_CHARS,
  maxLines: SUBTITLE_CONFIG.MAX_LINES,
  bottomMarginPx: Math.round(SUBTITLE_CONFIG.STYLE.MARGIN_V * SUBTITLE_SCALE),
  lineSpacing: 8,
  borderColor: `black@${SUBTITLE_CONFIG.STYLE.OUTLINE}`,
  shadowColor: `black@${SUBTITLE_CONFIG.STYLE.SHADOW}`,
};

// ---- Per-episode Final-Assembly decisions (projects/<EPISODE>/final-assembly.json) ----
const DECISIONS = JSON.parse(
  await readFile(path.join(projectRoot, "final-assembly.json"), "utf8"),
);

// ---- Series identity (shared, authoritative — see essay-identity-config.mjs).
// Viewer-facing text is NEVER derived from the episode ID / filename / labels.
const IDENTITY = resolveEssayIdentity({finalAssembly: DECISIONS});
if (IDENTITY.ignoredEndCardOverride) {
  // Logged in main() once the log buffer exists.
}

const logLines = [];

function log(message) {
  const line = `[FINAL-ASM] ${message}`;
  logLines.push(line);
  console.log(line);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Final assembly failed: ${message}`);
  await writeFile(
    path.join(tempRoot, "final-assembly-error.log"),
    `${logLines.join("\n")}\n${message}\n`,
    "utf8",
  ).catch(() => {});
  process.exitCode = 1;
}

async function main() {
  if (IDENTITY.ignoredEndCardOverride) {
    log(
      `IDENTITY: ignoring non-canonical endCard.text "${IDENTITY.ignoredEndCardOverride}" — ` +
        `ending card uses the series title "${IDENTITY.seriesTitle}"`,
    );
  }
  log(`IDENTITY: seriesTitle="${IDENTITY.seriesTitle}" episodeTitle="${IDENTITY.episodeTitle}"`);
  await mkdir(shotRoot, {recursive: true});
  await mkdir(outputRoot, {recursive: true});

  const [lesson, timeline, manifest] = await Promise.all([
    readJson(path.join(projectRoot, "source", "lesson.json")),
    readJson(path.join(projectRoot, "assembly-timeline.json")),
    readJson(path.join(projectRoot, "manifest.json")),
  ]);
  // Structural validation — NO hard-coded shot count. The expected structure is
  // derived from the episode's own assembly timeline:
  const blocks = timeline.blocks ?? [];
  const shots = timeline.shots ?? [];
  if (!blocks.length || !shots.length) {
    throw new Error("assembly-timeline.json has no blocks/shots.");
  }
  for (const block of blocks) {
    const blockShots = shots.filter((s) => s.blockId === block.sentenceId);
    const blockTotal = blockShots.reduce((sum, s) => sum + s.renderDurationSec, 0);
    if (Math.abs(blockTotal - block.durationSec) > 0.02) {
      throw new Error(
        `Block ${block.sentenceId}: shot total ${blockTotal.toFixed(3)}s != window ${block.durationSec.toFixed(3)}s.`,
      );
    }
  }
  const lastEnd = shots.at(-1).absoluteEndSec;
  if (Math.abs(lastEnd - (blocks.at(-1).endSec ?? timeline.plannedDurationSec)) > 0.02) {
    throw new Error(
      `Last shot ends ${lastEnd.toFixed(3)}s but narration timeline ends ${(blocks.at(-1).endSec ?? 0).toFixed(3)}s.`,
    );
  }
  const narrationMasterPath = path.join(tempRoot, `${episode}-narration-master.m4a`);
  const narrationMasterExisting = path.join(projectRoot, "temp", `${episode}-narration-master.m4a`);
  await copyIfMissing(narrationMasterExisting, narrationMasterPath);

  // ---- D: MANDATORY shared subtitle pipeline + QA gate ----
  // Cues come from the approved shared timeline builder (per-block edge-tts
  // VTT, DP segmentation, global normalization). If QA fails, the renderer
  // aborts BEFORE any ffmpeg visual work.
  const {cues: allCues, srtPath, qaPath, report} = await buildSubtitleTimeline({root: factoryRoot, episode});
  if (!report.passed) {
    console.error(`Subtitle QA FAILED for ${episode} — final render aborted (no video produced):`);
    console.error(JSON.stringify({
      overlapCountAfterNormalization: report.overlapCountAfterNormalization,
      invalidDurationCueCount: report.invalidDurationCueCount,
      maxRenderedLines: report.maxRenderedLines,
      orphanChildCueCount: report.orphanChildCueCount,
      twoWordChildCueCount: report.twoWordChildCueCount,
      generatedCueDurationBelow700msCount: report.generatedCueDurationBelow700msCount,
      offenders: {
        orphanOffenders: report.orphanOffenders,
        twoWordOffenders: report.twoWordOffenders,
        generatedCueDurationBelow700msOffenders: report.generatedCueDurationBelow700msOffenders,
      },
    }, null, 2));
    process.exit(1);
  }
  log(
    `SUBTITLES QA PASS: ${report.totalCueCount} cues, ` +
      `overlaps ${report.overlapCountBeforeNormalization}->${report.overlapCountAfterNormalization}, ` +
      `maxLines ${report.maxRenderedLines}, srt ${path.relative(factoryRoot, srtPath)}`,
  );

  // Stage the drawtext font locally (colon-free relative path, see fontPath()).
  const stagedFont = path.join(tempRoot, "fonts", "arial.ttf");
  await mkdir(path.dirname(stagedFont), {recursive: true});
  await copyIfMissing(
    path.join(process.env.WINDIR || "C:/Windows", "Fonts", "arial.ttf"),
    stagedFont,
  );

  // ---- A+B: render all shots (subtitle style D + title overlay A) ----
  const clips = [];
  // Accept both "--only N001-S1" and "--only=N001-S1" (the "=" form is one
  // combined argv token; splitting on "=" prevents an accidental full render).
  const onlyArg = process.argv.find((a) => a === "--only" || a.startsWith("--only="));
  const onlyValue = onlyArg === "--only" ? process.argv[process.argv.indexOf(onlyArg) + 1] : onlyArg?.slice(7);
  const onlyShots = onlyValue ? new Set(onlyValue.split(",")) : null;
  const mixOnly = process.argv.includes("--mix-only");
  if (!mixOnly) {
  for (const shot of timeline.shots) {
    if (onlyShots && !onlyShots.has(shot.slotId)) continue;
    const clipPath = path.join(shotRoot, `${shot.slotId}.mp4`);
    // Cues are GLOBAL (episode-absolute) times; shots carry block-RELATIVE
    // startSec/endSec (each block restarts at 0) plus absoluteStartSec/
    // absoluteEndSec. Slicing with the relative window would replay the
    // episode's first cues inside every block after the first (ESSY-0002
    // defect: subtitles restarted at 27.264s). Always slice by absolute time.
    const shotCues = sliceCues(
      allCues,
      shot.absoluteStartSec ?? shot.startSec,
      shot.absoluteEndSec ?? shot.endSec,
    );
    let blockShotIndex = 0;
    for (const other of timeline.shots) {
      if (other.blockId === shot.blockId && other.index < shot.index) blockShotIndex += 1;
    }
    log(`SHOT ${shot.index + 1}/${timeline.shots.length} ${shot.slotId} (${shot.mediaType}, ${shot.renderDurationSec.toFixed(3)}s, ${shotCues.length} cues)`);
    const isTitleShot = shot.index === 0;
    if (shot.mediaType === "video") {
      await renderVideoShot({shot, shotCues, clipPath, isTitleShot});
    } else {
      await renderPhotoShot({
        shot, shotCues, clipPath,
        motionIndex: blockShotIndex % 2,
        frameCount: Math.ceil(shot.renderDurationSec * FPS),
      });
    }
    // Ending hold B: extend the FINAL shot (any media type) by endingHoldSec
    // (no subtitles, no CTA). For video shots the hold freezes the shot's last
    // frame; for photos it extends the photo — no additional footage either way.
    // Order matters: the hold must be concatenated AFTER the final shot's own
    // subtitle-bearing clip, otherwise every later shot is shifted into the
    // hold window and the last cue bleeds past the narration end (QA defect in
    // ESSY-0001 v1).
    if (shot.index === timeline.shots.length - 1) {
      clips.push(clipPath);
      const holdPath = path.join(tempRoot, "ending-hold.mp4");
      await renderEndingHold({shot, clipPath, motionIndex: blockShotIndex % 2, outputPath: holdPath});
      clips.push(holdPath);
      log(`ENDING HOLD rendered (${DECISIONS.endingHoldSec.toFixed(3)}s, no subtitles, no CTA)`);
      continue;
    }
    clips.push(clipPath);
  }
  }

  // Focused-validation mode: renders only the listed shots + ending hold and
  // stops before concat/mix (used by --only=N001-S1,N004-S1 ...).
  if (onlyShots) {
    log(`FOCUSED MODE — rendered shots: ${[...onlyShots].join(", ")} + ending hold. Stopping before concat/mix.`);
    return;
  }

  // ---- Concatenate shots + ending hold ----
  const concatPath = path.join(tempRoot, "concat.txt");
  const visualMasterPath = path.join(tempRoot, `${episode}-visual-master.mp4`);
  if (!mixOnly) {
  await writeFile(
    concatPath,
    `${clips.map((file) => `file '${escapeConcatPath(file)}'`).join("\n")}\n`,
    "utf8",
  );
  log(`CONCAT ${timeline.shots.length} shots + ending hold`);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", concatPath,
    "-c", "copy", "-movflags", "+faststart", visualMasterPath,
  ]);
  }

  // ---- C: BGM — pre-built extended master (see build-bgm-extended.mjs) ----
  // The VISUAL master (concat output) is the duration authority: it ALREADY
  // includes the ending hold, so the final duration equals visualBase exactly.
  // The extended BGM covers the full final duration; its final fade is baked by
  // the builder and its gain is NOT (applied at mix time below only).
  const visualBase = round3((await probeMedia(visualMasterPath)).durationSec);
  const musicTotal = visualBase;
  const extendedSource = path.resolve(factoryRoot, DECISIONS.music.extendedPath);
  const extendedProbe = await probeMedia(extendedSource);
  if (!(extendedProbe.durationSec >= musicTotal - 1.0)) {
    throw new Error(
      `Extended BGM master ${extendedProbe.durationSec?.toFixed(3)}s does not cover final duration ` +
        `${musicTotal.toFixed(3)}s. Run: pnpm video:build-bgm ${episode}`,
    );
  }
  log(`BGM extended master covers ${extendedProbe.durationSec?.toFixed(3)}s (need ${musicTotal.toFixed(3)}s)`);

  // Output label: "--label v2" renders ESSY-0001-final-v2.mp4 (default v1,
  // preserving the original approved v1 output untouched).
  const labelIndex = process.argv.indexOf("--label");
  const label = labelIndex !== -1 && process.argv[labelIndex + 1]
    ? process.argv[labelIndex + 1]
    : "v1";

  // ---- F: final mix — narration master + Dreamland at -9 dB (mix-time) ----
  const finalOutput = path.join(outputRoot, `${episode}-final-${label}.mp4`);
  const temporaryOutput = path.join(outputRoot, `.${episode}-final-${label}.tmp.mp4`);
  const musicGain = Math.pow(10, (DECISIONS.music.gainDb ?? -9) / 20).toFixed(6);
  log(`MIX narration master + extended BGM @ ${musicGain} (${DECISIONS.music.gainDb ?? -9} dB, normalize=0, no ducking)`);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", visualMasterPath,
    "-i", narrationMasterPath,
    "-i", extendedSource,
    "-filter_complex",
    `[1:a]apad=whole_dur=${musicTotal.toFixed(3)},atrim=duration=${musicTotal.toFixed(3)},anull[nar];` +
      `[2:a]volume=${musicGain},apad=whole_dur=${musicTotal.toFixed(3)},atrim=duration=${musicTotal.toFixed(3)}[bgm];` +
      `[nar][bgm]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mix]`,
    "-map", "0:v:0", "-map", "[mix]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    temporaryOutput,
  ]);
  await rm(finalOutput, {force: true});
  await rename(temporaryOutput, finalOutput);

  // ---- Technical QA ----
  const probe = await probeMedia(finalOutput);
  if (!probe.hasVideo || !probe.hasAudio) {
    throw new Error("Output validation failed: video or audio stream is missing.");
  }
  const levels = await audioLevels(finalOutput);
  log(`QA duration=${probe.durationSec?.toFixed(3)}s ${probe.videoCodec}/${probe.audioCodec}`);
  log(`QA mean_volume=${levels.mean} max_volume=${levels.max} (peak used for clipping check)`);
  await writeFile(
    path.join(tempRoot, "final-assembly-qa.json"),
    `${JSON.stringify({
      episode,
      output: path.relative(factoryRoot, finalOutput).replaceAll("\\", "/"),
      durationSec: probe.durationSec,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      sizeBytes: probe.size,
      audioMeanVolumeDb: levels.mean,
      audioMaxVolumeDb: levels.max,
      musicGainDb: DECISIONS.music?.gainDb ?? -9,
      musicSelectedTrack: DECISIONS.music?.selectedTrack,
      subtitleQa: {
        totalCueCount: report.totalCueCount,
        overlapCountAfterNormalization: report.overlapCountAfterNormalization,
        invalidDurationCueCount: report.invalidDurationCueCount,
        maxRenderedLines: report.maxRenderedLines,
        orphanChildCueCount: report.orphanChildCueCount,
        twoWordChildCueCount: report.twoWordChildCueCount,
        generatedCueDurationBelow700msCount: report.generatedCueDurationBelow700msCount,
        passed: report.passed,
        reportPath: path.relative(factoryRoot, qaPath).replaceAll("\\", "/"),
      },
      endingHoldSec: DECISIONS.endingHoldSec,
      baseDurationSec: round3(visualBase - DECISIONS.endingHoldSec),
      durationAddedSec: DECISIONS.endingHoldSec,
      shots: timeline.shots.length,
      narrationBlocks: manifest.audio?.length ?? 18,
    }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Render succeeded: ${path.relative(factoryRoot, finalOutput)}`);

  // ---- Workflow sync ----
  // A successful final render is an artifact event, NOT a completion: the
  // episode reaches "completed" only after the user approves final-assembly
  // (pnpm video:workflow approve <EP> final-assembly). Any new render also
  // invalidates a previous final-assembly approval so artifact and workflow
  // state can never drift apart.
  try {
    const workflow = await readWorkflow(factoryRoot, episode);
    if (workflow) {
      workflow.approvals.finalQa = false;
      // A new render voids the legacy reconciliation: the workflow must be
      // re-derived from the real gates instead of the grandfathered state.
      workflow.legacyGates = false;
      workflow.needsRerender = false;
      workflow.rerenderReason = null;
      recordEvent(workflow, "final-render-succeeded", {
        output: path.relative(factoryRoot, finalOutput).replaceAll("\\", "/"),
        label,
        durationSec: round3(probe.durationSec),
        subtitleQaPassed: report.passed === true,
      });
      await refreshEpisodeWorkflow(factoryRoot, workflow);
      console.log(
        `Workflow ${episode}: stage=${workflow.currentStage}; ` +
        `awaiting approval: pnpm video:workflow approve ${episode} final-assembly`,
      );
    }
  } catch (error) {
    console.warn(`Workflow sync skipped: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Shot renderers (same mechanical treatment as the approved review cut)
// ---------------------------------------------------------------------------

async function renderVideoShot({shot, shotCues, clipPath, isTitleShot}) {
  const subtitleFilters = await buildFinalSubtitleFilters({clipPath, cueList: shotCues});
  const filters = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${WIDTH}:${HEIGHT}`,
    `fps=${FPS}`,
    ...(isTitleShot ? [openingTitleFilter()] : []),
    subtitleFilters,
    "format=yuv420p",
  ].filter(Boolean).join(",");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", shot.sourcePath,
    "-t", shot.renderDurationSec.toFixed(6),
    "-vf", filters,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an",
    clipPath,
  ]);
}

async function renderPhotoShot({shot, shotCues, clipPath, motionIndex, frameCount}) {
  const subtitleFilters = await buildFinalSubtitleFilters({clipPath, cueList: shotCues});
  const filters = [
    kenBurnsFilter({frameCount, motionIndex}),
    subtitleFilters,
    "format=yuv420p",
  ].filter(Boolean).join(",");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1", "-framerate", String(FPS), "-i", shot.sourcePath,
    "-t", shot.renderDurationSec.toFixed(6),
    "-vf", filters,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an",
    clipPath,
  ]);
}

async function renderEndingHold({shot, clipPath, motionIndex, outputPath}) {
  const hold = DECISIONS.endingHoldSec;
  const frameCount = Math.ceil(hold * FPS);
  // Hold source: the photo itself, or the final shot's LAST frame (video).
  // IMPORTANT: never extract the last frame from the burned-subtitle clip —
  // the hold must be subtitle-free. Render a subtitle-free temp copy of the
  // final shot and freeze its last frame instead.
  let source = shot.sourcePath;
  if (shot.mediaType !== "photo") {
    const cleanClipPath = path.join(tempRoot, "ending-hold-clean-shot.mp4");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", shot.sourcePath,
      "-t", shot.renderDurationSec.toFixed(6),
      "-vf", [
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${WIDTH}:${HEIGHT}`,
        `fps=${FPS}`,
        "format=yuv420p",
      ].join(","),
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      cleanClipPath,
    ]);
    const lastFramePath = path.join(tempRoot, "ending-hold-last-frame.png");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-sseof", "-0.05", "-i", cleanClipPath,
      "-update", "1", "-frames:v", "1",
      lastFramePath,
    ]);
    source = lastFramePath;
  }
  // Gentle fade-in (0.4–1.4 s), readable hold, gentle fade-out (2.8–3.8 s).
  const alpha =
    `'if(lt(t,0.4),0,if(lt(t,1.4),(t-0.4)/1.0,` +
    `if(lt(t,2.8),1,if(lt(t,3.8),(3.8-t)/1.0,0))))'`;
  const textPath = path.join(tempRoot, "ending-title.txt");
  // Ending card is ALWAYS the series title (shared identity contract).
  await writeFile(textPath, resolveEndingCardText({finalAssembly: DECISIONS}), "utf8");
  const filter = [
    kenBurnsFilter({frameCount, motionIndex}),
    `drawtext=fontfile=${escapeFilter(fontPath())}:textfile=${escapeFilter(relativeFactoryPath(textPath))}:` +
      `expansion=none:fontcolor=white:fontsize=64:` +
      `x=(w-text_w)/2:y=(h-text_h)/2:alpha=${alpha}`,
    "format=yuv420p",
  ].join(",");
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1", "-framerate", String(FPS), "-i", source,
    "-t", hold.toFixed(6),
    "-vf", filter,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an",
    outputPath,
  ]);
}

function openingTitleFilter() {
  // Shared ESSY identity contract: seriesTitle DOMINANT, episodeTitle secondary.
  // Timing (fade in/out) still comes from the episode's title block.
  return buildOpeningTitleFilters({
    seriesTitle: IDENTITY.seriesTitle,
    episodeTitle: IDENTITY.episodeTitle,
    timing: DECISIONS.title,
    fontPath: fontPath(),
  });
}

// ---------------------------------------------------------------------------
// Final subtitle rendering — style derived from subtitle-config.mjs (shared).
// The shared builder guarantees maxLines via QA; no legacy re-splitting here.
// ---------------------------------------------------------------------------

async function buildFinalSubtitleFilters({clipPath, cueList}) {
  const {fontSize, maxChars, bottomMarginPx, lineSpacing, borderColor, shadowColor} = FINAL_SUBTITLE_STYLE;
  const filters = [];
  for (const cue of cueList) {
    const lines = wrapText(cue.text, maxChars).split("\n");
    const blockHeight = lines.length * fontSize + (lines.length - 1) * lineSpacing;
    const firstY = HEIGHT - bottomMarginPx - blockHeight;
    const enable = `enable='between(t,${cue.startSec.toFixed(3)},${cue.endSec.toFixed(3)})'`;
    const cueTextPath = `${clipPath}.cue-${String(filters.length + 1).padStart(3, "0")}.txt`;
    await writeFile(cueTextPath, lines.join("\n"), "utf8");
    filters.push(
      `drawtext=fontfile=${escapeFilter(fontPath())}:` +
        `textfile=${escapeFilter(relativeFactoryPath(cueTextPath))}:` +
        `expansion=none:fontcolor=white:fontsize=${fontSize}:line_spacing=${lineSpacing}:` +
        `borderw=2:bordercolor=${borderColor}:` +
        `shadowcolor=${shadowColor}:shadowx=2:shadowy=2:` +
        `x=(w-text_w)/2:y=${firstY}:${enable}`,
    );
  }
  return filters.join(",");
}

// Legacy in-renderer cue re-splitting (expandCuesToMaxLines) REMOVED —
// subtitle segmentation is owned exclusively by the shared pipeline
// (_build-subtitle-timeline.mjs), whose QA gate guarantees <=2 rendered lines.

function wrapText(value, maxChars) {
  const lines = [];
  let line = "";
  for (const word of String(value).trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// (BGM construction removed — the extended BGM master is built by
// scripts/build-bgm-extended.mjs and consumed as-is at mix time.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sliceCues(absCues, startSec, endSec) {
  const clipped = [];
  for (const cue of absCues) {
    const start = Math.max(cue.startSec, startSec);
    const end = Math.min(cue.endSec, endSec);
    if (end - start > 0.05) {
      clipped.push({...cue, startSec: start - startSec, endSec: end - startSec});
    }
  }
  return clipped;
}

function kenBurnsFilter({frameCount, motionIndex}) {
  const zoomIn = motionIndex % 2 === 0;
  const zoom = zoomIn
    ? `min(zoom+0.00018,1.025)`
    : `if(eq(on,1),1.025,max(zoom-0.00018,1.0))`;
  return (
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${frameCount}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`
  );
}

function fontPath() {
  if (process.env.VIDEO_FONT_PATH) {
    return relativeFactoryPath(process.env.VIDEO_FONT_PATH);
  }
  // Relative (colon-free) per-episode staged path: ffmpeg 8 filtergraph
  // parsing rejects the "C\\:/..." drive-letter escaping, so the font is
  // staged locally per episode (from the shared Windows system font).
  return `projects/${episode}/temp/final-assembly/fonts/arial.ttf`;
}

function relativeFactoryPath(value) {
  return path.relative(factoryRoot, value).replaceAll(path.sep, "/");
}

function escapeConcatPath(value) {
  return value.replaceAll("'", "'\\''");
}

function escapeFilter(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function copyIfMissing(sourcePath, destinationPath) {
  try {
    await readFile(destinationPath);
  } catch {
    await copyFile(sourcePath, destinationPath);
  }
}

async function probeMedia(filePath) {
  const result = await run(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration,size:stream=codec_type,codec_name",
      "-of", "json", filePath,
    ],
    {capture: true},
  );
  const data = JSON.parse(result.stdout);
  const streams = data.streams ?? [];
  return {
    durationSec: Number(data.format?.duration),
    size: Number(data.format?.size),
    hasVideo: streams.some((stream) => stream.codec_type === "video"),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    videoCodec: streams.find((stream) => stream.codec_type === "video")?.codec_name,
    audioCodec: streams.find((stream) => stream.codec_type === "audio")?.codec_name,
  };
}

async function audioLevels(filePath) {
  const result = await run(
    "ffmpeg",
    ["-hide_banner", "-i", filePath, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    {capture: true},
  );
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(result.stderr)?.[1];
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(result.stderr)?.[1];
  return {mean: mean ? `${mean} dB` : "n/a", max: max ? `${max} dB` : "n/a"};
}

function run(command, commandArgs, {capture = false} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: factoryRoot,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({stdout, stderr});
      else reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}
