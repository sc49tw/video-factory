// GENERIC ESSY BGM extended-master builder (episode-agnostic).
//
// Rebuilds an extended BGM master of ANY target duration from an approved
// source track, using the ESSY-0001 approved methodology:
//   - N overlapping source passes joined by 4 s equal-power crossfades
//     (acrossfade c1=qsin:c2=qsin)
//   - pass boundaries placed at measured low-RMS (0.5 s profile, 2.5 s
//     smoothed) anchors so no audible loop seam
//   - no time-stretch, no pitch-shift, no gain baked in
//   - final fade-out over the last 4 s
//
// Usage:
//   node scripts/build-bgm-extended.mjs <EPISODE> [--target <sec>] [--hold <sec>]
// Default target = narration-master duration + endingHoldSec from
// projects/<EPISODE>/final-assembly.json.
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import process from "node:process";

const SRC_MAX = 180; // measured source length (180.0 s)
const MIN_PASS = 30;
const MAX_PASS = 176;

const episode = process.argv[2];
if (!episode) {
  console.error("Usage: node scripts/build-bgm-extended.mjs <EPISODE> [--target <sec>] [--hold <sec>]");
  process.exit(1);
}
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? Number(process.argv[i + 1]) : null;
};
const holdArg = argValue("--hold");
const targetArg = argValue("--target");

const factoryRoot = process.cwd();
const projectRoot = path.join(factoryRoot, "projects", episode);
const decisions = JSON.parse(await readFile(path.join(projectRoot, "final-assembly.json"), "utf8"));
const music = decisions.music;
if (!music?.sourcePath || !music.extendedPath) {
  throw new Error(`final-assembly.json for ${episode} lacks music.sourcePath / music.extendedPath.`);
}
const XF = music.crossfadeDurationSec ?? 4;
const FADE = music.finalFadeOutDurSec ?? 4;

const sourcePath = path.resolve(factoryRoot, music.sourcePath);
const outputPath = path.resolve(factoryRoot, music.extendedPath);
await mkdir(path.dirname(outputPath), {recursive: true});
const tempRoot = path.join(projectRoot, "temp");

function run(command, args, {capture = false} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: factoryRoot, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"});
    let stdout = "", stderr = "";
    if (capture) {
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
    }
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve({stdout, stderr}) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-800)}`)),
    );
  });
}

// ---- Target duration ----
let target;
if (targetArg) {
  target = targetArg;
} else {
  const masterPath = path.join(projectRoot, "temp", `${episode}-narration-master.m4a`);
  const out = await run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", masterPath],
    {capture: true},
  );
  const hold = holdArg ?? decisions.endingHoldSec ?? 4;
  target = Number(out.stdout.trim()) + hold;
}
target = Math.round(target * 1000) / 1000;

// ---- 1. Measure RMS profile (0.5 s windows) ----
const rmsPath = path.join(tempRoot, "bgm-rms-profile.txt");
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-i", sourcePath,
  // Relative (colon-free) path — ffmpeg filtergraph parsing rejects the
  // "D\\:/..." drive-letter escaping on Windows.
  "-af", "asetnsamples=n=22050,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=" +
    path.relative(factoryRoot, rmsPath).replaceAll("\\", "/"),
  "-f", "null", "-",
]);
const lines = (await readFile(rmsPath, "utf8")).split(/\r?\n/);
const prof = [];
for (let i = 0; i + 1 < lines.length; i += 2) {
  const t = parseFloat((lines[i].match(/pts_time:([0-9.]+)/) || [])[1]);
  const r = parseFloat((lines[i + 1] || "").split("=")[1]);
  if (Number.isFinite(t) && Number.isFinite(r)) prof.push({t, r});
}
if (prof.length === 0) throw new Error("empty RMS profile");

// 2.5 s moving-average smoothing.
const sm = prof.map((p, i) => {
  let sum = 0, n = 0;
  for (let k = -2; k <= 2; k++) {
    const j = i + k;
    if (j >= 0 && j < prof.length) { sum += prof[j].r; n++; }
  }
  return {t: p.t, v: sum / n};
});
const argmin = (lo, hi, avoid = [], sep = 0) => {
  let best = null;
  for (const p of sm) {
    if (p.t < lo || p.t > hi) continue;
    if (avoid.some((a) => Math.abs(p.t - a) < sep)) continue;
    if (!best || p.v < best.v) best = p;
  }
  return best ?? argmin(lo, hi);
};

// ---- 2. Plan passes: sum(len_i) - (n-1)*XF = target ----
const neededPasses = (() => {
  let n = 1;
  while (Math.min(MAX_PASS, SRC_MAX - 2) * n - (n - 1) * XF < target) n += 1;
  return n;
})();
if (neededPasses < 3) {
  throw new Error(`Target ${target}s fits under 3 passes; use the approved short-form construction instead.`);
}

// Pass 1: 0 -> late low-energy anchor. Middle passes: early-low start to
// late-low end (distinct anchors, >=6 s apart). Final pass: sized to land the
// total on target exactly, starting at the least energetic remaining window.
const middleEnds = [];
const middlePasses = neededPasses - 2;
for (let i = 0; i < middlePasses; i++) {
  const end = argmin(152, 176, middleEnds, 6).t;
  middleEnds.push(end);
}
const middleStart = argmin(4, 20).t;

let m1 = argmin(150, 178).t;
const computeLast = () =>
  target + (neededPasses - 1) * XF - (m1 + middleEnds.reduce((s, e) => s + (e - middleStart), 0));
let guard = 0;
while ((computeLast() > MAX_PASS || computeLast() < MIN_PASS) && guard < 120) {
  if (computeLast() > MAX_PASS && m1 < 177.5) m1 += 0.5;
  else if (computeLast() < MIN_PASS && m1 > 120) m1 -= 0.5;
  else break;
  guard += 1;
}
const lastLen = computeLast();
if (!(lastLen >= MIN_PASS && lastLen <= MAX_PASS)) {
  throw new Error(`Cannot size final pass within [${MIN_PASS}, ${MAX_PASS}] for target ${target}s.`);
}
const lastStart = Math.min(argmin(4, Math.max(8, SRC_MAX - lastLen)).t, Math.max(2, SRC_MAX - lastLen));

const passes = [{start: 0, end: m1}];
for (const end of middleEnds) passes.push({start: middleStart, end});
passes.push({start: lastStart, end: lastStart + lastLen});

const sumCheck = passes.reduce((s, p) => s + (p.end - p.start), 0) - (passes.length - 1) * XF;
if (Math.abs(sumCheck - target) > 0.01) {
  throw new Error(`Sum check failed: ${sumCheck.toFixed(3)} vs target ${target}`);
}

// ---- 3. Emit ffmpeg filter_complex ----
const f = (x) => x.toFixed(3);
const filter = [];
passes.forEach((p, i) => {
  filter.push(`[0:a]atrim=start=${f(p.start)}:end=${f(p.end)},asetpts=PTS-STARTPTS[s${i}];`);
});
let prev = "s0";
for (let i = 1; i < passes.length; i++) {
  const out = `x${i}`;
  filter.push(`[${prev}][s${i}]acrossfade=d=${XF}:c1=qsin:c2=qsin[${out}];`);
  prev = out;
}
filter.push(
  `[${prev}]aresample=48000,apad=whole_dur=${f(target)},atrim=duration=${f(target)},` +
    `afade=t=out:st=${f(target - FADE)}:d=${f(FADE)}[out]`,
);
const filterPath = path.join(tempRoot, "bgm-extended-filter.txt");
await writeFile(filterPath, filter.join("\n"), "utf8");

// ---- 4. Render ----
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-i", sourcePath,
  "-filter_complex_script", filterPath.replaceAll("\\", "/"),
  "-map", "[out]",
  "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
  outputPath,
]);
const actual = Number(
  (await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath], {capture: true}))
    .stdout.trim(),
);
if (Math.abs(actual - target) > 0.05) {
  throw new Error(`Extended master duration ${actual.toFixed(3)}s != target ${target.toFixed(3)}s.`);
}

// ---- 5. Plan / provenance ----
const planPath = music.planPath ?? path.join(path.dirname(outputPath), "bgm-plan.json");
const joins = [];
for (let i = 1; i < passes.length; i++) {
  const timelineStart = passes.slice(0, i).reduce((s, p) => s + (p.end - p.start), 0) - i * XF;
  joins.push({
    join: i,
    timelineStartSec: Number(timelineStart.toFixed(3)),
    timelineEndSec: Number((timelineStart + XF).toFixed(3)),
    outgoingSourceEndSec: Number(passes[i - 1].end.toFixed(3)),
    incomingSourceStartSec: Number(passes[i].start.toFixed(3)),
  });
}
await writeFile(
  planPath,
  `${JSON.stringify({
    schemaVersion: "1.0",
    episode,
    status: "extended-master",
    selectedTrack: music.selectedTrack,
    artist: music.artist,
    source: music.source,
    attributionRequired: music.attributionRequired,
    originalFilePath: music.sourcePath,
    extendedFilePath: music.extendedPath,
    originalDurationSec: SRC_MAX,
    targetDurationSec: target,
    actualExtendedDurationSec: Number(actual.toFixed(3)),
    crossfadeDurationSec: XF,
    crossfadeCurve: "equal-power (acrossfade c1=qsin:c2=qsin)",
    construction: {
      method:
        "N overlapping source passes joined by equal-power crossfades; pass boundaries placed at measured " +
        "RMS minima (0.5 s profile, 2.5 s smoothing); no time-stretch or pitch-shift; gain NOT baked in",
      passes: passes.map((p, i) => ({
        pass: i + 1,
        sourceStartSec: Number(p.start.toFixed(3)),
        sourceEndSec: Number(p.end.toFixed(3)),
      })),
    },
    transitionTimestamps: joins,
    finalFadeOutDurationSec: FADE,
    finalFadeOutStartSec: Number((target - FADE).toFixed(3)),
    mixGainDb: music.gainDb ?? -9,
    mixGainAppliedToMaster: false,
    audioStream: "pcm_s16le 48000 Hz stereo",
  }, null, 2)}\n`,
  "utf8",
);

console.log(`BGM extended master OK: ${path.relative(factoryRoot, outputPath)}`);
console.log(`  target ${target.toFixed(3)}s | actual ${actual.toFixed(3)}s | ${passes.length} passes, ${joins.length} joins`);
console.log(`  plan: ${path.relative(factoryRoot, planPath)}`);




