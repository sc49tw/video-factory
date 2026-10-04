// STRICT rendered-source proof.
//
// Unlike a max-over-offsets search, this compares each rendered frame against
// each candidate at the ONE offset dictated by the authoritative assembly
// timeline, and it also proves the derivation chain (delivered review <- master
// draft <- shot intermediate <- approved source file).
//
// Every comparison is reported as a 0..100 signature score so a true match is
// unambiguous (>90) and a wrong source is clearly rejected (<80).
//
// Usage:
//   node scripts/_prove-render-chain.mjs --episode ESSY-0005 \
//     --review output/ESSY-0005/ESSY-0005-review-540p-subtitled-v2.mp4 \
//     --times 358,365,369,373 --offset 4 --crop-bottom 0.72
//
// --offset is the delivery-to-master shift: the openingIdentity review INSERTS
// the identity segment (plan.durationSec) after the pre-roll window, so every
// master timestamp at/after the insertion point appears `offset` seconds later
// in the delivered file. It is taken from opening-review-render.json by default.
import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";

const GW = 16;
const GH = 9;
const RAW_W = 256;
const RAW_H = 144;

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

const SHOT_CHAIN = "scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,fps=30,format=yuv420p";
const REVIEW_CHAIN = "scale=960:540:flags=lanczos";

async function signature(file, seekSec, chain, maskSpec) {
  const args = ["-v", "error"];
  if (seekSec !== null) args.push("-ss", seekSec.toFixed(3));
  args.push("-i", file, "-frames:v", "1", "-vf", `${chain},scale=${RAW_W}:${RAW_H}:flags=area,format=gray`, "-f", "rawvideo", "-");
  const buf = await run("ffmpeg", args, true);
  const px = buf.subarray(0, RAW_W * RAW_H);
  const cw = Math.floor(RAW_W / GW);
  const ch = Math.floor(RAW_H / GH);
  const keep = [];
  for (let gy = 0; gy < GH; gy++) {
    const f = (gy + 0.5) / GH;
    if (f < maskSpec.top || f > maskSpec.bottom) continue;
    for (let gx = 0; gx < GW; gx++) {
      let s = 0;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) s += px[(gy * ch + y) * RAW_W + gx * cw + x];
      keep.push(s / (cw * ch));
    }
  }
  return keep;
}

const score = (a, b) => {
  let sad = 0;
  for (let i = 0; i < a.length; i++) sad += Math.abs(a[i] - b[i]);
  return Number(Math.max(0, Math.min(100, 100 * (1 - sad / a.length / 128))).toFixed(1));
};

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};

const episode = arg("episode") ?? "ESSY-0005";
const review = arg("review");
const master = arg("master") ?? `output/${episode}/${episode}-full-draft-v1.mp4`;
const times = (arg("times") ?? "").split(",").map(Number).filter(Number.isFinite);
const maskSpec = {top: Number(arg("crop-top") ?? 0), bottom: Number(arg("crop-bottom") ?? 1)};

// Delivery -> master shift. The openingIdentity review inserts the identity
// segment, delaying all later master content by that duration.
let offsetSec = arg("offset") !== null ? Number(arg("offset")) : null;
if (offsetSec === null) {
  try {
    const orr = JSON.parse(await readFile(`projects/${episode}/opening-review-render.json`, "utf8"));
    offsetSec = Number(orr?.opening?.durationSec ?? 0);
  } catch {
    offsetSec = 0;
  }
}

const timeline = JSON.parse(await readFile(`projects/${episode}/assembly-timeline.json`, "utf8"));
const approved = new Map();
const collect = (n, out) => {
  if (Array.isArray(n)) return n.forEach((x) => collect(x, out));
  if (n && typeof n === "object") {
    if (typeof n.slotId === "string" && (n.assetId || n.localName)) out.set(n.slotId, n);
    else Object.values(n).forEach((v) => collect(v, out));
  }
};
collect(JSON.parse(await readFile(`projects/${episode}/sourcing/approved-slot-asset-map.json`, "utf8")), approved);

const shots = [];
for (const b of timeline.blocks ?? []) for (const s of b.shots ?? []) shots.push({...s, sentenceId: b.sentenceId});

console.log(`Strict render-chain proof — ${episode}`);
console.log(`review : ${review}`);
console.log(`master : ${master}`);
console.log(`offset : delivery t = master t + ${offsetSec}s`);
console.log(`band   : ${(maskSpec.top * 100).toFixed(0)}%-${(maskSpec.bottom * 100).toFixed(0)}% of frame height (subtitle band excluded)\n`);

for (const t of times) {
  const masterT = Number((t - offsetSec).toFixed(3));
  const shot = shots.find((s) => masterT >= s.absoluteStartSec && masterT < s.absoluteEndSec);
  console.log(`t=${t}s -> master ${masterT}s = ${shot ? `${shot.slotId} (window ${shot.absoluteStartSec}-${shot.absoluteEndSec}s)` : "NO SHOT"}`);
  if (!shot) { console.log(""); continue; }
  const local = Number((masterT - shot.absoluteStartSec).toFixed(3));
  const inter = `projects/${episode}/temp/full-draft-shots/${shot.slotId}.mp4`;
  const ap = approved.get(shot.slotId);

  const sigReview = await signature(review, t, REVIEW_CHAIN, maskSpec);
  const sigMaster = await signature(master, masterT, REVIEW_CHAIN, maskSpec);
  const sigInter = await signature(inter, local, REVIEW_CHAIN, maskSpec);
  const sigTimelineSrc = await signature(shot.sourcePath, local, SHOT_CHAIN, maskSpec);

  const siblingIds = [...new Set(shots.filter((s) => s.sentenceId === shot.sentenceId).map((s) => s.slotId))];
  const siblingRows = [];
  for (const sid of siblingIds) {
    const rec = approved.get(sid);
    const file = path.join(`projects/${episode}/sourcing/downloads`, rec.localName);
    const sig = await signature(file, local, SHOT_CHAIN, maskSpec);
    siblingRows.push({slotId: sid, assetId: rec.assetId, localName: rec.localName, score: score(sigReview, sig)});
  }

  const rows = [
    {label: `A. review-v2 <- master-v1 (same t)`, score: score(sigReview, sigMaster)},
    {label: `B. master-v1 <- shot intermediate ${shot.slotId} (+${local.toFixed(3)}s)`, score: score(sigMaster, sigInter)},
    {label: `C. shot intermediate <- timeline source (${path.basename(shot.sourcePath)})`, score: score(sigInter, sigTimelineSrc)},
    ...siblingRows.map((r) => ({label: `D. review-v2 <- approved ${r.slotId} ${r.assetId} (${r.localName})`, score: r.score})),
  ];

  for (const r of rows) console.log(`   ${String(r.score).padStart(6)}  ${r.label}`);
  const d = siblingRows.slice().sort((a, b) => b.score - a.score);
  console.log(`   >>> VISIBLE SOURCE for ${shot.slotId}: ${d[0].slotId} ${d[0].assetId} ` +
    `(score ${d[0].score}, runner-up ${d[1] ? `${d[1].assetId} ${d[1].score}` : "n/a"}, margin ${d[1] ? (d[0].score - d[1].score).toFixed(1) : "n/a"})`);
  console.log(`   >>> timeline declares for ${shot.slotId}: ${ap?.assetId} (${ap?.localName})\n`);
}