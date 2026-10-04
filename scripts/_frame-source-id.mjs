// Robust rendered-frame source identification.
//
// Whole-frame mean absolute difference is unusable here: the review proxy has
// burned-in subtitles and two lossy re-encodes, so raw MAD is dominated by the
// subtitle band and codec noise. This tool instead compares a coarse spatial
// signature (grid of block means, subtitle band excluded) and reports a
// 0..100 match score plus the runner-up, which separates visually distinct
// sources by a wide margin.
//
// Usage:
//   node scripts/_frame-source-id.mjs --video <mp4> --times 358,365,369,373 \
//     --candidates "7702643=path.mp4,7393171=path.mp4,8865606=path.mp4" \
//     [--chain shot|review] [--crop-top 0.25 --crop-bottom 0.78]
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";

const GW = 16;
const GH = 9;

const run = (cmd, args, binary = false) =>
  new Promise((resolve, reject) => {
    const c = spawn(cmd, args, {stdio: ["ignore", "pipe", "pipe"], encoding: binary ? "buffer" : "utf8"});
    const chunks = [];
    let se = "";
    c.stdout.on("data", (d) => chunks.push(d));
    c.stderr.on("data", (d) => (se += d.toString()));
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0 ? resolve(binary ? Buffer.concat(chunks) : chunks.join("")) : reject(new Error(`${cmd} ${code}: ${se.slice(-3000)}`)),
    );
  });

const RAW_W = 256;
const RAW_H = 144;

async function signature(file, seekSec, chain) {
  const args = ["-v", "error"];
  if (seekSec !== null) args.push("-ss", String(seekSec));
  args.push("-i", file, "-frames:v", "1", "-vf", `${chain},scale=${RAW_W}:${RAW_H}:flags=area,format=gray`, "-f", "rawvideo", "-");
  const buf = await run("ffmpeg", args, true);
  const px = buf.subarray(0, RAW_W * RAW_H);
  const cw = Math.floor(RAW_W / GW);
  const ch = Math.floor(RAW_H / GH);
  const cells = [];
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      let s = 0;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) s += px[(gy * ch + y) * RAW_W + gx * cw + x];
      cells.push(s / (cw * ch));
    }
  }
  return cells;
}

// Exclude the subtitle band (bottom of frame) and, optionally, the title-card
// band, so only real picture content is compared.
const mask = (sigs, topFrac, bottomFrac) => {
  const keep = [];
  for (let gy = 0; gy < GH; gy++) {
    const f = (gy + 0.5) / GH;
    if (f < topFrac || f > bottomFrac) continue;
    for (let gx = 0; gx < GW; gx++) keep.push(sigs[gy * GW + gx]);
  }
  return keep;
};

const score = (a, b) => {
  // 1 - normalized MAD, clamped to 0..100
  let sad = 0;
  for (let i = 0; i < a.length; i++) sad += Math.abs(a[i] - b[i]);
  const mad = sad / a.length;
  return Number(Math.max(0, Math.min(100, 100 * (1 - mad / 128))).toFixed(1));
};

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};

const video = arg("video");
const times = (arg("times") ?? "").split(",").map(Number).filter(Number.isFinite);
const chain = arg("chain") ?? "review";
const topFrac = Number(arg("crop-top") ?? 0);
const bottomFrac = Number(arg("crop-bottom") ?? 1);
const offsets = (arg("offsets") ?? "0").split(",").map(Number);

const REVIEW_CHAIN = "scale=960:540:flags=lanczos";
const SHOT_CHAIN = "scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,fps=30,format=yuv420p";
const CHAIN = chain === "shot" ? SHOT_CHAIN : REVIEW_CHAIN;

const candidates = (arg("candidates") ?? "").split(",").filter(Boolean).map((p) => {
  const i = p.indexOf("=");
  return {name: p.slice(0, i), file: p.slice(i + 1)};
});

console.log(`video: ${video}`);
console.log(`chain: ${chain} | comparison band: ${(topFrac * 100).toFixed(0)}%-${(bottomFrac * 100).toFixed(0)}% of frame height`);
console.log(`candidates: ${candidates.map((c) => c.name).join(", ")}\n`);

for (const t of times) {
  const v = mask(await signature(video, t, REVIEW_CHAIN), topFrac, bottomFrac);
  const rows = [];
  for (const c of candidates) {
    let best = null;
    for (const o of offsets) {
      try {
        const s = mask(await signature(c.file, o, CHAIN), topFrac, bottomFrac);
        const sc = score(v, s);
        if (!best || sc > best.score) best = {score: sc, offsetSec: o};
      } catch (error) {
        best = {score: -1, offsetSec: o, error: error.message.slice(0, 120)};
      }
    }
    rows.push({name: c.name, ...best});
  }
  rows.sort((a, b) => b.score - a.score);
  console.log(`t=${t}s`);
  for (const r of rows) console.log(`   ${String(r.score).padStart(6)}  ${r.name}${r === rows[0] ? "   <== MATCH" : ""}${r.error ? ` (${r.error})` : ""}`);
  console.log(`   VERDICT: ${rows[0].name} (margin ${(rows[0].score - (rows[1]?.score ?? 0)).toFixed(1)})\n`);
}