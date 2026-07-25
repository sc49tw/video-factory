import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {createReadStream} from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {loadLlfcProject} from "./lib/llfc-template.mjs";

const FACTORY_ROOT = process.cwd();
const args = process.argv.slice(2);
const force = args.includes("--force");
const projectArgument = args.find((argument) => !argument.startsWith("--"));

if (!projectArgument) {
  fail(
    "Usage: pnpm vf:llfc:render -- projects/llfc/<project-folder> [--force]",
  );
}

const projectsRoot = path.resolve(FACTORY_ROOT, "projects");
const projectRoot = path.resolve(FACTORY_ROOT, projectArgument);
if (
  projectRoot !== projectsRoot &&
  !projectRoot.startsWith(`${projectsRoot}${path.sep}`)
) {
  fail(`Project path must stay inside ${projectsRoot}`);
}

const projectPath = path.join(projectRoot, "project.json");
const manifestPath = path.join(projectRoot, "manifest.json");
const statusPath = path.join(projectRoot, "status.json");
const timelinePath = path.join(projectRoot, "render", "timeline.json");
const subtitlesPath = path.join(
  projectRoot,
  "generated",
  "subtitles",
  "subtitles.ass",
);
const intermediateRoot = path.join(
  projectRoot,
  "generated",
  "intermediate",
  "llfc-render",
);
const clipRoot = path.join(intermediateRoot, "video-clips");
const audioRoot = path.join(intermediateRoot, "scene-audio");
const projectOutputRoot = path.join(projectRoot, "output");
const projectOutputPath = path.join(projectOutputRoot, "final.mp4");
const renderReportPath = path.join(projectRoot, "render", "render-report.json");

await assertExecutable("ffmpeg", ["-version"]);
await assertExecutable("ffprobe", ["-version"]);

const project = await loadLlfcProject(FACTORY_ROOT, projectPath);
const manifest = await readJson(manifestPath);
const timeline = await readJson(timelinePath);

if (project.pipeline !== "llfc") {
  fail(`Expected pipeline "llfc", found "${project.pipeline}".`);
}
if (!Array.isArray(timeline.scenes) || timeline.scenes.length < 1) {
  fail("render/timeline.json does not contain scenes.");
}
if (!(await exists(subtitlesPath))) {
  fail("ASS subtitles are missing. Run vf:llfc:tts first.");
}
if (!force && (await exists(projectOutputPath))) {
  fail(`Output already exists: ${projectOutputPath}. Use --force to replace it.`);
}

const outputDefinition =
  project.render?.outputs?.find((output) => output.id === "master-landscape") ??
  project.render?.outputs?.find((output) => output.container === "mp4");
const factoryOutputPath = outputDefinition?.targetPath
  ? path.resolve(FACTORY_ROOT, outputDefinition.targetPath)
  : path.resolve(
      FACTORY_ROOT,
      "output",
      "llfc",
      project.project.id,
      "final.mp4",
    );
if (!factoryOutputPath.startsWith(`${path.resolve(FACTORY_ROOT, "output")}${path.sep}`)) {
  fail("Configured output path must stay inside the factory output directory.");
}

const width = Number(project.format?.resolution?.width ?? 1920);
const height = Number(project.format?.resolution?.height ?? 1080);
const fps = Number(timeline.fps ?? project.format?.fps ?? 30);
const sampleRate = Number(project.audio?.tts?.sampleRate ?? 48000);
const visualWidth = Math.min(width - 120, 1800);
const visualHeight = Math.min(height - 320, 760);
const visualTop = 20;

await Promise.all([
  mkdir(clipRoot, {recursive: true}),
  mkdir(audioRoot, {recursive: true}),
  mkdir(projectOutputRoot, {recursive: true}),
  mkdir(path.dirname(factoryOutputPath), {recursive: true}),
]);

const imageAssetById = new Map(
  (manifest.assets ?? [])
    .filter((asset) => asset.type === "image")
    .map((asset) => [asset.assetId, asset]),
);

const videoClips = [];
const sceneAudioFiles = [];
for (let index = 0; index < timeline.scenes.length; index += 1) {
  const scene = timeline.scenes[index];
  const label = `[${index + 1}/${timeline.scenes.length}] ${scene.sceneId}`;
  console.log(`${label}: composing`);

  const imageAsset = imageAssetById.get(scene.assetId);
  let imagePath = imageAsset?.path
    ? path.join(projectRoot, imageAsset.path.replaceAll("/", path.sep))
    : path.join(
        projectRoot,
        "assets",
        "images",
        "approved",
        `${scene.assetId}.png`,
      );
  if (!(await exists(imagePath))) {
    const sharedAssetPath =
      project.llfcTemplate?.sharedAssets?.[scene.assetId];
    if (sharedAssetPath) {
      const candidate = path.resolve(FACTORY_ROOT, sharedAssetPath);
      const templateRoot = path.resolve(FACTORY_ROOT, "templates", "llfc");
      if (
        candidate === templateRoot ||
        candidate.startsWith(`${templateRoot}${path.sep}`)
      ) {
        imagePath = candidate;
      }
    }
  }
  if (!(await exists(imagePath))) {
    fail(`Image is missing for scene ${scene.sceneId}: ${imagePath}`);
  }

  const frameDurationSec = Number(scene.durationFrames) / fps;
  const clipPath = path.join(
    clipRoot,
    `${String(index).padStart(2, "0")}-${scene.sceneId}.mp4`,
  );
  const isBookend =
    project.llfcTemplate?.bookendEffects?.enabled !== false &&
    (scene.kind === "common-opening" || scene.kind === "common-ending");
  const stillFilter =
    `scale=${visualWidth}:${visualHeight}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    (isBookend
      ? `pad=${width + 8}:${height + 8}:(ow-iw)/2:${visualTop + 4}:color=0x11100D,` +
        `crop=${width}:${height}:x='4+1.25*sin(2*PI*t*0.83)+0.55*sin(2*PI*t*2.17)':y='4+1.0*sin(2*PI*t*0.61)+0.45*sin(2*PI*t*1.73)',` +
        `eq=brightness='0.006*sin(2*PI*t*6.7)+0.003*sin(2*PI*t*2.1)':contrast='1+0.004*sin(2*PI*t*3.3)':eval=frame,`
      : `pad=${width}:${height}:(ow-iw)/2:${visualTop}:color=0x11100D,`) +
    `setsar=1,fps=${fps},format=yuv420p`;

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
    "-t",
    frameDurationSec.toFixed(6),
    "-vf",
    stillFilter,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-movflags",
    "+faststart",
    clipPath,
  ]);
  videoClips.push(clipPath);

  const sceneAudioPath = path.join(
    audioRoot,
    `${String(index).padStart(2, "0")}-${scene.sceneId}.wav`,
  );
  if (scene.audioPath) {
    const narrationPath = path.join(
      projectRoot,
      scene.audioPath.replaceAll("/", path.sep),
    );
    if (!(await exists(narrationPath))) {
      fail(`Narration is missing for scene ${scene.sceneId}: ${narrationPath}`);
    }
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      narrationPath,
      "-af",
      `apad=whole_dur=${frameDurationSec.toFixed(6)},atrim=duration=${frameDurationSec.toFixed(6)},asetpts=N/SR/TB`,
      "-ar",
      String(sampleRate),
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      sceneAudioPath,
    ]);
  } else {
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${sampleRate}:cl=stereo`,
      "-t",
      frameDurationSec.toFixed(6),
      "-c:a",
      "pcm_s16le",
      sceneAudioPath,
    ]);
  }
  sceneAudioFiles.push(sceneAudioPath);
}

const videoConcatPath = path.join(intermediateRoot, "video-concat.txt");
const audioConcatPath = path.join(intermediateRoot, "audio-concat.txt");
const silentVideoPath = path.join(intermediateRoot, "silent-video.mp4");
const narrationPath = path.join(intermediateRoot, "narration.wav");
const mixedAudioPath = path.join(intermediateRoot, "mixed-audio.wav");

await writeFile(videoConcatPath, concatFile(videoClips), "utf8");
await writeFile(audioConcatPath, concatFile(sceneAudioFiles), "utf8");

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
  videoConcatPath,
  "-c",
  "copy",
  silentVideoPath,
]);
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
  audioConcatPath,
  "-ar",
  String(sampleRate),
  "-ac",
  "2",
  "-c:a",
  "pcm_s16le",
  narrationPath,
]);

const soundEffects = new Map(
  (project.audio?.soundEffects ?? []).map((sound) => [sound.soundId, sound]),
);
const projectorPath = resolveSoundPath(
  soundEffects.get("projector-running"),
  "projector-loop.wav",
);
const clickPath = resolveSoundPath(
  soundEffects.get("projector-click"),
  "projector-click.wav",
);
const transitionPath = resolveSoundPath(
  soundEffects.get("transition"),
  "transition.mp3",
);

const clickTimesSec = timeline.scenes
  .slice(1)
  .map((scene) => Number(scene.startSec));
clickTimesSec.push(Math.max(0, Number(timeline.durationSec) - 0.8));
const transitionScene = timeline.scenes.find(
  (scene) => scene.sceneId === "lesson-01",
);
const transitionTimeSec = Number(transitionScene?.startSec ?? 0);
const mixFilter = createMixFilter({
  clickTimesSec,
  transitionTimeSec,
  durationSec: Number(timeline.durationSec),
});

await run("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-i",
  narrationPath,
  "-stream_loop",
  "-1",
  "-i",
  projectorPath,
  "-i",
  clickPath,
  "-i",
  transitionPath,
  "-filter_complex",
  mixFilter,
  "-map",
  "[mix]",
  "-ar",
  String(sampleRate),
  "-ac",
  "2",
  "-c:a",
  "pcm_s16le",
  mixedAudioPath,
]);

const assFilterPath = path
  .relative(projectRoot, subtitlesPath)
  .split(path.sep)
  .join("/");
await run(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    silentVideoPath,
    "-i",
    mixedAudioPath,
    "-vf",
    `ass=filename='${assFilterPath}'`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    "-shortest",
    projectOutputPath,
  ],
  {cwd: projectRoot},
);
await copyFile(projectOutputPath, factoryOutputPath);

const outputProbe = JSON.parse(
  await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
      "-of",
      "json",
      projectOutputPath,
    ],
    {captureStdout: true},
  ),
);
const videoStream = outputProbe.streams.find(
  (stream) => stream.codec_type === "video",
);
const audioStream = outputProbe.streams.find(
  (stream) => stream.codec_type === "audio",
);
const renderReport = {
  schemaVersion: "1.0",
  projectId: project.project.id,
  renderedAt: new Date().toISOString(),
  engine: "ffmpeg",
  profile: "llfc-first-cut-1080p",
  output: {
    projectPath: relativeProjectPath(projectOutputPath),
    factoryPath: path.relative(FACTORY_ROOT, factoryOutputPath).split(path.sep).join("/"),
    durationSec: round(Number(outputProbe.format.duration)),
    bytes: Number(outputProbe.format.size),
    bitRate: Number(outputProbe.format.bit_rate),
    video: {
      codec: videoStream?.codec_name,
      width: videoStream?.width,
      height: videoStream?.height,
      frameRate: videoStream?.r_frame_rate,
    },
    audio: {
      codec: audioStream?.codec_name,
      sampleRate: Number(audioStream?.sample_rate),
      channels: audioStream?.channels,
    },
    checksum: `sha256:${await sha256(projectOutputPath)}`,
  },
  composition: {
    imageFit: "contain",
    imageArea: {width: visualWidth, height: visualHeight, top: visualTop},
    subtitleArea: {height: height - visualHeight - visualTop},
    wordHighlight: false,
    backgroundColor: "#11100D",
    transitions: "hard-cut",
    projectorBed: true,
    projectorClicks: clickTimesSec.length,
    existingTransitionAtLesson1: true,
    subtitlesBurnedIn: true,
  },
};
await writeJson(renderReportPath, renderReport);
await updateManifest({
  renderReport,
  projectOutputPath,
  factoryOutputPath,
});
await updateStatus(renderReport);

console.log(
  JSON.stringify(
    {
      projectId: project.project.id,
      output: factoryOutputPath,
      durationSec: renderReport.output.durationSec,
      resolution: `${videoStream?.width}x${videoStream?.height}`,
      stage: "rendered",
      nextStage: "review",
    },
    null,
    2,
  ),
);

function createMixFilter({
  clickTimesSec: clickTimes,
  transitionTimeSec: transitionTime,
  durationSec,
}) {
  const clickLabels = clickTimes.map((_, index) => `[click${index}]`).join("");
  const filters = [
    `[0:a]volume=1[voice]`,
    `[1:a]asplit=2[projectorBase][projectorOpening]`,
    `[projectorBase]volume=0.158489,atrim=0:${durationSec.toFixed(3)},asetpts=N/SR/TB[projector]`,
    `[projectorOpening]volume=0.251189,atrim=0:2.5,afade=t=out:st=2.1:d=0.4,asetpts=N/SR/TB[projectorOpeningBoost]`,
    `[2:a]asplit=${clickTimes.length}${clickLabels}`,
  ];
  const mixLabels = ["[voice]", "[projector]", "[projectorOpeningBoost]"];
  clickTimes.forEach((timeSec, index) => {
    const delayMs = Math.max(0, Math.round(timeSec * 1000));
    filters.push(
      `[click${index}]volume=0.5,adelay=${delayMs}:all=1[clickDelayed${index}]`,
    );
    mixLabels.push(`[clickDelayed${index}]`);
  });
  const transitionDelayMs = Math.max(0, Math.round(transitionTime * 1000));
  filters.push(
    `[3:a]volume=0.3,adelay=${transitionDelayMs}:all=1[transitionDelayed]`,
  );
  mixLabels.push("[transitionDelayed]");
  filters.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0,atrim=0:${durationSec.toFixed(3)},loudnorm=I=-14:TP=-1:LRA=11[mix]`,
  );
  return filters.join(";");
}

function resolveSoundPath(sound, fallbackName) {
  const candidate = sound?.assetPath
    ? path.join(projectRoot, sound.assetPath.replaceAll("/", path.sep))
    : path.join(projectRoot, "assets", "audio", "sfx", fallbackName);
  return candidate;
}

function concatFile(files) {
  return `${files
    .map((file) => `file '${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`)
    .join("\n")}\n`;
}

async function updateManifest({renderReport, projectOutputPath: localOutput, factoryOutputPath: globalOutput}) {
  const currentManifest = await readJson(manifestPath);
  const retainedAssets = (currentManifest.assets ?? []).filter(
    (asset) => asset.generator !== "llfc-render",
  );
  retainedAssets.push({
    assetId: "final-video",
    type: "video",
    role: "master-landscape",
    path: relativeProjectPath(localOutput),
    factoryPath: path.relative(FACTORY_ROOT, globalOutput).split(path.sep).join("/"),
    source: "llfc-render",
    generator: "llfc-render",
    status: "generated",
    media: renderReport.output,
  });
  currentManifest.updatedAt = new Date().toISOString();
  currentManifest.assets = retainedAssets;
  await writeJsonAtomic(manifestPath, currentManifest);
}

async function updateStatus(renderReport) {
  const status = await readJson(statusPath);
  status.updatedAt = new Date().toISOString();
  status.stage = "rendered";
  status.nextStage = "review";
  status.progress ??= {};
  status.progress.renderReady = true;
  status.progress.rendered = true;
  status.progress.outputPath = renderReport.output.factoryPath;
  status.progress.renderDurationSec = renderReport.output.durationSec;
  await writeJsonAtomic(statusPath, status);
}

async function sha256(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function assertExecutable(command, commandArgs) {
  await run(command, commandArgs, {captureStdout: true});
}

async function run(command, commandArgs, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? FACTORY_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        if (!options.captureStdout && stderr.trim()) {
          console.error(stderr.trim());
        }
        resolve(stdout);
      } else {
        reject(
          new Error(
            `${command} exited with code ${code}\n${stderr || stdout}`.trim(),
          ),
        );
      }
    });
  });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await writeJson(temporaryPath, value);
  await rename(temporaryPath, filePath);
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

function relativeProjectPath(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
