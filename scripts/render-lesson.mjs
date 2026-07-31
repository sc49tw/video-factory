import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  loadCategoryRegistry,
  validateEpisodeForCategory,
} from "../src/categories.mjs";
import {
  expectedDuration,
  normalizeLesson,
  resolveInside,
  validateEpisodeId,
} from "../src/lesson.mjs";
import {
  createWorkflow,
  readWorkflow,
  recordEvent,
  refreshEpisodeWorkflow,
  registerAttempt,
  writeWorkflow,
} from "../src/workflow.mjs";

const factoryRoot = process.cwd();
const cli = parseArguments(process.argv.slice(2));
const startedAt = new Date().toISOString();
let manifestPath;
let manifestBase;
let activeWorkflow;

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (manifestPath && manifestBase) {
    await writeJson(manifestPath, {
      ...manifestBase,
      completedAt: new Date().toISOString(),
      status: "failed",
      error: message,
    }).catch(() => {});
  }
  if (activeWorkflow) {
    registerAttempt(activeWorkflow, "rendering", "failed", message);
    recordEvent(activeWorkflow, "render-failed", {error: message});
    await writeWorkflow(factoryRoot, activeWorkflow).catch(() => {});
  }
  console.error(`Render failed: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const {episode, lessonPath, inboxRoot} = resolveInput(cli.input);
  validateEpisodeId(episode);
  const projectRoot = path.join(factoryRoot, "projects", episode);
  const outputRoot = path.join(factoryRoot, "output", episode);
  const sourceRoot = path.join(projectRoot, "source");
  const audioRoot = path.join(projectRoot, "audio");
  const subtitleRoot = path.join(projectRoot, "subtitles");
  const segmentRoot = path.join(projectRoot, "segments");
  const tempRoot = path.join(projectRoot, "temp");
  const logRoot = path.join(projectRoot, "logs");
  const outputPath = path.join(outputRoot, `${episode}.mp4`);
  const productionAudio = {
    intro: path.join(factoryRoot, "assets", "audio", "intro.mp3"),
    transition: path.join(factoryRoot, "assets", "audio", "transition.mp3"),
    ending: path.join(factoryRoot, "assets", "audio", "ending.mp3"),
  };
  manifestPath = path.join(projectRoot, "manifest.json");

  if (!(await exists(lessonPath))) {
    throw new Error(`lesson.json does not exist: ${lessonPath}`);
  }
  for (const [label, audioPath] of Object.entries(productionAudio)) {
    if (!(await exists(audioPath))) {
      throw new Error(`Production ${label} audio does not exist: ${audioPath}`);
    }
  }
  let rawLesson;
  try {
    rawLesson = JSON.parse(await readFile(lessonPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${lessonPath}: ${error.message}`);
  }
  const lesson = normalizeLesson(rawLesson, episode);
  const classification = inferClassification(lesson, episode);
  const categoryRegistry = await loadCategoryRegistry(factoryRoot);
  validateEpisodeForCategory(categoryRegistry, episode, classification.series);
  activeWorkflow = await readWorkflow(factoryRoot, episode);
  if (!activeWorkflow) {
    activeWorkflow = createWorkflow({
      id: episode,
      kind: "episode",
      ...classification,
      currentStage: "render-ready",
      status: "ready",
    });
    activeWorkflow.approvals.content = true;
    activeWorkflow.approvals.images = true;
    recordEvent(activeWorkflow, "workflow-created-from-approved-lesson");
  }
  if (!activeWorkflow.approvals.content) {
    throw new Error(
      `Content gate has not been approved. Run pnpm video:workflow approve ${episode} content.`,
    );
  }

  const imageSources = [];
  for (const [index, scene] of lesson.scenes.entries()) {
    const imagePath = resolveInside(inboxRoot, scene.image, `Scene ${index + 1} image`);
    if (!(await exists(imagePath))) {
      throw new Error(`Scene ${index + 1} image does not exist: ${imagePath}`);
    }
    imageSources.push(imagePath);
  }
  let openingSource = null;
  if (lesson.series === "LLFC" && lesson.sharedOpening?.image) {
    openingSource = resolveInside(inboxRoot, lesson.sharedOpening.image, "Shared opening image");
    if (!(await exists(openingSource))) {
      throw new Error(`Shared opening image does not exist: ${openingSource}`);
    }
    imageSources.push(openingSource);
  }
  activeWorkflow.approvals.images = true;
  activeWorkflow.currentStage = "rendering";
  activeWorkflow.status = "running";
  activeWorkflow.nextAction = "Wait for render and automated output validation.";
  recordEvent(activeWorkflow, "render-started", {force: cli.force, clean: cli.clean});
  await writeWorkflow(factoryRoot, activeWorkflow);
  if (lesson.backgroundMusic.enabled && lesson.backgroundMusic.path) {
    const musicPath = resolveInside(
      inboxRoot,
      lesson.backgroundMusic.path,
      "Background music",
    );
    if (!(await exists(musicPath))) {
      lesson.backgroundMusic.enabled = false;
      lesson.backgroundMusic.path = null;
      console.warn(`Background music is missing; continuing without it: ${musicPath}`);
    } else {
      lesson.backgroundMusic.path = musicPath;
    }
  }

  if (cli.clean) {
    await Promise.all([
      rm(segmentRoot, {recursive: true, force: true}),
      rm(tempRoot, {recursive: true, force: true}),
      rm(outputRoot, {recursive: true, force: true}),
    ]);
  }
  if (cli.noCache) {
    await rm(audioRoot, {recursive: true, force: true});
  }
  await Promise.all(
    [sourceRoot, audioRoot, subtitleRoot, segmentRoot, tempRoot, logRoot, outputRoot].map(
      (directory) => mkdir(directory, {recursive: true}),
    ),
  );

  const logLines = [];
  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    logLines.push(line);
    console.log(message);
  };

  const localEdgeTts = path.join(factoryRoot, ".venv", "bin", "edge-tts");
  const edgeTts =
    process.env.EDGE_TTS_PATH ??
    ((await exists(localEdgeTts)) ? localEdgeTts : "edge-tts");
  await Promise.all([
    assertExecutable(edgeTts, ["--version"]),
    assertExecutable("ffmpeg", ["-version"]),
    assertExecutable("ffprobe", ["-version"]),
  ]);

  const lessonBytes = await readFile(lessonPath);
  const lessonHash = sha256(lessonBytes);
  const uniqueImages = [...new Set(imageSources)];
  const imageRecords = await Promise.all(
    uniqueImages.map(async (imagePath) => {
      const fileStat = await stat(imagePath);
      return {
        source: relativeFactoryPath(imagePath),
        file: path.basename(imagePath),
        sha256: sha256(await readFile(imagePath)),
        modifiedAt: fileStat.mtime.toISOString(),
      };
    }),
  );

  manifestBase = {
    schemaVersion: "1.0",
    episode,
    title: lesson.title,
    startedAt,
    sourceLesson: relativeFactoryPath(lessonPath),
    lessonSha256: lessonHash,
    images: imageRecords,
    tts: {
      provider: lesson.tts.provider,
      voice: lesson.tts.voice,
      rate: lesson.tts.rate,
      pitch: lesson.tts.pitch,
      volume: lesson.tts.volume,
    },
    sentenceCount: lesson.sentences.length,
    video: lesson.video,
    countdownSeconds: lesson.countdownSeconds,
    transitionSeconds: lesson.transitionSeconds,
    introSeconds: lesson.introSeconds,
    shadowingTempo: lesson.shadowingTempo,
    finalVideo: relativeFactoryPath(outputPath),
  };
  const previousManifest = await readJsonOptional(manifestPath);
  if (
    !cli.force &&
    !cli.clean &&
    !cli.noCache &&
    (await exists(outputPath)) &&
    previousManifest?.lessonSha256 === lessonHash &&
    previousManifest?.status === "success"
  ) {
    log(`Output is current: ${relativeFactoryPath(outputPath)}`);
    activeWorkflow = await refreshEpisodeWorkflow(factoryRoot, activeWorkflow);
    return;
  }
  await writeJson(manifestPath, {...manifestBase, status: "rendering", error: null});

  await copyFile(lessonPath, path.join(sourceRoot, "lesson.json"));
  for (const imagePath of uniqueImages) {
    await copyFile(imagePath, path.join(sourceRoot, path.basename(imagePath)));
  }

  const audioRecords = [];
  for (const [index, sentence] of lesson.sentences.entries()) {
    const stem = sentence.id;
    const audioPath = path.join(audioRoot, `${stem}.mp3`);
    const cachePath = path.join(audioRoot, `${stem}.json`);
    const sentenceTts = {
      voice: sentence.tts?.voice ?? lesson.tts.voice,
      rate: sentence.tts?.rate ?? lesson.tts.rate,
      pitch: sentence.tts?.pitch ?? lesson.tts.pitch,
      volume: sentence.tts?.volume ?? lesson.tts.volume,
    };
    const cacheTts = {
      voice: sentenceTts.voice,
      rate: sentenceTts.rate,
      pitch: sentenceTts.pitch,
      ...(sentenceTts.volume === "+0%" ? {} : {volume: sentenceTts.volume}),
    };
    const cacheKey = sha256(
      JSON.stringify({
        text: sentence.text,
        ...cacheTts,
      }),
    );
    const cached = await readJsonOptional(cachePath);
    const cacheHit =
      !cli.noCache &&
      cached?.cacheKey === cacheKey &&
      (await exists(audioPath)) &&
      (await fileSize(audioPath)) > 0;
    if (cacheHit) {
      log(`[TTS ${index + 1}/${lesson.sentences.length}] ${stem} (cached)`);
    } else {
      log(`[TTS ${index + 1}/${lesson.sentences.length}] ${stem}`);
      const textPath = path.join(tempRoot, `${stem}.txt`);
      const vttPath = path.join(tempRoot, `${stem}.vtt`);
      const temporaryAudio = path.join(tempRoot, `${stem}.mp3`);
      await writeFile(textPath, `${sentence.text}\n`, "utf8");
      try {
        await run(edgeTts, [
          "--file",
          textPath,
          "--voice",
          sentenceTts.voice,
          `--rate=${sentenceTts.rate}`,
          `--pitch=${sentenceTts.pitch}`,
          `--volume=${sentenceTts.volume}`,
          "--write-media",
          temporaryAudio,
          "--write-subtitles",
          vttPath,
        ]);
      } catch (error) {
        throw new Error(
          `TTS failed for ${stem} (${JSON.stringify(sentence.text)}): ${error.message}`,
        );
      }
      await copyFile(temporaryAudio, audioPath);
      await writeJson(cachePath, {
        cacheKey,
        text: sentence.text,
        ...sentenceTts,
      });
    }
    const durationSec = await probeDuration(audioPath);
    audioRecords.push({
      ...sentence,
      audioPath,
      durationSec,
      cached: cacheHit,
      resolvedTts: sentenceTts,
    });
  }

  const srtPath = path.join(subtitleRoot, "first-pass.srt");
  const srtCues = [];
  let timelineOffset =
    lesson.series === "ESSD"
      ? lesson.introSeconds
      : lesson.series === "LLFC"
        ? lesson.sharedOpening?.durationSec ?? 0
        : 0;
  for (const [index, record] of audioRecords.entries()) {
    srtCues.push({
      startSec: timelineOffset,
      endSec: timelineOffset + record.durationSec,
      text: record.text,
    });
    timelineOffset +=
      lesson.series === "ESSD"
        ? record.durationSec
        : lesson.series === "LLFC"
          ? record.durationSec + lesson.transitionSeconds
          : record.durationSec * 2 +
            lesson.countdownSeconds +
            lesson.transitionSeconds;
  }
  await writeFile(srtPath, formatSrt(srtCues), "utf8");

  const clips = [];
  if (lesson.series === "ESSD") {
    const introPath = path.join(segmentRoot, "intro.mp4");
    await renderIntroClip({
      imagePath: path.join(sourceRoot, path.basename(audioRecords[0].image)),
      audioPath: productionAudio.intro,
      outputPath: introPath,
      series: classification.series,
      subtype: classification.subtype,
      title: lesson.title,
      durationSec: lesson.introSeconds,
      lesson,
    });
    clips.push(introPath);

    for (const [index, record] of audioRecords.entries()) {
      const stagedImage = path.join(sourceRoot, path.basename(record.image));
      const firstPassPath = path.join(segmentRoot, `${record.id}-first.mp4`);
      log(`[FIRST ROUND ${index + 1}/${audioRecords.length}] ${record.id}`);
      await renderNarrationClip({
        imagePath: stagedImage,
        audioPath: record.audioPath,
        outputPath: firstPassPath,
        durationSec: record.durationSec,
        subtitleText: record.text,
        motionIndex: index,
        lesson,
      });
      clips.push(firstPassPath);
    }

    const transitionPath = path.join(segmentRoot, "inter-round-transition.mp4");
    await renderNarrationClip({
      imagePath: path.join(sourceRoot, path.basename(audioRecords.at(-1).image)),
      audioPath: productionAudio.transition,
      outputPath: transitionPath,
      durationSec: lesson.transitionSeconds,
      subtitleText: null,
      motionIndex: audioRecords.length - 1,
      lesson,
    });
    clips.push(transitionPath);

    const interRoundPath = path.join(segmentRoot, "inter-round-prompt.mp4");
    await renderInterRoundClip({
      imagePath: path.join(sourceRoot, path.basename(audioRecords.at(-1).image)),
      outputPath: interRoundPath,
      text: "Now it’s your turn.",
      durationSec: lesson.interRoundPromptSeconds,
      lesson,
    });
    clips.push(interRoundPath);

    for (const [index, record] of audioRecords.entries()) {
      const stagedImage = path.join(sourceRoot, path.basename(record.image));
      const secondPassPath = path.join(segmentRoot, `${record.id}-second.mp4`);
      log(`[SHADOWING ROUND ${index + 1}/${audioRecords.length}] ${record.id}`);
      await renderNarrationClip({
        imagePath: stagedImage,
        audioPath: record.audioPath,
        outputPath: secondPassPath,
        durationSec: record.durationSec / lesson.shadowingTempo,
        subtitleText: null,
        motionIndex: index,
        audioTempo: lesson.shadowingTempo,
        lesson,
      });
      clips.push(secondPassPath);
      for (let number = lesson.countdownSeconds; number >= 1; number -= 1) {
        const countdownPath = path.join(
          segmentRoot,
          `${record.id}-countdown-${number}.mp4`,
        );
        await renderCountdownClip({
          imagePath: stagedImage,
          outputPath: countdownPath,
          number,
          motionIndex: index,
          lesson,
        });
        clips.push(countdownPath);
      }
    }
  } else if (lesson.series === "LLFC") {
    if (openingSource && lesson.sharedOpening?.durationSec > 0) {
      const openingPath = path.join(segmentRoot, "llfc-common-opening.mp4");
      await renderSilentImageClip({
        imagePath: path.join(sourceRoot, path.basename(openingSource)),
        outputPath: openingPath,
        durationSec: lesson.sharedOpening.durationSec,
        lesson,
      });
      clips.push(openingPath);
    }
    for (const [index, record] of audioRecords.entries()) {
      const scene = lesson.scenes[record.sceneIndex];
      const stagedImage = path.join(sourceRoot, path.basename(record.image));
      const clipPath = path.join(segmentRoot, `${record.id}-llfc.mp4`);
      log(`[LLFC ${index + 1}/${audioRecords.length}] ${record.id}`);
      await renderNarrationClip({
        imagePath: stagedImage,
        audioPath: record.audioPath,
        outputPath: clipPath,
        durationSec: record.durationSec + lesson.transitionSeconds,
        subtitleText: record.text,
        motionIndex: index,
        onScreenText: scene?.onScreenText ?? [],
        llfcLayout: true,
        lesson,
      });
      clips.push(clipPath);
    }
  } else for (const [index, record] of audioRecords.entries()) {
    const stagedImage = path.join(sourceRoot, path.basename(record.image));
    const firstPassPath = path.join(segmentRoot, `${record.id}-first.mp4`);
    log(`[VIDEO ${index + 1}/${audioRecords.length}] ${record.id} first pass`);
    await renderNarrationClip({
      imagePath: stagedImage,
      audioPath: record.audioPath,
      outputPath: firstPassPath,
      durationSec: record.durationSec,
      subtitleText: record.text,
      motionIndex: index * 2,
      lesson,
    });
    clips.push(firstPassPath);

    for (let number = lesson.countdownSeconds; number >= 1; number -= 1) {
      const countdownPath = path.join(
        segmentRoot,
        `${record.id}-countdown-${number}.mp4`,
      );
      await renderCountdownClip({
        imagePath: stagedImage,
        outputPath: countdownPath,
        number,
        motionIndex: index * 2,
        lesson,
      });
      clips.push(countdownPath);
    }

    const secondPassPath = path.join(segmentRoot, `${record.id}-second.mp4`);
    log(`[VIDEO ${index + 1}/${audioRecords.length}] ${record.id} second pass`);
    await renderNarrationClip({
      imagePath: stagedImage,
      audioPath: record.audioPath,
      outputPath: secondPassPath,
      durationSec: record.durationSec + lesson.transitionSeconds,
      subtitleText: null,
      motionIndex: index * 2 + 1,
      lesson,
    });
    clips.push(secondPassPath);
  }

  if (lesson.ending.length > 0) {
    const endingPath = path.join(segmentRoot, "ending.mp4");
    await renderEndingClip({
      imagePath: path.join(sourceRoot, path.basename(audioRecords.at(-1).image)),
      audioPath: productionAudio.ending,
      outputPath: endingPath,
      lines: lesson.ending,
      lesson,
    });
    clips.push(endingPath);
  }

  const concatPath = path.join(tempRoot, "concat.txt");
  await writeFile(
    concatPath,
    `${clips.map((file) => `file '${escapeConcatPath(file)}'`).join("\n")}\n`,
    "utf8",
  );
  const concatenatedPath = path.join(tempRoot, `${episode}-concatenated.mp4`);
  log("[FINAL] Concatenating all sentence sequences");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    concatenatedPath,
  ]);

  const temporaryOutput = path.join(outputRoot, `.${episode}.tmp.mp4`);
  if (lesson.backgroundMusic.enabled && lesson.backgroundMusic.path) {
    log("[FINAL] Mixing optional background music");
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      concatenatedPath,
      "-stream_loop",
      "-1",
      "-i",
      lesson.backgroundMusic.path,
      "-filter_complex",
      `[0:a]volume=1[voice];[1:a]volume=${lesson.backgroundMusic.volume}[music];` +
        "[voice][music]amix=inputs=2:duration=first:dropout_transition=0[mix]",
      "-map",
      "0:v:0",
      "-map",
      "[mix]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      "-movflags",
      "+faststart",
      temporaryOutput,
    ]);
  } else {
    await copyFile(concatenatedPath, temporaryOutput);
  }
  await rename(temporaryOutput, outputPath);

  const probe = await probeMedia(outputPath);
  const estimatedDuration = expectedDuration(
    lesson,
    audioRecords.map((record) => record.durationSec),
  );
  const tolerance = Math.max(1.5, lesson.sentences.length * 0.12);
  if (!probe.hasVideo || !probe.hasAudio) {
    throw new Error("Output validation failed: video or audio stream is missing.");
  }
  if (probe.size <= 0 || probe.durationSec <= 0) {
    throw new Error("Output validation failed: file is empty or duration is zero.");
  }
  if (Math.abs(probe.durationSec - estimatedDuration) > tolerance) {
    throw new Error(
      `Output duration ${probe.durationSec.toFixed(3)}s differs from expected ` +
        `${estimatedDuration.toFixed(3)}s by more than ${tolerance.toFixed(3)}s.`,
    );
  }

  const completedAt = new Date().toISOString();
  const successManifest = {
    ...manifestBase,
    completedAt,
    status: "success",
    error: null,
    audio: audioRecords.map((record) => ({
      id: record.id,
      path: relativeFactoryPath(record.audioPath),
      durationSec: round(record.durationSec),
      textSha256: sha256(record.text),
      speaker: record.speaker,
      tts: record.resolvedTts,
    })),
    subtitles: relativeFactoryPath(srtPath),
    estimatedDurationSec: round(estimatedDuration),
    validation: {
      passed: true,
      fileSize: probe.size,
      durationSec: round(probe.durationSec),
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
    },
  };
  await writeJson(manifestPath, successManifest);
  registerAttempt(activeWorkflow, "rendering", "success");
  activeWorkflow.needsRerender = false;
  activeWorkflow.rerenderReason = null;
  recordEvent(activeWorkflow, "render-succeeded", {
    durationSec: round(probe.durationSec),
    output: relativeFactoryPath(outputPath),
  });
  activeWorkflow = await refreshEpisodeWorkflow(factoryRoot, activeWorkflow);
  await writeRetrospective({
    projectRoot,
    episode,
    startedAt,
    completedAt,
    lesson,
    audioRecords,
    probe,
    workflow: activeWorkflow,
  });
  await writeFile(path.join(logRoot, "render.log"), `${logLines.join("\n")}\n`, "utf8");
  console.log(`Render succeeded: ${relativeFactoryPath(outputPath)}`);
  console.log(
    `Validated ${probe.durationSec.toFixed(3)}s, ${lesson.video.width}x${lesson.video.height}, ${lesson.video.fps} fps.`,
  );
}

function inferClassification(lesson, episode) {
  if (lesson.series && lesson.subtype) {
    return {series: lesson.series, subtype: lesson.subtype};
  }
  if (episode.startsWith("ESSD-")) {
    return {series: "ESSD", subtype: "classic-twisted"};
  }
  if (episode.startsWith("LLFC-")) {
    return {series: "LLFC", subtype: "default"};
  }
  throw new Error("lesson.json requires series and subtype for this episode ID.");
}

async function writeRetrospective({
  projectRoot,
  episode,
  startedAt: renderStartedAt,
  completedAt,
  lesson,
  audioRecords,
  probe,
  workflow,
}) {
  const totalMs =
    new Date(completedAt).getTime() - new Date(renderStartedAt).getTime();
  const cacheHits = audioRecords.filter((record) => record.cached === true).length;
  const improvements = [];
  if (totalMs > 120000) {
    improvements.push({
      priority: "medium",
      action: "Reuse unchanged rendered sentence segments on the next run.",
      reason: "This render took more than two minutes.",
      automatic: true,
    });
  }
  if (cacheHits < lesson.sentences.length) {
    improvements.push({
      priority: "low",
      action: "Keep sentence text and TTS settings stable to maximize audio cache reuse.",
      automatic: true,
    });
  }
  await writeJson(path.join(projectRoot, "retrospective.json"), {
    schemaVersion: "1.0",
    episode,
    completedAt,
    totalDurationMs: totalMs,
    sentenceCount: lesson.sentences.length,
    outputDurationSec: round(probe.durationSec),
    ttsCacheHits: cacheHits,
    ttsCacheMisses: lesson.sentences.length - cacheHits,
    attempts: workflow.attempts,
    improvements,
  });
}

function resolveInput(input) {
  if (!input) {
    throw new Error("Usage: pnpm video:render <EPISODE> [--force|--clean|--no-cache]");
  }
  if (input.endsWith(".json") || input.includes("/") || input.includes(path.sep)) {
    const lessonPath = path.resolve(factoryRoot, input);
    const inboxRoot = path.dirname(lessonPath);
    const episode = path.basename(inboxRoot);
    resolveInside(factoryRoot, path.relative(factoryRoot, lessonPath), "Lesson path");
    return {episode, lessonPath, inboxRoot};
  }
  const episode = validateEpisodeId(input);
  const inboxRoot = path.join(factoryRoot, "inbox", episode);
  return {episode, lessonPath: path.join(inboxRoot, "lesson.json"), inboxRoot};
}

function parseArguments(args) {
  const flags = new Set(args.filter((argument) => argument.startsWith("--")));
  const unknown = [...flags].filter(
    (flag) => !["--force", "--clean", "--no-cache"].includes(flag),
  );
  if (unknown.length) {
    throw new Error(`Unknown option: ${unknown.join(", ")}`);
  }
  return {
    input: args.find((argument) => !argument.startsWith("--")),
    force: flags.has("--force"),
    clean: flags.has("--clean"),
    noCache: flags.has("--no-cache"),
  };
}

async function renderSilentImageClip({imagePath, outputPath, durationSec, lesson}) {
  const {width, height, fps} = lesson.video;
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    imagePath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${lesson.tts.sampleRate}:cl=stereo`,
    "-t",
    durationSec.toFixed(6),
    "-vf",
    `${staticImageFilter({width, height, fps})},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(lesson.tts.sampleRate),
    "-ac",
    "2",
    outputPath,
  ]);
}

async function renderNarrationClip({
  imagePath,
  audioPath,
  outputPath,
  durationSec,
  subtitleText,
  motionIndex,
  audioTempo = 1,
  onScreenText = [],
  llfcLayout = false,
  lesson,
}) {
  const {width, height, fps} = lesson.video;
  const frameCount = Math.ceil(durationSec * fps);
  const subtitleLines = subtitleText ? wrapText(subtitleText, 52).split("\n") : [];
  const subtitleLineGap = 62;
  const subtitleFirstY =
    height -
    (subtitleLines.length === 1
      ? 178
      : 210 + Math.max(0, subtitleLines.length - 2) * subtitleLineGap);
  let subtitleTextFilter = null;
  if (subtitleText) {
    const subtitleTextPath = `${outputPath}.subtitle.txt`;
    await writeFile(subtitleTextPath, subtitleLines.join("\n"), "utf8");
    const filterTextPath = subtitleTextPath.replaceAll("\\", "/");
    subtitleTextFilter =
      `drawtext=fontfile=${escapeFilter(fontPath())}:` +
      `textfile=${escapeFilter(filterTextPath)}:` +
      `fontcolor=white:fontsize=48:line_spacing=14:` +
      `x=(w-text_w)/2:y=${subtitleFirstY}`;
  }
  const llfcTextFilters = [];
  if (llfcLayout && Array.isArray(onScreenText) && onScreenText.length > 0) {
    const [heading, ...details] = onScreenText;
    const detailLines = details.flatMap((line) => wrapText(line, 44).split("\n"));
    const headingPath = `${outputPath}.heading.txt`;
    const detailPath = `${outputPath}.details.txt`;
    await writeFile(headingPath, heading, "utf8");
    await writeFile(detailPath, detailLines.join("\n"), "utf8");
    const panelHeight = Math.min(355, 165 + detailLines.length * 38);
    llfcTextFilters.push(
      `drawbox=x=55:y=45:w=900:h=${panelHeight}:color=0xead9b5@0.9:t=fill`,
      `drawbox=x=55:y=45:w=900:h=${panelHeight}:color=0x7a2e22@0.85:t=3`,
      `drawtext=fontfile=${escapeFilter(fontPath())}:textfile=${escapeFilter(
        headingPath.replaceAll("\\", "/"),
      )}:expansion=none:fontcolor=0x2b241c:fontsize=42:x=95:y=82`,
      `drawtext=fontfile=${escapeFilter(fontPath())}:textfile=${escapeFilter(
        detailPath.replaceAll("\\", "/"),
      )}:expansion=none:fontcolor=0x2b241c:fontsize=29:line_spacing=8:x=95:y=148`,
    );
  }
  const filters = [
    lesson.series === "ESSD"
      ? staticImageFilter({width, height, fps})
      : kenBurnsFilter({width, height, fps, frameCount, motionIndex}),
    ...llfcTextFilters,
    subtitleText
      ? `drawbox=x=70:y=ih-245:w=iw-140:h=175:color=black@0.68:t=fill`
      : null,
    subtitleTextFilter,
    "format=yuv420p",
  ]
    .filter(Boolean)
    .join(",");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    imagePath,
    "-i",
    audioPath,
    "-t",
    durationSec.toFixed(6),
    "-vf",
    filters,
    "-af",
    `${audioTempo === 1 ? "" : `atempo=${audioTempo},`}apad=whole_dur=${durationSec.toFixed(
      6,
    )},atrim=duration=${durationSec.toFixed(6)}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(lesson.tts.sampleRate),
    "-ac",
    "2",
    outputPath,
  ]);
}

async function renderIntroClip({
  imagePath,
  audioPath,
  outputPath,
  series,
  subtype,
  title,
  durationSec,
  lesson,
}) {
  const {width, height, fps} = lesson.video;
  const subtypeLabel =
    subtype === "classic-twisted"
      ? "Classic Twisted"
      : subtype === "movie-explained-badly"
        ? "Movie Explained Badly"
        : subtype;
  const filter = [
    staticImageFilter({width, height, fps}),
    "gblur=sigma=12",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.42:t=fill",
    `drawtext=fontfile=${escapeFilter(fontPath())}:text='${escapeDrawtext(
      `${series} · ${subtypeLabel}`,
    )}':fontcolor=white@0.82:fontsize=38:x=(w-text_w)/2:y=h/2-115`,
    `drawtext=fontfile=${escapeFilter(fontPath())}:text='${escapeDrawtext(
      title,
    )}':fontcolor=white:fontsize=76:x=(w-text_w)/2:y=(h-text_h)/2`,
    "format=yuv420p",
  ].join(",");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    imagePath,
    "-i",
    audioPath,
    "-t",
    durationSec.toFixed(6),
    "-vf",
    filter,
    "-af",
    `apad=whole_dur=${durationSec.toFixed(6)},atrim=duration=${durationSec.toFixed(6)}`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(lesson.tts.sampleRate),
    "-ac",
    "2",
    outputPath,
  ]);
}

async function renderCountdownClip({imagePath, outputPath, number, motionIndex, lesson}) {
  const {width, height, fps} = lesson.video;
  const filter = [
    lesson.series === "ESSD"
      ? staticImageFilter({width, height, fps})
      : kenBurnsFilter({width, height, fps, frameCount: fps, motionIndex}),
    "drawbox=x=(iw-260)/2:y=(ih-260)/2:w=260:h=260:color=black@0.62:t=fill",
    `drawtext=fontfile=${escapeFilter(fontPath())}:text='${number}':fontcolor=white:fontsize=180:x=(w-text_w)/2:y=(h-text_h)/2-20`,
    "format=yuv420p",
  ].join(",");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    imagePath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${lesson.tts.sampleRate}:cl=stereo`,
    "-t",
    "1",
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(lesson.tts.sampleRate),
    "-ac",
    "2",
    outputPath,
  ]);
}

async function renderInterRoundClip({
  imagePath,
  outputPath,
  text,
  durationSec,
  lesson,
}) {
  const {width, height, fps} = lesson.video;
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
    "gblur=sigma=14",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.38:t=fill",
    `drawtext=fontfile=${escapeFilter(fontPath())}:text='${escapeDrawtext(
      text,
    )}':fontcolor=white:fontsize=82:x=(w-text_w)/2:y=(h-text_h)/2`,
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    imagePath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=${lesson.tts.sampleRate}:cl=stereo`,
    "-t",
    durationSec.toFixed(6),
    "-vf",
    filter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(lesson.tts.sampleRate),
    "-ac",
    "2",
    outputPath,
  ]);
}

async function renderEndingClip({imagePath, audioPath, outputPath, lines, lesson}) {
  const {width, height, fps} = lesson.video;
  const lineGap = 104;
  const firstY = (height - lineGap * (lines.length - 1)) / 2 - 55;
  const textFilters = lines.map(
    (line, index) =>
      `drawtext=fontfile=${escapeFilter(fontPath())}:text='${escapeDrawtext(
        line,
      )}':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=${Math.round(
        firstY + index * lineGap,
      )}`,
  );
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
    "gblur=sigma=18",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.48:t=fill",
    ...textFilters,
    `fps=${fps}`,
    "format=yuv420p",
  ].join(",");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    imagePath,
    "-i",
    audioPath,
    "-t",
    "4",
    "-vf",
    filter,
    "-af",
    "apad=whole_dur=4,atrim=duration=4",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    String(lesson.tts.sampleRate),
    "-ac",
    "2",
    outputPath,
  ]);
}

function kenBurnsFilter({width, height, fps, frameCount, motionIndex}) {
  const zoomIn = motionIndex % 2 === 0;
  const zoom = zoomIn
    ? `min(zoom+0.00018,1.025)`
    : `if(eq(on,1),1.025,max(zoom-0.00018,1.0))`;
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':` +
    `d=${frameCount}:s=${width}x${height}:fps=${fps}`
  );
}

function staticImageFilter({width, height, fps}) {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height},fps=${fps}`
  );
}

async function probeMedia(filePath) {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_type,codec_name",
      "-of",
      "json",
      filePath,
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

async function probeDuration(filePath) {
  const result = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    {capture: true},
  );
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine media duration: ${filePath}`);
  }
  return duration;
}

function formatSrt(cues) {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.startSec)} --> ${srtTime(cue.endSec)}\n${cue.text}\n`,
    )
    .join("\n")}\n`;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${pad(Math.floor(ms / 3600000), 2)}:${pad(
    Math.floor((ms % 3600000) / 60000),
    2,
  )}:${pad(Math.floor((ms % 60000) / 1000), 2)},${pad(ms % 1000, 3)}`;
}

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
  for (let index = 0; index < lines.length - 1; index += 1) {
    const words = lines[index].split(" ");
    const lastWord = words.at(-1)?.toLowerCase();
    if (["a", "an", "the"].includes(lastWord)) {
      const article = words.pop();
      lines[index] = words.join(" ");
      lines[index + 1] = `${article} ${lines[index + 1]}`;
    }
  }
  return lines.join("\n");
}

function escapeDrawtext(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(":", "\\\\:")
    .replaceAll("'", "\\'")
    .replaceAll("%", "\\%")
    .replaceAll(",", "\\,")
    .replaceAll("\n", "\\n");
}

function escapeFilter(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\\\:");
}

function escapeConcatPath(value) {
  return value.replaceAll("'", "'\\''");
}

function fontPath() {
  if (process.env.VIDEO_FONT_PATH) {
    return process.env.VIDEO_FONT_PATH.replaceAll("\\", "/");
  }
  if (process.platform === "win32") {
    const windowsRoot = process.env.WINDIR || "C:/Windows";
    return path.join(windowsRoot, "Fonts", "arial.ttf").replaceAll("\\", "/");
  }
  if (process.platform === "darwin") {
    return "/System/Library/Fonts/Supplemental/Arial.ttf";
  }
  return "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativeFactoryPath(value) {
  return path.relative(factoryRoot, value).replaceAll(path.sep, "/");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

async function fileSize(filePath) {
  return (await stat(filePath)).size;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJsonOptional(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertExecutable(command, commandArgs) {
  try {
    await run(command, commandArgs, {capture: true});
  } catch {
    throw new Error(`Required command is unavailable: ${command}`);
  }
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
      else
        reject(
          new Error(
            `${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
          ),
        );
    });
  });
}
