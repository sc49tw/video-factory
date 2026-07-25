import {spawn} from "node:child_process";
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
    "Usage: pnpm vf:llfc:tts -- projects/llfc/<project-folder> [--force]",
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
const ttsRoot = path.join(projectRoot, "generated", "tts");
const subtitleRoot = path.join(projectRoot, "generated", "subtitles");
const sceneSubtitleRoot = path.join(subtitleRoot, "scenes");
const partsRoot = path.join(
  projectRoot,
  "generated",
  "intermediate",
  "tts-parts",
);
const renderRoot = path.join(projectRoot, "render");
const ttsManifestPath = path.join(ttsRoot, "tts-manifest.json");
const timelinePath = path.join(renderRoot, "timeline.json");

await assertExecutable("edge-tts", ["--version"]);
await assertExecutable("ffmpeg", ["-version"]);
await assertExecutable("ffprobe", ["-version"]);

const project = await loadLlfcProject(FACTORY_ROOT, projectPath);
if (project.pipeline !== "llfc") {
  fail(`Expected pipeline "llfc", found "${project.pipeline}".`);
}
if (!Array.isArray(project.content?.scenes) || project.content.scenes.length < 1) {
  fail("project.json does not contain content.scenes.");
}

const narratedScenes = project.content.scenes.filter(
  (scene) => typeof scene.narration === "string" && scene.narration.trim(),
);
if (narratedScenes.length < 1) {
  fail("No narrated scenes were found.");
}

if (!force && (await exists(ttsManifestPath))) {
  fail(
    `TTS output already exists at ${ttsManifestPath}. Use --force to regenerate it.`,
  );
}

await Promise.all([
  mkdir(ttsRoot, {recursive: true}),
  mkdir(sceneSubtitleRoot, {recursive: true}),
  mkdir(partsRoot, {recursive: true}),
  mkdir(renderRoot, {recursive: true}),
]);

const voice = project.audio?.tts?.voiceId ?? "en-GB-RyanNeural";
const rate = project.audio?.tts?.rate ?? "+0%";
const pitch = project.audio?.tts?.pitch ?? "+0Hz";
const sampleRate = Number(project.audio?.tts?.sampleRate ?? 48000);
const fps = Number(project.format?.fps ?? 30);
const subtitleMaxChars = Math.max(
  28,
  Number(project.subtitles?.display?.maxCharsPerLine ?? 42) * 2,
);

const generatedScenes = [];

for (let index = 0; index < narratedScenes.length; index += 1) {
  const scene = narratedScenes[index];
  const label = `[${index + 1}/${narratedScenes.length}] ${scene.sceneId}`;
  console.log(`${label}: generating`);

  const scenePartsRoot = path.join(partsRoot, scene.sceneId);
  await mkdir(scenePartsRoot, {recursive: true});
  const textParts = splitNarrationAtTimingCues(scene);
  const synthesizedParts = [];

  for (let partIndex = 0; partIndex < textParts.length; partIndex += 1) {
    const textPart = textParts[partIndex];
    const partName = `part-${String(partIndex + 1).padStart(2, "0")}`;
    const textPath = path.join(scenePartsRoot, `${partName}.txt`);
    const mp3Path = path.join(scenePartsRoot, `${partName}.mp3`);
    const vttPath = path.join(scenePartsRoot, `${partName}.vtt`);
    const wavPath = path.join(scenePartsRoot, `${partName}.wav`);

    await writeFile(textPath, `${textPart.text.trim()}\n`, "utf8");
    await run("edge-tts", [
      "--file",
      textPath,
      "--voice",
      voice,
      `--rate=${rate}`,
      `--pitch=${pitch}`,
      "--write-media",
      mp3Path,
      "--write-subtitles",
      vttPath,
    ]);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mp3Path,
      "-ar",
      String(sampleRate),
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);

    const durationSec = await probeDuration(wavPath);
    const rawCues = parseVtt(await readFile(vttPath, "utf8"));
    synthesizedParts.push({
      ...textPart,
      wavPath,
      durationSec,
      cues: rawCues,
    });
  }

  const sceneWavPath = path.join(ttsRoot, `${scene.sceneId}.wav`);
  const sceneVttPath = path.join(sceneSubtitleRoot, `${scene.sceneId}.vtt`);
  const sceneTextPath = path.join(ttsRoot, `${scene.sceneId}.txt`);

  if (synthesizedParts.length === 1) {
    await copyFile(synthesizedParts[0].wavPath, sceneWavPath);
  } else {
    await concatenateWithPauses(
      synthesizedParts,
      sceneWavPath,
      sampleRate,
    );
  }

  const sceneDurationSec = await probeDuration(sceneWavPath);
  const adjustedRawCues = [];
  let partOffsetSec = 0;
  for (const part of synthesizedParts) {
    for (const cue of part.cues) {
      adjustedRawCues.push({
        startSec: cue.startSec + partOffsetSec,
        endSec: cue.endSec + partOffsetSec,
        text: cue.text,
      });
    }
    partOffsetSec += part.durationSec + part.pauseAfterSec;
  }
  const phraseCues = groupCues(adjustedRawCues, subtitleMaxChars);

  await writeFile(sceneTextPath, `${scene.narration.trim()}\n`, "utf8");
  await writeFile(sceneVttPath, formatVtt(phraseCues), "utf8");

  generatedScenes.push({
    sceneId: scene.sceneId,
    order: scene.order,
    assetId: scene.assetId,
    text: scene.narration,
    audioPath: relativeProjectPath(sceneWavPath),
    subtitlePath: relativeProjectPath(sceneVttPath),
    durationSec: round(sceneDurationSec),
    subtitleCueCount: phraseCues.length,
    cues: phraseCues,
  });
}

const timeline = buildTimeline({
  project,
  generatedScenes,
  fps,
});
const masterCues = timeline.subtitleCues;

const masterSrtPath = path.join(subtitleRoot, "subtitles.srt");
const masterAssPath = path.join(subtitleRoot, "subtitles.ass");
const masterVttPath = path.join(subtitleRoot, "subtitles.vtt");

await writeFile(masterSrtPath, formatSrt(masterCues), "utf8");
await writeFile(masterAssPath, formatAss(masterCues), "utf8");
await writeFile(masterVttPath, formatVtt(masterCues), "utf8");
await writeJson(timelinePath, timeline);

const ttsManifest = {
  schemaVersion: "1.0",
  projectId: project.project.id,
  generatedAt: new Date().toISOString(),
  provider: project.audio?.tts?.provider ?? "edge-tts",
  voice,
  rate,
  pitch,
  sampleRate,
  scenes: generatedScenes.map(({cues, ...scene}) => scene),
  subtitles: {
    cueCount: masterCues.length,
    srtPath: relativeProjectPath(masterSrtPath),
    assPath: relativeProjectPath(masterAssPath),
    vttPath: relativeProjectPath(masterVttPath),
  },
  timelinePath: relativeProjectPath(timelinePath),
  durationSec: timeline.durationSec,
};
await writeJson(ttsManifestPath, ttsManifest);

await updateProjectManifest({
  manifestPath,
  project,
  generatedScenes,
  masterSrtPath,
  masterAssPath,
  masterVttPath,
  timelinePath,
});
await updateProjectStatus({
  statusPath,
  narratedSceneCount: narratedScenes.length,
  subtitleCueCount: masterCues.length,
  durationSec: timeline.durationSec,
});

console.log(
  JSON.stringify(
    {
      projectId: project.project.id,
      narratedScenes: narratedScenes.length,
      subtitleCues: masterCues.length,
      durationSec: timeline.durationSec,
      stage: "generated",
      nextStage: "compose",
      ttsManifest: relativeProjectPath(ttsManifestPath),
      timeline: relativeProjectPath(timelinePath),
    },
    null,
    2,
  ),
);

function splitNarrationAtTimingCues(scene) {
  const narration = scene.narration.trim();
  const cues = Array.isArray(scene.timingCues) ? scene.timingCues : [];
  if (cues.length === 0) {
    return [{text: narration, pauseAfterSec: 0}];
  }

  const sortedBoundaries = cues
    .map((cue) => {
      const marker = String(cue.afterText ?? "").trim();
      const index = narration.indexOf(marker);
      if (!marker || index < 0) {
        fail(
          `Timing cue marker was not found in scene "${scene.sceneId}": ${marker}`,
        );
      }
      return {
        endIndex: index + marker.length,
        pauseSec: Number(cue.pauseSec ?? 0),
      };
    })
    .sort((a, b) => a.endIndex - b.endIndex);

  const parts = [];
  let startIndex = 0;
  for (const boundary of sortedBoundaries) {
    const text = narration.slice(startIndex, boundary.endIndex).trim();
    if (text) {
      parts.push({text, pauseAfterSec: boundary.pauseSec});
    }
    startIndex = boundary.endIndex;
  }
  const remaining = narration.slice(startIndex).trim();
  if (remaining) {
    parts.push({text: remaining, pauseAfterSec: 0});
  }
  if (parts.length > 0) {
    parts[parts.length - 1].pauseAfterSec = 0;
  }
  return parts;
}

async function concatenateWithPauses(parts, outputPath, targetSampleRate) {
  const ffmpegArgs = ["-hide_banner", "-loglevel", "error", "-y"];
  const labels = [];
  let inputIndex = 0;

  for (const part of parts) {
    ffmpegArgs.push("-i", part.wavPath);
    labels.push(`[${inputIndex}:a]`);
    inputIndex += 1;
    if (part.pauseAfterSec > 0) {
      ffmpegArgs.push(
        "-f",
        "lavfi",
        "-t",
        String(part.pauseAfterSec),
        "-i",
        `anullsrc=r=${targetSampleRate}:cl=stereo`,
      );
      labels.push(`[${inputIndex}:a]`);
      inputIndex += 1;
    }
  }

  ffmpegArgs.push(
    "-filter_complex",
    `${labels.join("")}concat=n=${labels.length}:v=0:a=1[out]`,
    "-map",
    "[out]",
    "-ar",
    String(targetSampleRate),
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    outputPath,
  );
  await run("ffmpeg", ffmpegArgs);
}

function buildTimeline({project: sourceProject, generatedScenes: audioScenes, fps: framesPerSecond}) {
  const generatedBySceneId = new Map(
    audioScenes.map((scene) => [scene.sceneId, scene]),
  );
  const scenes = [];
  const subtitleCues = [];
  let cursorSec = 0;

  for (const sourceScene of sourceProject.content.scenes) {
    const generatedScene = generatedBySceneId.get(sourceScene.sceneId);
    const durationPolicy = sourceScene.durationPolicy ?? {};
    let sceneDurationSec;
    let audioPath = null;

    if (generatedScene) {
      const tailPaddingSec = Number(durationPolicy.tailPaddingSec ?? 0);
      sceneDurationSec = generatedScene.durationSec + tailPaddingSec;
      audioPath = generatedScene.audioPath;
      for (const cue of generatedScene.cues) {
        subtitleCues.push({
          sceneId: sourceScene.sceneId,
          startSec: round(cursorSec + cue.startSec),
          endSec: round(cursorSec + cue.endSec),
          text: cue.text,
          words: (cue.words ?? []).map((word) => ({
            startSec: round(cursorSec + word.startSec),
            endSec: round(cursorSec + word.endSec),
            text: word.text,
          })),
        });
      }
    } else if (durationPolicy.mode === "fixed") {
      sceneDurationSec = Number(durationPolicy.durationSec);
    } else {
      sceneDurationSec = 2;
    }

    const startSec = cursorSec;
    const endSec = startSec + sceneDurationSec;
    scenes.push({
      sceneId: sourceScene.sceneId,
      order: sourceScene.order,
      kind: sourceScene.kind,
      assetId: sourceScene.assetId,
      startSec: round(startSec),
      endSec: round(endSec),
      durationSec: round(sceneDurationSec),
      startFrame: Math.round(startSec * framesPerSecond),
      durationFrames: Math.round(sceneDurationSec * framesPerSecond),
      audioPath,
      transitionOut: sourceScene.transitionOut ?? null,
      soundCues: sourceScene.soundCues ?? [],
    });
    cursorSec = endSec;
  }

  return {
    schemaVersion: "1.0",
    projectId: sourceProject.project.id,
    generatedAt: new Date().toISOString(),
    fps: framesPerSecond,
    durationSec: round(cursorSec),
    durationFrames: Math.ceil(cursorSec * framesPerSecond),
    scenes,
    subtitleCues,
  };
}

function parseVtt(vttText) {
  const normalized = vttText.replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [start, endWithSettings] = lines[timingIndex].split("-->");
    const end = endWithSettings.trim().split(/\s+/)[0];
    const text = decodeEntities(
      lines
        .slice(timingIndex + 1)
        .join(" ")
        .replace(/<[^>]+>/g, "")
        .trim(),
    );
    if (!text) continue;
    cues.push({
      startSec: parseTimestamp(start.trim()),
      endSec: parseTimestamp(end),
      text,
    });
  }
  return cues;
}

function groupCues(cues, maxChars) {
  if (cues.length === 0) return [];
  const grouped = [];
  let group = null;
  const wordCues = cues.flatMap((cue) => expandCueToWords(cue));

  for (const cue of wordCues) {
    if (!group) {
      group = {...cue, words: expandCueToWords(cue)};
      continue;
    }
    const combinedText = joinSubtitleText(group.text, cue.text);
    const combinedDuration = cue.endSec - group.startSec;
    const gap = cue.startSec - group.endSec;
    const previousEndsSentence = /[.!?]["']?$/.test(group.text);
    const shouldBreak =
      gap > 0.75 ||
      combinedText.length > maxChars ||
      combinedDuration > 4.5 ||
      previousEndsSentence;

    if (shouldBreak) {
      grouped.push(group);
      group = {...cue, words: expandCueToWords(cue)};
    } else {
      group.text = combinedText;
      group.endSec = cue.endSec;
      group.words.push(...expandCueToWords(cue));
    }
  }
  if (group) grouped.push(group);

  // Avoid leaving a sentence-final one- or two-word fragment on its own.
  // Rebalance the preceding phrase using the word timings so both cards
  // remain readable and the spoken timing stays exact.
  for (let index = 1; index < grouped.length; index += 1) {
    const current = grouped[index];
    const previous = grouped[index - 1];
    const isShortContinuation =
      current.words.length <= 2 &&
      /^[a-z0-9]/.test(current.text) &&
      current.startSec - previous.endSec < 0.75;
    if (!isShortContinuation) continue;

    const words = [...previous.words, ...current.words];
    if (words.length < 6) continue;
    const splitAt = Math.max(3, Math.min(words.length - 3, Math.floor(words.length / 2)));
    grouped[index - 1] = cueFromWords(words.slice(0, splitAt));
    grouped[index] = cueFromWords(words.slice(splitAt));
  }

  const normalized = grouped.map((cue) => ({
    startSec: round(cue.startSec),
    endSec: round(Math.max(cue.endSec, cue.startSec + 0.45)),
    text: cue.text.trim(),
    words: cue.words.map((word) => ({...word})),
  }));
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const cue = normalized[index];
    const nextCue = normalized[index + 1];
    if (cue.endSec >= nextCue.startSec) {
      cue.endSec = round(
        Math.max(cue.startSec + 0.1, nextCue.startSec - 0.01),
      );
    }
  }
  return normalized;
}

function cueFromWords(words) {
  const text = words
    .map((word) => word.text)
    .join(" ")
    .replace(/\s+([,.;:!?])/g, "$1");
  return {
    startSec: words[0].startSec,
    endSec: words.at(-1).endSec,
    text,
    words: words.map((word) => ({...word})),
  };
}

function expandCueToWords(cue) {
  const tokens = String(cue.text ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return [{...cue}];
  }
  const durationSec = Math.max(0.1, cue.endSec - cue.startSec);
  const weights = tokens.map((token) => {
    const letters = token.replace(/[^\p{L}\p{N}']/gu, "").length;
    const punctuationPause = /[.!?]["']?$/.test(token)
      ? 1.55
      : /[,;:]["']?$/.test(token)
        ? 1.25
        : 1;
    return Math.max(1, letters) * punctuationPause;
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const words = [];
  let cursorSec = cue.startSec;
  for (let index = 0; index < tokens.length; index += 1) {
    const endSec =
      index === tokens.length - 1
        ? cue.endSec
        : cursorSec + durationSec * (weights[index] / totalWeight);
    words.push({
      startSec: round(cursorSec),
      endSec: round(endSec),
      text: tokens[index],
    });
    cursorSec = endSec;
  }
  return words;
}

function joinSubtitleText(left, right) {
  const joined = `${left.trim()} ${right.trim()}`;
  return joined
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([“‘])\s+/g, "$1")
    .replace(/\s+([”’])/g, "$1");
}

function formatSrt(cues) {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.startSec, ",")} --> ${formatTimestamp(cue.endSec, ",")}\n${wrapSubtitle(cue.text, 34)}\n`,
    )
    .join("\n")}\n`;
}

function formatVtt(cues) {
  return `WEBVTT\n\n${cues
    .map(
      (cue) =>
        `${formatTimestamp(cue.startSec, ".")} --> ${formatTimestamp(cue.endSec, ".")}\n${wrapSubtitle(cue.text, 34)}\n`,
    )
    .join("\n")}`;
}

function formatAss(cues) {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: LLFC,Arial,72,&H00F5F1E6,&H00F5F1E6,&H00100F0D,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,80,80,34,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues
    .map((cue) => {
      const text = wrapSubtitle(cue.text, 34)
        .replace(/\n/g, "\\N")
        .replace(/[{}]/g, "");
      return `Dialogue: 0,${formatAssTimestamp(cue.startSec)},${formatAssTimestamp(cue.endSec)},LLFC,,0,0,0,,${text}`;
    })
    .join("\n");
  return `${header}${events}\n`;
}

function formatKaraokeText(cue, maxLineChars) {
  const words = Array.isArray(cue.words) ? cue.words : [];
  if (words.length === 0) {
    return wrapSubtitle(cue.text, maxLineChars)
      .replace(/\n/g, "\\N")
      .replace(/[{}]/g, "");
  }

  let output = "";
  let lineLength = 0;
  let lineCount = 0;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const text = String(word.text ?? "").trim().replace(/[{}]/g, "");
    if (!text) continue;
    const punctuation = /^[,.;:!?%)\]”’]+$/.test(text);
    const needsSpace = output && !punctuation;
    const tokenLength = text.length + (needsSpace ? 1 : 0);
    let prefix = needsSpace ? " " : "";
    if (
      lineLength > 0 &&
      lineLength + tokenLength > maxLineChars &&
      lineCount < 1
    ) {
      prefix = "\\N";
      lineLength = text.length;
      lineCount += 1;
    } else {
      lineLength += tokenLength;
    }

    const nextStartSec = Number(words[index + 1]?.startSec ?? cue.endSec);
    const startSec = Math.max(Number(cue.startSec), Number(word.startSec));
    const endSec = Math.min(Number(cue.endSec), nextStartSec);
    const centiseconds = Math.max(1, Math.round((endSec - startSec) * 100));
    output += `${prefix}{\\kf${centiseconds}}${text}`;
  }
  return output;
}

function wrapSubtitle(text, maxLineChars) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLineChars) return normalized;
  const words = normalized.split(" ");
  if (words.length <= 1) return normalized;

  let bestIndex = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const firstLine = words.slice(0, index).join(" ");
    const secondLine = words.slice(index).join(" ");
    const overflow =
      Math.max(0, firstLine.length - maxLineChars) +
      Math.max(0, secondLine.length - maxLineChars);
    const balance = Math.abs(firstLine.length - secondLine.length);
    const score = overflow * 1000 + balance;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return `${words.slice(0, bestIndex).join(" ")}\n${words
    .slice(bestIndex)
    .join(" ")}`;
}

function parseTimestamp(value) {
  const match = value.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
  if (!match) fail(`Invalid subtitle timestamp: ${value}`);
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function formatTimestamp(seconds, separator) {
  const totalMilliseconds = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((totalMilliseconds % 60_000) / 1000);
  const millis = totalMilliseconds % 1000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)}${separator}${pad(millis, 3)}`;
}

function formatAssTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const centis = centiseconds % 100;
  return `${hours}:${pad(minutes, 2)}:${pad(secs, 2)}.${pad(centis, 2)}`;
}

async function updateProjectManifest({
  manifestPath: targetManifestPath,
  project: sourceProject,
  generatedScenes: audioScenes,
  masterSrtPath: srtPath,
  masterAssPath: assPath,
  masterVttPath: vttPath,
  timelinePath: targetTimelinePath,
}) {
  const manifest = await readJson(targetManifestPath);
  const retainedAssets = (manifest.assets ?? []).filter(
    (asset) => asset.generator !== "llfc-tts",
  );
  const generatedAssets = [];
  for (const scene of audioScenes) {
    const absoluteAudioPath = path.join(
      projectRoot,
      scene.audioPath.replaceAll("/", path.sep),
    );
    generatedAssets.push({
      assetId: `${scene.sceneId}-voice`,
      type: "audio",
      role: "narration",
      sceneId: scene.sceneId,
      path: scene.audioPath,
      source: "edge-tts",
      generator: "llfc-tts",
      status: "generated",
      media: {
        durationSec: scene.durationSec,
        sampleRate,
        channels: 2,
        format: "wav",
        bytes: (await stat(absoluteAudioPath)).size,
      },
    });
  }
  for (const [assetId, type, absolutePath] of [
    ["subtitles-srt", "subtitle", srtPath],
    ["subtitles-ass", "subtitle", assPath],
    ["subtitles-vtt", "subtitle", vttPath],
    ["timeline", "timeline", targetTimelinePath],
  ]) {
    generatedAssets.push({
      assetId,
      type,
      role: assetId,
      path: relativeProjectPath(absolutePath),
      source: "llfc-tts",
      generator: "llfc-tts",
      status: "generated",
      bytes: (await stat(absolutePath)).size,
    });
  }
  manifest.updatedAt = new Date().toISOString();
  manifest.assets = [...retainedAssets, ...generatedAssets];
  await writeJsonAtomic(targetManifestPath, manifest);
}

async function updateProjectStatus({
  statusPath: targetStatusPath,
  narratedSceneCount,
  subtitleCueCount,
  durationSec,
}) {
  const status = await readJson(targetStatusPath);
  status.updatedAt = new Date().toISOString();
  status.stage = "generated";
  status.nextStage = "compose";
  status.progress ??= {};
  status.progress.tts = {
    required: narratedSceneCount,
    generated: narratedSceneCount,
  };
  status.progress.subtitlesGenerated = true;
  status.progress.subtitleCueCount = subtitleCueCount;
  status.progress.timelineGenerated = true;
  status.progress.durationSec = durationSec;
  status.progress.renderReady = false;
  await writeJsonAtomic(targetStatusPath, status);
}

async function probeDuration(filePath) {
  const output = await run(
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
    {captureStdout: true},
  );
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    fail(`Could not determine audio duration: ${filePath}`);
  }
  return duration;
}

async function assertExecutable(command, commandArgs) {
  await run(command, commandArgs, {captureStdout: true});
}

async function run(command, commandArgs, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: FACTORY_ROOT,
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

function decodeEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
