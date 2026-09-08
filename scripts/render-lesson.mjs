import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {
  copyFile,
  mkdir,
  readdir,
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
  isEssayInput,
  normalizeEssayEpisode,
} from "../src/essay-episode.mjs";
import {
  planVisualShots,
  validateVisualPlan,
} from "../src/visual-plan.mjs";
import {
  resolveStillMotion,
  stillImageFilter,
} from "./_still-motion.mjs";
import {
  createWorkflow,
  readWorkflow,
  recordEvent,
  refreshEpisodeWorkflow,
  registerAttempt,
  writeWorkflow,
} from "../src/workflow.mjs";
import {
  filterTimeline,
  sliceCues,
  validateAssemblyTimeline,
} from "../src/assembly-timeline.mjs";

const factoryRoot = process.cwd();
// Essay visual plan budget used when --visual-shots is not provided
// (ESSY-0001 v2 ships exactly this shot count, all automatically timed).
const DEFAULT_ESSAY_VISUAL_SHOTS = 59;
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
  const outputPath = path.join(
    outputRoot,
    cli.outName ?? `${episode}.mp4`,
  );
  const productionAudio = {
    intro: path.join(factoryRoot, "assets", "audio", "intro.mp3"),
    transition: path.join(factoryRoot, "assets", "audio", "transition.mp3"),
    ending: path.join(factoryRoot, "assets", "audio", "ending.mp3"),
  };
  // --real-asset renders a REVIEW CUT: the approved manifest/workflow state is
  // NOT mutated. The renderer's mechanical manifest writes are redirected to a
  // sidecar review manifest and workflow events are suppressed.
  manifestPath = cli.realAsset
    ? path.join(projectRoot, "real-assets-manifest.json")
    : path.join(projectRoot, "manifest.json");

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
  const lesson = isEssayInput(rawLesson)
    ? await normalizeEssayEpisode(rawLesson, episode, inboxRoot)
    : normalizeLesson(rawLesson, episode);
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
  if (!cli.realAsset) {
    recordEvent(activeWorkflow, "render-started", {force: cli.force, clean: cli.clean});
    await writeWorkflow(factoryRoot, activeWorkflow);
  }
  if (lesson.backgroundMusic.enabled && lesson.backgroundMusic.path && !cli.realAsset) {
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

  if (lesson.renderMode === "storybook-silent") {
    await renderStorybookSilent({
      episode,
      lessonPath,
      rawLesson,
      lesson,
      projectRoot,
      outputRoot,
      sourceRoot,
      segmentRoot,
      tempRoot,
      logRoot,
      outputPath,
      imageSources,
      logLines,
      log,
    });
    return;
  }

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
      // Essay episodes carry per-asset provenance from inbox/<EP>/visuals.json;
      // other pipelines have no visualProvenance and are unchanged.
      const provenance =
        lesson.visualProvenance?.[path.basename(imagePath)] ?? null;
      return {
        source: relativeFactoryPath(imagePath),
        file: path.basename(imagePath),
        sha256: sha256(await readFile(imagePath)),
        modifiedAt: fileStat.mtime.toISOString(),
        ...(provenance
          ? {
              sourceUrl: provenance.sourceUrl,
              creator: provenance.creator,
              license: provenance.license,
              downloadedAt: provenance.downloadedAt,
              originalFilename: provenance.originalFilename,
            }
          : {}),
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
    // Per-generation subtitle timing policy: ESSY episodes rendered by this
    // pipeline REQUIRE word-boundary timing (scripts/generate-essy-tts.py).
    // Legacy manifests without this field stay on warn/fallback behavior.
    ...(lesson.series === "ESSY"
      ? {subtitleTiming: {policy: "word-boundary-required", schemaVersion: "1.0"}}
      : {}),
    sentenceCount: lesson.sentences.length,
    video: lesson.video,
    countdownSeconds: lesson.countdownSeconds,
    transitionSeconds: lesson.transitionSeconds,
    introSeconds: lesson.introSeconds,
    shadowingTempo: lesson.shadowingTempo,
    finalVideo: relativeFactoryPath(outputPath),
    ...(lesson.visualProvenance
      ? {topic: lesson.topic ?? null, sources: lesson.sources ?? []}
      : {}),
  };
  const previousManifest = await readJsonOptional(manifestPath);
  if (
    !cli.realAsset &&
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
    const wordTimingPath = path.join(tempRoot, `${stem}.words.json`);
    const isEssy = lesson.series === "ESSY";
    const cachedWordTimingSha = cached?.wordTimingSha256 ?? null;
    const cacheHit =
      !cli.noCache &&
      cached?.cacheKey === cacheKey &&
      (await exists(audioPath)) &&
      (await fileSize(audioPath)) > 0 &&
      // ESSY cache identity: audio must never silently pair with missing or
      // mismatched word timing (same-synthesis binding is part of the key).
      (!isEssy ||
        ((await exists(wordTimingPath)) &&
          cachedWordTimingSha === sha256(await readFile(wordTimingPath))));
    if (cacheHit) {
      log(`[TTS ${index + 1}/${lesson.sentences.length}] ${stem} (cached)`);
    } else {
      log(`[TTS ${index + 1}/${lesson.sentences.length}] ${stem}`);
      const textPath = path.join(tempRoot, `${stem}.txt`);
      const vttPath = path.join(tempRoot, `${stem}.vtt`);
      const temporaryAudio = path.join(tempRoot, `${stem}.mp3`);
      await writeFile(textPath, `${sentence.text}\n`, "utf8");
      if (isEssy) {
        // Canonical ESSY synthesis: ONE edge-tts session produces audio + VTT
        // + the canonical word-timing artifact (scripts/generate-essy-tts.py).
        try {
          await run(process.env.PYTHON ?? "python", [
            path.join(factoryRoot, "scripts", "generate-essy-tts.py"),
            "--text-file", textPath,
            "--audio-out", temporaryAudio,
            "--vtt-out", vttPath,
            "--words-out", wordTimingPath,
            "--sentence-id", stem,
            "--block-id", sentence.blockId ?? stem.replace(/^sentence-/, "n"),
            "--voice", sentenceTts.voice,
            `--rate=${sentenceTts.rate}`,
            `--pitch=${sentenceTts.pitch}`,
            `--volume=${sentenceTts.volume}`,
          ]);
        } catch (error) {
          throw new Error(
            `ESSY TTS + word timing failed for ${stem} (${JSON.stringify(sentence.text)}): ${error.message}`,
          );
        }
      } else {
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
      }
      await copyFile(temporaryAudio, audioPath);
      await writeJson(cachePath, {
        cacheKey,
        text: sentence.text,
        ...sentenceTts,
        ...(isEssy
          ? {
              wordTimingPath: relativeFactoryPath(wordTimingPath),
              wordTimingSha256: sha256(await readFile(wordTimingPath)),
              wordTiming: "required",
            }
          : {}),
      });
    }
    const durationSec = await probeDuration(audioPath);
    audioRecords.push({
      ...sentence,
      audioPath,
      durationSec,
      cached: cacheHit,
      resolvedTts: sentenceTts,
      vttPath: path.join(tempRoot, `${stem}.vtt`),
    });
  }

  if (lesson.series === "ESSY") {
    // Essay subtitles are rendered per sentence using the word-level VTT that
    // edge-tts already produces; a missing or unreadable VTT degrades that
    // block to a single whole-block cue.
    for (const record of audioRecords) {
      record.cues = await loadBlockCues(record);
    }
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
    if (lesson.series === "ESSY") {
      const blockCues =
        record.cues && record.cues.length > 0
          ? record.cues
          : [{startSec: 0, endSec: record.durationSec, text: record.text}];
      for (const cue of blockCues) {
        srtCues.push({
          startSec: timelineOffset + cue.startSec,
          endSec: timelineOffset + Math.min(cue.endSec, record.durationSec),
          text: cue.text,
        });
      }
      timelineOffset += record.durationSec + (record.pauseAfterSec ?? 0);
      continue;
    }
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
  let visualPlan = null;
  let visualPlanPath = null;
  let reviewPlannedDurationSec = null;
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
        subtitleText: record.text,
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
  } else if (lesson.series === "ESSY") {
    // Essay timeline: for the real-asset review cut the previously approved,
    // machine-readable assembly timeline defines the shots (one approved
    // sourcing slot -> one shot -> one use of its asset). Otherwise a
    // deterministic visual plan splits every narration block into visual shots
    // cut on TTS sentence boundaries. In both paths the block's trailing
    // pauseAfterSec extends only its final shot and subtitles stop with the
    // spoken narration.
    if (cli.realAsset) {
      const audioPathById = new Map(
        audioRecords.map((record) => [record.id, record.audioPath]),
      );
      const timelinePath = path.join(projectRoot, "assembly-timeline.json");
      let timeline = await loadRealAssetTimeline(timelinePath);
      if (cli.blocks) {
        timeline = filterTimeline(timeline, cli.blocks);
      }
      const requested = cli.blocks
        ? timeline.shots.filter((shot) => cli.blocks.includes(shot.blockId))
        : timeline.shots;
      log(
        `[PLAN] real-asset timeline: ${timeline.blocks.length} blocks / ` +
          `${timeline.shots.length} shots (rendering ${requested.length})`,
      );
      for (const entry of await readdir(segmentRoot)) {
        if (/essay.*\.(mp4|txt)$/i.test(entry)) {
          await rm(path.join(segmentRoot, entry), {force: true});
        }
      }
      let shotNumber = 0;
      for (const block of timeline.blocks) {
        if (!audioPathById.has(block.sentenceId)) {
          throw new Error(
            `No cached narration audio for ${block.sentenceId}.`,
          );
        }
        const absCues = block.cues ?? [];
        for (const shot of block.shots) {
          const clipPath = path.join(
            segmentRoot,
            `${shot.blockId}-essay-${shot.slotId}.mp4`,
          );
          if (!(await exists(shot.sourcePath))) {
            throw new Error(`Missing source asset: ${shot.sourcePath}`);
          }
          if (shot.mediaType === "video") {
            const probed = await probeDuration(shot.sourcePath);
            if (shot.renderDurationSec > probed + 1e-6) {
              throw new Error(
                `INSUFFICIENT_SOURCE ${shot.slotId}: needs ` +
                  `${shot.renderDurationSec.toFixed(3)}s but source is ` +
                  `${probed.toFixed(3)}s.`,
              );
            }
          }
          const cueList = sliceCues(absCues, shot.startSec, shot.endSec);
          log(
            `[REAL-ASSET SHOT ${++shotNumber}/${requested.length}] ` +
              `${shot.slotId} <- ${shot.blockId} (${shot.mediaType}, ` +
              `${shot.renderDurationSec.toFixed(3)}s)`,
          );
          await renderRealAssetClip({
            sourcePath: shot.sourcePath,
            isVideo: shot.mediaType === "video",
            outputPath: clipPath,
            durationSec: shot.renderDurationSec,
            cueList,
            stillMotion: shot.mediaType === "photo"
              ? resolveStillMotion(shot)
              : null,
            lesson,
          });
          clips.push(clipPath);
        }
      }
      visualPlan = {
        planning: {
          strategy: "real-asset-sourced",
          targetShots: timeline.shots.length,
        },
        shots: timeline.shots.map((shot) => ({
          id: shot.slotId,
          sentenceId: shot.blockId,
          sectionId: shot.blockId.slice(-3),
          image: null,
          cues: [],
        })),
      };
      visualPlanPath = null;
      reviewPlannedDurationSec = timeline.plannedDurationSec;
    } else {
    const targetShots = cli.visualShots ?? DEFAULT_ESSAY_VISUAL_SHOTS;
    const audioPathById = new Map(
      audioRecords.map((record) => [record.id, record.audioPath]),
    );
    const planArtifact = {
      ...planVisualShots({
        targetShots,
        blocks: audioRecords.map((record) => ({
          sentenceId: record.id,
          sectionId: record.sectionId ?? "",
          image: record.image,
          durationSec: record.durationSec,
          pauseAfterSec: record.pauseAfterSec ?? 0,
          cues: record.cues ?? null,
        })),
      }),
      episode,
      series: lesson.series,
      createdAt: startedAt,
      sourceLessonSha256: lessonHash,
    };
    if (planArtifact.shots.length !== targetShots) {
      throw new Error(
        `Visual plan produced ${planArtifact.shots.length} shots instead of ` +
          `${targetShots}. Reduce --visual-shots or extend the narration.`,
      );
    }
    validateVisualPlan(planArtifact);
    visualPlan = planArtifact;
    visualPlanPath = path.join(projectRoot, "visual-plan.json");
    await writeJson(visualPlanPath, planArtifact);
    log(
      `[PLAN] ${visualPlan.shots.length} visual shots across ` +
        `${audioRecords.length} narration blocks`,
    );
    // Drop stale essay intermediates so concat never sees leftovers.
    for (const entry of await readdir(segmentRoot)) {
      if (/essay.*\.(mp4|txt)$/i.test(entry)) {
        await rm(path.join(segmentRoot, entry), {force: true});
      }
    }
    for (const [index, shot] of visualPlan.shots.entries()) {
      const stagedImage = path.join(sourceRoot, path.basename(shot.image));
      const clipPath = path.join(
        segmentRoot,
        `${shot.sentenceId}-essay-${shot.id}.mp4`,
      );
      log(
        `[ESSY SHOT ${index + 1}/${visualPlan.shots.length}] ${shot.id} <- ${shot.sentenceId}`,
      );
      await renderNarrationClip({
        imagePath: stagedImage,
        audioPath: audioPathById.get(shot.sentenceId),
        outputPath: clipPath,
        durationSec: shot.endSec - shot.startSec,
        audioStartSec: shot.startSec,
        subtitleText: null,
        stillMotion: resolveStillMotion(shot),
        cueList: shot.cues ?? null,
        lesson,
      });
      clips.push(clipPath);
    }
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
  if (cli.realAsset) {
    const narrationMasterPath = path.join(tempRoot, `${episode}-narration-master.m4a`);
    await renderEssayNarrationMaster({
      audioRecords,
      durationSec: reviewPlannedDurationSec,
      outputPath: narrationMasterPath,
      sampleRate: lesson.tts.sampleRate,
    });
    log("[FINAL] Muxing continuous narration master (no BGM)");
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", concatenatedPath, "-i", narrationMasterPath,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy", "-c:a", "copy", "-shortest",
      "-movflags", "+faststart", temporaryOutput,
    ]);
  } else if (
    lesson.backgroundMusic.enabled &&
    lesson.backgroundMusic.path &&
    !cli.realAsset
  ) {
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
  const estimatedDuration = cli.realAsset && reviewPlannedDurationSec
    ? reviewPlannedDurationSec
    : expectedDuration(
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
      ...(record.blockId ? {blockId: record.blockId} : {}),
      path: relativeFactoryPath(record.audioPath),
      durationSec: round(record.durationSec),
      textSha256: sha256(record.text),
      speaker: record.speaker,
      tts: record.resolvedTts,
    })),
    subtitles: relativeFactoryPath(srtPath),
    ...(visualPlan
      ? {
          ...(visualPlanPath
            ? {visualPlan: relativeFactoryPath(visualPlanPath)}
            : {}),
          visualShotCount: visualPlan.shots.length,
          visualPlanStrategy: visualPlan.planning.strategy,
        }
      : {}),
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
  if (!cli.realAsset) {
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
      visualShotCount: visualPlan ? visualPlan.shots.length : null,
    });
  }
  await writeFile(path.join(logRoot, "render.log"), `${logLines.join("\n")}\n`, "utf8");
  console.log(`Render succeeded: ${relativeFactoryPath(outputPath)}`);
  console.log(
    `Validated ${probe.durationSec.toFixed(3)}s, ${lesson.video.width}x${lesson.video.height}, ${lesson.video.fps} fps.`,
  );
}

async function renderStorybookSilent({
  episode,
  lessonPath,
  rawLesson,
  lesson,
  projectRoot,
  sourceRoot,
  segmentRoot,
  tempRoot,
  logRoot,
  outputPath,
  imageSources,
  logLines,
  log,
}) {
  await Promise.all([
    assertExecutable("ffmpeg", ["-version"]),
    assertExecutable("ffprobe", ["-version"]),
  ]);

  const pageDuration = Number(rawLesson.storybook?.pageDurationSeconds ?? 7);
  const endingDuration = Number(rawLesson.storybook?.endingDurationSeconds ?? 10);
  const fadeDuration = Number(rawLesson.storybook?.transitionSeconds ?? 0.6);
  const pageTexts = lesson.scenes.map((scene) =>
    scene.sentences.map((sentence) => sentence.text).join("\n"),
  );
  const endingTitle = String(rawLesson.storybookEnding?.title ?? "The Moral Is...");
  const endingBody = String(rawLesson.storybookEnding?.body ?? "");
  if (!endingBody.trim()) {
    throw new Error("storybook-silent requires storybookEnding.body.");
  }

  await copyFile(lessonPath, path.join(sourceRoot, "lesson.json"));
  for (const imagePath of imageSources) {
    await copyFile(imagePath, path.join(sourceRoot, path.basename(imagePath)));
  }

  const fontPath = "C\\:/Windows/Fonts/georgia.ttf";
  const clips = [];
  for (const [index, imagePath] of imageSources.entries()) {
    const textPath = path.join(tempRoot, `page-${String(index + 1).padStart(2, "0")}.txt`);
    const clipPath = path.join(segmentRoot, `page-${String(index + 1).padStart(2, "0")}.mp4`);
    await writeFile(textPath, `${pageTexts[index]}\n`, "utf8");
    const textFile = ffmpegFilterPath(textPath);
    const fadeOutStart = Math.max(0, pageDuration - fadeDuration);
    const filter =
      `scale=${lesson.video.width}:${lesson.video.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
      `pad=${lesson.video.width}:${lesson.video.height}:(ow-iw)/2:(oh-ih)/2:color=#f4ead2,` +
      `drawtext=fontfile='${fontPath}':textfile='${textFile}':fontcolor=#3b2f2a:` +
      `fontsize=44:line_spacing=12:x=(w-text_w)/2:y=h-165-text_h/2,` +
      `fade=t=in:st=0:d=${fadeDuration}:color=#f4ead2,` +
      `fade=t=out:st=${fadeOutStart}:d=${fadeDuration}:color=#f4ead2,format=yuv420p`;
    log(`[STORYBOOK] Rendering page ${index + 1}`);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-loop",
      "1",
      "-i",
      imagePath,
      "-t",
      String(pageDuration),
      "-vf",
      filter,
      "-r",
      String(lesson.video.fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      clipPath,
    ]);
    clips.push(clipPath);
  }

  const endingTitlePath = path.join(tempRoot, "ending-title.txt");
  const endingBodyPath = path.join(tempRoot, "ending-body.txt");
  const endingClip = path.join(segmentRoot, "ending.mp4");
  await writeFile(endingTitlePath, `${endingTitle}\n`, "utf8");
  await writeFile(endingBodyPath, `${endingBody}\n`, "utf8");
  const endingFadeOut = Math.max(0, endingDuration - fadeDuration);
  const endingFilter =
    `drawtext=fontfile='${fontPath}':textfile='${ffmpegFilterPath(endingTitlePath)}':` +
    `fontcolor=#3b2f2a:fontsize=70:x=(w-text_w)/2:y=260,` +
    `drawtext=fontfile='${fontPath}':textfile='${ffmpegFilterPath(endingBodyPath)}':` +
    `fontcolor=#3b2f2a:fontsize=42:line_spacing=24:x=(w-text_w)/2:y=470,` +
    `fade=t=in:st=0:d=${fadeDuration}:color=#f4ead2,` +
    `fade=t=out:st=${endingFadeOut}:d=${fadeDuration}:color=#f4ead2,format=yuv420p`;
  log("[STORYBOOK] Rendering moral page");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=#f4ead2:s=${lesson.video.width}x${lesson.video.height}:r=${lesson.video.fps}:d=${endingDuration}`,
    "-vf",
    endingFilter,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    endingClip,
  ]);
  clips.push(endingClip);

  const concatPath = path.join(tempRoot, "storybook-concat.txt");
  await writeFile(
    concatPath,
    `${clips.map((clip) => `file '${clip.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n")}\n`,
    "utf8",
  );
  const videoOnlyPath = path.join(tempRoot, "storybook-video.mp4");
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
    videoOnlyPath,
  ]);

  const totalDuration = pageDuration * clips.length - pageDuration + endingDuration;
  log("[FINAL] Adding calm background music only");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoOnlyPath,
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=0.018*sin(2*PI*220*t)+0.012*sin(2*PI*277.18*t)+0.010*sin(2*PI*329.63*t):s=48000:d=${totalDuration}`,
    "-filter:a",
    "afade=t=in:st=0:d=3,afade=t=out:st=" +
      Math.max(0, totalDuration - 4) +
      ":d=4,lowpass=f=1200",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-shortest",
    outputPath,
  ]);

  const probe = await probeMedia(outputPath);
  if (!probe.hasVideo || !probe.hasAudio || probe.durationSec < totalDuration - 1) {
    throw new Error("Storybook output validation failed.");
  }
  const completedAt = new Date().toISOString();
  manifestBase = {
    schemaVersion: "1.0",
    episode,
    title: lesson.title,
    renderMode: lesson.renderMode,
    startedAt,
    completedAt,
    status: "success",
    sourceLesson: relativeFactoryPath(lessonPath),
    lessonSha256: sha256(await readFile(lessonPath)),
    images: await Promise.all(
      imageSources.map(async (imagePath) => ({
        source: relativeFactoryPath(imagePath),
        file: path.basename(imagePath),
        sha256: sha256(await readFile(imagePath)),
      })),
    ),
    sentenceCount: lesson.sentences.length,
    finalVideo: relativeFactoryPath(outputPath),
    validation: {
      passed: true,
      fileSize: probe.size,
      durationSec: round(probe.durationSec),
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      narration: false,
      soundEffects: false,
      backgroundMusicOnly: true,
    },
  };
  await writeJson(path.join(projectRoot, "manifest.json"), manifestBase);
  registerAttempt(activeWorkflow, "rendering", "success");
  activeWorkflow.needsRerender = false;
  activeWorkflow.rerenderReason = null;
  recordEvent(activeWorkflow, "render-succeeded", {
    durationSec: round(probe.durationSec),
    output: relativeFactoryPath(outputPath),
  });
  activeWorkflow = await refreshEpisodeWorkflow(factoryRoot, activeWorkflow);
  await writeFile(path.join(logRoot, "render.log"), `${logLines.join("\n")}\n`, "utf8");
  console.log(`Render succeeded: ${relativeFactoryPath(outputPath)}`);
  console.log(
    `Validated ${probe.durationSec.toFixed(3)}s, ${lesson.video.width}x${lesson.video.height}, ${lesson.video.fps} fps.`,
  );
}

function ffmpegFilterPath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1\\:");
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
  visualShotCount = null,
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
    ...(visualShotCount ? {visualShotCount} : {}),
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
    (flag) =>
      ![
        "--force",
        "--clean",
        "--no-cache",
        "--visual-shots",
        "--real-asset",
        "--blocks",
        "--out",
      ].includes(flag),
  );
  if (unknown.length) {
    throw new Error(`Unknown option: ${unknown.join(", ")}`);
  }
  let visualShots = null;
  const shotsFlagIndex = args.indexOf("--visual-shots");
  if (shotsFlagIndex !== -1) {
    const raw = args[shotsFlagIndex + 1];
    visualShots = Number(raw);
    if (!Number.isInteger(visualShots) || visualShots < 1) {
      throw new Error(
        `--visual-shots requires a positive integer, received "${raw ?? ""}".`,
      );
    }
  }
  let blocks = null;
  const blocksFlagIndex = args.indexOf("--blocks");
  if (blocksFlagIndex !== -1) {
    const raw = args[blocksFlagIndex + 1];
    const match = /^N(\d{3})-N(\d{3})$/.exec(raw ?? "");
    if (!match) {
      throw new Error(
        `--blocks requires a range like N001-N003, received "${raw ?? ""}".`,
      );
    }
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from < 1 || to < from || to > 999) {
      throw new Error(`Invalid --blocks range: "${raw}".`);
    }
    blocks = [];
    for (let number = from; number <= to; number += 1) {
      blocks.push(`sentence-${String(number).padStart(3, "0")}`);
    }
  }
  let outName = null;
  const outFlagIndex = args.indexOf("--out");
  if (outFlagIndex !== -1) {
    outName = args[outFlagIndex + 1];
    if (!outName || !outName.endsWith(".mp4") || outName.includes("/") || outName.includes("\\")) {
      throw new Error(
        `--out requires a plain .mp4 filename, received "${outName ?? ""}".`,
      );
    }
  }
  return {
    input: args.find((argument) => !argument.startsWith("--")),
    force: flags.has("--force"),
    clean: flags.has("--clean"),
    noCache: flags.has("--no-cache"),
    visualShots,
    realAsset: flags.has("--real-asset"),
    blocks,
    outName,
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
  audioStartSec = 0,
  subtitleText,
  motionIndex,
  stillMotion = null,
  audioTempo = 1,
  onScreenText = [],
  llfcLayout = false,
  cueList = null,
  lesson,
}) {
  const {width, height, fps} = lesson.video;
  const frameCount = Math.ceil(durationSec * fps);
  const maxSubtitleChars = lesson.subtitles?.maxCharsPerLine ?? 46;
  const subtitleLines = subtitleText
    ? wrapText(subtitleText, maxSubtitleChars).split("\n")
    : [];
  if (lesson.series === "ESSD" && subtitleLines.length > 2) {
    throw new Error(
      `ESSD shadowing subtitle exceeds two lines: "${subtitleText}". Split it into shorter approved segments before rendering.`,
    );
  }
  let subtitleTextFilter = null;
  if (Array.isArray(cueList) && cueList.length > 0) {
    // Essay mode: one timed drawtext+drawbox pair per sentence cue.
    subtitleTextFilter = await buildTimedSubtitleFilters({
      outputPath,
      cueList,
      height,
      maxChars: maxSubtitleChars,
    });
  } else if (subtitleText) {
    const subtitleLineGap = 74;
    const subtitleFirstY =
      height -
      (subtitleLines.length === 1
        ? 178
        : 210 + Math.max(0, subtitleLines.length - 2) * subtitleLineGap);
    const subtitleTextPath = `${outputPath}.subtitle.txt`;
    await writeFile(subtitleTextPath, subtitleLines.join("\n"), "utf8");
    const filterTextPath = subtitleTextPath.replaceAll("\\", "/");
    subtitleTextFilter =
      `drawtext=fontfile=${escapeFilter(fontPath())}:` +
      `textfile=${escapeFilter(filterTextPath)}:` +
      `fontcolor=white:fontsize=60:line_spacing=14:` +
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
      : lesson.series === "ESSY"
        ? stillImageFilter({width, height, fps, frameCount, stillMotion})
        : kenBurnsFilter({width, height, fps, frameCount, motionIndex}),
    ...llfcTextFilters,
    subtitleText && !Array.isArray(cueList)
      ? `drawbox=x=70:y=ih-270:w=iw-140:h=200:color=black@0.68:t=fill`
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
    ...(audioStartSec > 0
      ? ["-ss", audioStartSec.toFixed(6), "-t", durationSec.toFixed(6)]
      : []),
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
/**
 * Load and validate a real-asset assembly timeline artifact from disk.
 * @param {string} timelinePath
 * @returns {Promise<object>} validated timeline
 */
async function loadRealAssetTimeline(timelinePath) {
  if (!(await exists(timelinePath))) {
    throw new Error(
      `Missing assembly timeline: ${timelinePath}. ` +
        `Run scripts/build-assembly-timeline.mjs first.`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(await readFile(timelinePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid assembly timeline JSON: ${error.message}`);
  }
  return validateAssemblyTimeline(raw);
}

/**
 * Render one real-asset shot: the visual layer comes from a sourced video
 * (scale/crop to output, no looping, no overlap) or a sourced photo (restrained
 * Ken Burns motion), while subtitles are burned into a silent visual layer.
 * The cached TTS streams are muxed as one narration master only after visual
 * clips have been tiled, so visual boundaries never slice narration audio.
 */
async function renderRealAssetClip({
  sourcePath,
  isVideo,
  outputPath,
  durationSec,
  cueList,
  stillMotion,
  lesson,
}) {
  const {width, height, fps} = lesson.video;
  const maxChars = lesson.subtitles?.maxCharsPerLine ?? 46;
  const subtitleFilters = await buildTimedSubtitleFilters({
    outputPath,
    cueList: cueList ?? [],
    height,
    maxChars,
  });

  if (!isVideo) {
    return renderRealAssetPhotoClip({
      sourcePath, outputPath, durationSec, subtitleFilters, stillMotion, lesson,
    });
  }

  // Video: play from source t=0, no -stream_loop, no -ss on the video input.
  const videoFilters = [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${width}:${height}`,
    `fps=${fps}`,
    subtitleFilters,
    "format=yuv420p",
  ].filter(Boolean).join(",");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourcePath,
    "-t",
    durationSec.toFixed(6),
    "-vf",
    videoFilters,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-an",
    outputPath,
  ]);
}

async function renderRealAssetPhotoClip({
  sourcePath, outputPath, durationSec, subtitleFilters, stillMotion, lesson,
}) {
  const {width, height, fps} = lesson.video;
  const frameCount = Math.ceil(durationSec * fps);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1", "-framerate", String(fps), "-i", sourcePath,
    "-t", durationSec.toFixed(6),
    "-vf", [
      stillImageFilter({width, height, fps, frameCount, stillMotion}),
      subtitleFilters,
      "format=yuv420p",
    ].filter(Boolean).join(","),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-an", outputPath,
  ]);
}

async function renderEssayNarrationMaster({
  audioRecords, durationSec, outputPath, sampleRate,
}) {
  const inputs = [];
  const filters = [];
  const labels = [];
  for (const [index, record] of audioRecords.entries()) {
    inputs.push("-i", record.audioPath);
    filters.push(
      `[${index}:a]atrim=duration=${record.durationSec.toFixed(6)},asetpts=PTS-STARTPTS[a${index}]`,
      `anullsrc=r=${sampleRate}:cl=stereo,atrim=duration=${(record.pauseAfterSec ?? 0).toFixed(6)},asetpts=PTS-STARTPTS[p${index}]`,
    );
    labels.push(`[a${index}][p${index}]`);
  }
  filters.push(`${labels.join("")}concat=n=${audioRecords.length * 2}:v=0:a=1[narration]`);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", ...inputs,
    "-filter_complex", filters.join(";"), "-map", "[narration]",
    "-t", durationSec.toFixed(6),
    "-c:a", "aac", "-b:a", "192k", "-ar", String(sampleRate), "-ac", "2",
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
  const seriesLabelPath = `${outputPath}.series-label.txt`;
  const titlePath = `${outputPath}.title.txt`;
  await writeFile(seriesLabelPath, `${series} · ${subtypeLabel}`, "utf8");
  await writeFile(titlePath, title, "utf8");
  const filter = [
    staticImageFilter({width, height, fps}),
    "gblur=sigma=12",
    "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.42:t=fill",
    `drawtext=fontfile=${escapeFilter(fontPath())}:textfile=${escapeFilter(
      seriesLabelPath.replaceAll("\\", "/"),
    )}:expansion=none:fontcolor=white@0.82:fontsize=38:x=(w-text_w)/2:y=h/2-115`,
    `drawtext=fontfile=${escapeFilter(fontPath())}:textfile=${escapeFilter(
      titlePath.replaceAll("\\", "/"),
    )}:expansion=none:fontcolor=white:fontsize=76:x=(w-text_w)/2:y=(h-text_h)/2`,
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
  const textFilters = [];
  for (const [index, line] of lines.entries()) {
    const linePath = `${outputPath}.line-${index + 1}.txt`;
    await writeFile(linePath, line, "utf8");
    textFilters.push(
      `drawtext=fontfile=${escapeFilter(fontPath())}:textfile=${escapeFilter(
        linePath.replaceAll("\\", "/"),
      )}:expansion=none:fontcolor=white:fontsize=72:x=(w-text_w)/2:y=${Math.round(
        firstY + index * lineGap,
      )}`,
    );
  }
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

async function buildTimedSubtitleFilters({
  outputPath,
  cueList,
  height,
  maxChars,
}) {
  const filters = [];
  const lineGap = 74;
  for (const [index, cue] of cueList.entries()) {
    const lines = wrapText(cue.text, maxChars).split("\n");
    const extraLines = Math.max(0, lines.length - 2);
    // Same bottom strip as the single-subtitle path; grows upward when a cue
    // wraps past two lines.
    const boxTop = height - 270 - extraLines * lineGap;
    const boxHeight = 200 + extraLines * lineGap;
    const firstY =
      height - (lines.length === 1 ? 178 : 210 + extraLines * lineGap);
    const enable = `enable='between(t,${cue.startSec.toFixed(3)},${cue.endSec.toFixed(3)})'`;
    const cueTextPath = `${outputPath}.cue-${String(index + 1).padStart(2, "0")}.txt`;
    await writeFile(cueTextPath, lines.join("\n"), "utf8");
    const filterTextPath = cueTextPath.replaceAll("\\", "/");
    filters.push(
      `drawbox=x=70:y=${boxTop}:w=iw-140:h=${boxHeight}:color=black@0.68:t=fill:${enable}`,
      `drawtext=fontfile=${escapeFilter(fontPath())}:` +
        `textfile=${escapeFilter(filterTextPath)}:` +
        `fontcolor=white:fontsize=60:line_spacing=14:` +
        `x=(w-text_w)/2:y=${firstY}:${enable}`,
    );
  }
  return filters.join(",");
}

async function loadBlockCues(record) {
  try {
    const vtt = await readFile(record.vttPath, "utf8");
    const words = parseVttWordCues(vtt);
    if (words.length === 0) return null;
    const cues = groupWordCuesIntoSentences(words).map((cue) => ({
      ...cue,
      endSec: Math.min(cue.endSec, record.durationSec),
    }));
    const usable =
      cues.length > 0 && cues.some((cue) => cue.endSec > cue.startSec);
    return usable ? cues : null;
  } catch {
    return null;
  }
}

function parseVttWordCues(vtt) {
  const normalized = String(vtt).replaceAll("\r\n", "\n");
  const words = [];
  // edge-tts writes .vtt files whose timestamps may use either WebVTT ".mmm"
  // or SRT ",mmm" millisecond separators depending on version.
  const pattern =
    /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*\n([^\n]+)/g;
  for (const match of normalized.matchAll(pattern)) {
    const text = match[9].trim();
    if (!text) continue;
    words.push({
      startSec: vttTimestampToSeconds(match.slice(1, 5)),
      endSec: vttTimestampToSeconds(match.slice(5, 9)),
      text,
    });
  }
  return words;
}

function vttTimestampToSeconds(parts) {
  const [hours, minutes, seconds, milliseconds] = parts.map(Number);
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function groupWordCuesIntoSentences(words) {
  const cues = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) cues.push(current);
    current = null;
  };
  for (const [index, word] of words.entries()) {
    if (!current) {
      current = {startSec: word.startSec, endSec: word.endSec, text: ""};
    }
    current.endSec = word.endSec;
    current.text = current.text ? `${current.text} ${word.text}` : word.text;
    const previous = words[index - 1];
    const gap = previous ? word.startSec - previous.endSec : 0;
    const terminal = /[.!?…]["')\]]?$/.test(word.text);
    if (terminal || current.text.length >= 180 || gap > 1.5) flush();
  }
  flush();
  return cues;
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
