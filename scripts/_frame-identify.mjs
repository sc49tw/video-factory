// Frame-level source identification: extract frames from a rendered MP4 and from
// candidate source assets, then match each rendered frame against every source by
// mean absolute grayscale difference across the whole frame (scale/rotation
// invariant enough for a cut/paste decision, and fully deterministic).
//
// Usage: node scripts/_frame-identify.mjs --video <mp4> --times 358,365,369,373 \
//        --sources name=path,name=path --out <dir>
import {mkdir, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";

const run = (cmd, args, {binary = false} = {}) =>
  new Promise((resolve, reject) => {
    const c = spawn(cmd, args, {stdio: ["ignore", "pipe", "pipe"], encoding: binary ? "buffer" : "utf8"});
    const chunks = [];
    let se = "";
    c.stdout.on("data", (d) => chunks.push(d));
    c.stderr.on("data", (d) => (se += binary ? d.toString("utf8") : d));
    c.on("error", reject);
    c.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${cmd} ${code}: ${se.slice(-4000)}`));
      resolve(binary ? Buffer.concat(chunks) : chunks.join(""));
    });
  });

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
};

const W = 32;
const H = 32;

async function graySignature(file, seekSec) {
  const args = ["-v", "error"];
  if (seekSec !== null) args.push("-ss", String(seekSec));
  args.push(
    "-i", file,
    "-frames:v", "1",
    "-vf", `scale=${W}:${H}:flags=area,format=gray`,
    "-f", "rawvideo", "-",
  );
  const buf = await run("ffmpeg", args, {binary: true});
  return buf.subarray(0, W * H);
}

function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

const video = arg("video");
const times = (arg("times") ?? "").split(",").map(Number).filter((n) => Number.isFinite(n));
const sources = (arg("sources") ?? "").split(",").filter(Boolean).map((pair) => {
  const i = pair.indexOf("=");
  return {name: pair.slice(0, i), file: pair.slice(i + 1)};
});
const outDir = arg("out") ?? path.join(os.tmpdir(), "frame-identify");
await mkdir(outDir, {recursive: true});

console.log(`video: ${video}`);
console.log(`times: ${times.join(", ")}`);
console.log(`sources: ${sources.map((s) => s.name).join(", ")}\n`);

// Source signatures: several offsets inside each source (in-point 0 is authoritative,
// extra offsets guard against a source that is letterboxed/black at frame 0).
const sourceSigs = [];
for (const s of sources) {
  const dur = Number(
    (await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", s.file])).trim(),
  );
  const offsets = [0, 0.25, 0.5, 1, 2, 3].filter((o) => o < Math.max(dur - 0.2, 0.3));
  const sigs = [];
  for (const o of offsets) sigs.push({offsetSec: o, sig: await graySignature(s.file, o)});
  sourceSigs.push({...s, durationSec: dur, sigs});
  console.log(`source ${s.name}: duration ${dur.toFixed(3)}s, signature offsets ${offsets.join(",")}`);
}
console.log("");

for (const t of times) {
  const vSig = await graySignature(video, t);
  const scored = sourceSigs
    .map((s) => {
      const diffs = s.sigs.map((x) => meanAbsDiff(vSig, x.sig));
      const best = Math.min(...diffs);
      return {name: s.name, file: s.file, meanAbsDiff: Number(best.toFixed(3)), atOffsetSec: s.sigs[diffs.indexOf(best)].offsetSec};
    })
    .sort((a, b) => a.meanAbsDiff - b.meanAbsDiff);
  console.log(`t=${t}s`);
  for (const s of scored) {
    console.log(`   ${s.meanAbsDiff.toFixed(2).padStart(7)}  ${s.name}${s === scored[0] ? "   <== BEST MATCH" : ""}`);
  }
  const first = scored[0];
  const second = scored[1];
  const margin = second.meanAbsDiff - first.meanAbsDiff;
  console.log(`   verdict: ${first.name} (margin ${margin.toFixed(2)} vs ${second.name})`);
  await run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", video, "-frames:v", "1", path.join(outDir, `video-${String(t).replace(".", "_")}s.png`)]);
  console.log("");
}