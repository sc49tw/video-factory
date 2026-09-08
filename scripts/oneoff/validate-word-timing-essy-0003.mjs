// CONTROLLED VALIDATION: word-boundary subtitle timing for ESSY-0003 N003
// (sentence-003, the ~47.6 s giant-cue failure case from the timing audit).
//
// Writes only validation outputs into projects/ESSY-0003/temp/:
//   ESSY-0003-n003-word-timing-validation.json
//   ESSY-0003-n003-word-timing.srt
//   ESSY-0003-n003-subtitle-sync-sample.mp4   (short review sample)
// No narration, audio, visual or manifest file is modified.
//
// Usage: node scripts/oneoff/validate-word-timing-essy-0003.mjs
import {readFile, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {expandCue, normalizeCueTimeline} from "../_build-subtitle-timeline.mjs";
import {resolveSubtitleConfig} from "../subtitle-config.mjs";

const episode = "ESSY-0003";
const sentenceId = "sentence-003";
const factoryRoot = process.cwd();
const project = path.join(factoryRoot, "projects", episode);
const temp = path.join(project, "temp");

const srtTimestamp = (sec) => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, "0")}`;
};
const writeSrt = (cues) =>
  cues.map((c, i) => `${i + 1}\n${srtTimestamp(c.startSec)} --> ${srtTimestamp(c.endSec)}\n${c.text}\n`).join("\n");
const run = (cmd, args, cwd = factoryRoot) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {cwd, stdio: ["ignore", "ignore", "pipe"]});
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))));
  });

const timeline = JSON.parse(await readFile(path.join(project, "assembly-timeline.json"), "utf8"));
const block = timeline.blocks.find((b) => b.sentenceId === sentenceId);
const offset = block.startSec;
const artifact = JSON.parse(await readFile(path.join(temp, `${sentenceId}.words.json`), "utf8"));
const words = artifact.words;
const vttText = await readFile(path.join(temp, `${sentenceId}.vtt`), "utf8");
const t = (h, mi, s, ms) => +h * 3600 + +mi * 60 + +s + +ms / 1000;
// Line-based VTT parse (same semantics as parseVtt in the shared builder).
const parents = [];
{
  const lines = vttText.split("\n");
  const timeMatch = (l) => l.match(/(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})/);
  const idx = lines.map((l, i) => (timeMatch(l) ? i : -1)).filter((i) => i >= 0);
  idx.forEach((i, k) => {
    const m = timeMatch(lines[i]);
    const next = k + 1 < idx.length ? idx[k + 1] : lines.length;
    const textLines = [];
    for (let j = i + 1; j < next; j += 1) {
      const line = lines[j].trim();
      if (line && !timeMatch(line)) textLines.push(line);
    }
    if (textLines.length) {
      parents.push({
        startSec: t(m[1], m[2], m[3], m[4]) + offset,
        endSec: t(m[5], m[6], m[7], m[8]) + offset,
        text: textLines.join(" "),
      });
    }
  });
}
if (!parents.length) throw new Error("No VTT cues parsed from sentence-003.vtt");

const config = resolveSubtitleConfig();
const wordCues = [];
const legacyCues = [];
for (const parent of parents) {
  for (const c of expandCue(parent, config, words, offset)) wordCues.push({...c, blockId: sentenceId});
  for (const c of expandCue(parent, config, null, offset)) legacyCues.push({...c, blockId: sentenceId});
}
const {cues: normalized} = normalizeCueTimeline(wordCues);

// Compare legacy char-share children against actual word timing.
const legacyVsSpeech = [];
for (const [i, legacy] of legacyCues.entries()) {
  const word = normalized[i];
  if (!word?.speechStartSec) break;
  legacyVsSpeech.push({
    text: legacy.text,
    legacyStartSec: Number(legacy.startSec.toFixed(3)),
    actualSpeechStartSec: Number(word.speechStartSec.toFixed(3)),
    startDriftMs: Math.round((legacy.startSec - word.speechStartSec) * 1000),
  });
}
const drifts = legacyVsSpeech.map((r) => Math.abs(r.startDriftMs)).sort((a, b) => a - b);
const pct = (p) => (drifts.length ? drifts[Math.min(drifts.length - 1, Math.ceil((p / 100) * drifts.length) - 1)] : null);

const stats = {
  block: `${sentenceId} (n003)`,
  blockStartSec: offset,
  timingSource: "edge-tts-word-boundary",
  cacheIdentity: artifact.cacheIdentity,
  wordCount: words.length,
  lastWordEndSec: artifact.validation.lastWordEndSec,
  audioDurationSec: artifact.cacheIdentity.audioDurationSec,
  parentVttCueCount: parents.length,
  cueCount: normalized.length,
  allWordTimed: normalized.every((c) => c.timingSource === "edge-word-boundary"),
  timingSourceCounts: normalized.reduce((a, c) => ((a[c.timingSource] = (a[c.timingSource] ?? 0) + 1), a), {}),
  legacyCharShareComparison: {
    cueCount: legacyVsSpeech.length,
    absoluteStartDriftMs: {p50: pct(50), p90: pct(90), p95: pct(95), p99: pct(99), max: drifts.at(-1) ?? null},
    perCue: legacyVsSpeech,
  },
  cues: normalized.map((c) => ({
    text: c.text,
    startSec: Number(c.startSec.toFixed(3)),
    endSec: Number(c.endSec.toFixed(3)),
    speechStartSec: c.speechStartSec != null ? Number(c.speechStartSec.toFixed(3)) : null,
    speechEndSec: c.speechEndSec != null ? Number(c.speechEndSec.toFixed(3)) : null,
    timingSource: c.timingSource,
    maxInternalWordGapSec: c.maxInternalWordGapSec ?? null,
  })),
};

const jsonPath = path.join(temp, "ESSY-0003-n003-word-timing-validation.json");
const srtPath = path.join(temp, "ESSY-0003-n003-word-timing.srt");
await writeFile(jsonPath, `${JSON.stringify(stats, null, 2)}\n`, "utf8");
await writeFile(srtPath, writeSrt(normalized), "utf8");

// ---- Local rebased timeline for STANDALONE VALIDATION PLAYBACK ----
// The sample audio (temp/narration-master/sentence-003-narration.m4a) is the
// block-local segment: N003 speech begins at LOCAL sample time ~0. The global
// SRT above (assembly timestamps) is kept for production/diagnostics only.
// The sample must burn LOCAL cues: local = global - sampleStartSec, where
// sampleStartSec is the same block origin used to extract the audio.
const sampleStartSec = offset; // N003-only sample: block start == sample origin
const localCues = normalized.map((c) => ({
  ...c,
  startSec: c.startSec - sampleStartSec,
  endSec: c.endSec - sampleStartSec,
}));
const negativeCues = localCues.filter((c) => c.startSec < 0);
if (negativeCues.length) throw new Error(`local cue starts < 0: ${JSON.stringify(negativeCues)}`);
const localSrtPath = path.join(temp, "ESSY-0003-n003-word-timing-local.srt");
await writeFile(localSrtPath, writeSrt(localCues), "utf8");
const lastLocalEnd = Math.max(...localCues.map((c) => c.endSec));

const samplePath = path.join(temp, "ESSY-0003-n003-subtitle-sync-sample.mp4");
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "color=c=0x101418:s=960x540:r=30",
  "-i", "narration-master/sentence-003-narration.m4a",
  "-vf", "subtitles=ESSY-0003-n003-word-timing-local.srt:force_style='FontSize=24,Alignment=2,MarginV=40'",
  "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k",
  "ESSY-0003-n003-subtitle-sync-sample.mp4",
], temp);

console.log(`Validation JSON    : ${path.relative(factoryRoot, jsonPath)}`);
console.log(`Global SRT (diag)  : ${path.relative(factoryRoot, srtPath)}`);
console.log(`Local SRT (sample) : ${path.relative(factoryRoot, localSrtPath)}`);
console.log(`Review sample      : ${path.relative(factoryRoot, samplePath)}`);
console.log(`globalBlockStartSec=${offset.toFixed(3)} sampleStartSec=${sampleStartSec.toFixed(3)}`);
console.log(`firstGlobalCueStartSec=${normalized[0].startSec.toFixed(3)} firstLocalCueStartSec=${localCues[0].startSec.toFixed(3)}`);
console.log(`lastLocalCueEndSec=${lastLocalEnd.toFixed(3)} (must be < sample duration)`);
console.log(`cues=${normalized.length} allWordTimed=${stats.allWordTimed} negativeLocalCues=${negativeCues.length}`);
console.log(`legacy char-share start drift vs actual speech: p50=${pct(50)}ms p90=${pct(90)}ms p95=${pct(95)}ms max=${drifts.at(-1)}ms`);
