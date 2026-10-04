// Deterministic slot-level render verification.
//
// For every requested probe time in a rendered MP4 it:
//   1. resolves the slot window from the AUTHORITATIVE assembly-timeline.json,
//   2. re-renders every candidate source asset through the IDENTICAL ffmpeg
//      chain the shot renderer uses, sampled at the SAME local in-shot offset,
//   3. reports mean absolute luma difference between the actual rendered frame
//      and each candidate.
//
// A near-zero MAD against exactly one candidate proves which source pixels are
// actually visible in the delivered file, independent of any metadata.
//
// Usage:
//   node scripts/_verify-shot-source.mjs --episode ESSY-0005 \
//     --video output/ESSY-0005/ESSY-0005-review-540p-subtitled-v2.mp4 \
//     --times 358,365,369,373 --offset 0 --json
import {readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";

const W = 64;
const H = 36; // 16:9 so the crop/scale chain is reproduced at the right aspect

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

// Identical chain to scripts/render-full-draft.mjs, then the 540p review scale.
const SHOT_CHAIN = `scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,fps=30,format=yuv420p`;
const REVIEW_CHAIN = `scale=${W}:${H}:flags=lanczos`;

async function lumaFrame(file, seekSec, chain) {
  const args = ["-v", "error"];
  if (seekSec !== null) args.push("-ss", String(seekSec));
  args.push("-i", file, "-frames:v", "1", "-vf", `${chain},scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-");
  const buf = await run("ffmpeg", args, true);
  return buf.subarray(0, W * H);
}

const mad = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};

const episode = arg("episode") ?? "ESSY-0005";
const video = arg("video");
const offsetSec = Number(arg("offset") ?? 0);
const times = (arg("times") ?? "").split(",").map(Number).filter(Number.isFinite);

const timeline = JSON.parse(await readFile(`projects/${episode}/assembly-timeline.json`, "utf8"));
const assetMap = JSON.parse(await readFile(`projects/${episode}/sourcing/approved-slot-asset-map.json`, "utf8"));

// The approved asset map nests per-shot records under several keys; collect any
// object that carries a slotId so lookups never depend on the container shape.
const approved = new Map();
const collect = (node, out) => {
  if (Array.isArray(node)) return node.forEach((n) => collect(n, out));
  if (node && typeof node === "object") {
    if (typeof node.slotId === "string" && (node.assetId || node.localName)) out.set(node.slotId, node);
    else Object.values(node).forEach((v) => collect(v, out));
  }
};
collect(assetMap, approved);

const shots = [];
for (const b of timeline.blocks ?? []) for (const s of b.shots ?? []) shots.push({...s, sentenceId: b.sentenceId});

const results = [];
for (const t of times) {
  const tl = t - offsetSec;
  const shot = shots.find((s) => tl >= s.absoluteStartSec && tl < s.absoluteEndSec);
  if (!shot) {
    results.push({timeSec: t, error: `no shot covers ${tl.toFixed(3)}s`});
    continue;
  }
  const local = Number((tl - shot.absoluteStartSec).toFixed(3));
  const videoFrame = await lumaFrame(video, t, REVIEW_CHAIN);

  // Candidates: the timeline's declared source plus every approved local file
  // for this slot plus the sibling slots of the same block (repetition check).
  const siblingSlotIds = [...new Set(shots.filter((s) => s.sentenceId === shot.sentenceId).map((s) => s.slotId))];
  const candidates = [];
  const addCandidate = (label, file) => {
    if (file && !candidates.some((c) => c.file === file)) candidates.push({label, file});
  };
  addCandidate(`${shot.slotId}:timeline`, shot.sourcePath);
  const ap = approved.get(shot.slotId);
  if (ap?.localName) addCandidate(`${shot.slotId}:approved-map`, path.join(`projects/${episode}/sourcing/downloads`, ap.localName));
  for (const sid of siblingSlotIds) {
    const sap = approved.get(sid);
    if (sap?.localName) addCandidate(`${sid}:approved-map`, path.join(`projects/${episode}/sourcing/downloads`, sap.localName));
  }
  // Also every N0xx download file, so a stale superseded download cannot hide.
  for (const sid of siblingSlotIds) {
    const rec = approved.get(sid);
    if (!rec?.localName) continue;
    const stem = sid.replace(/-S\d+$/, "");
  }

  const scored = [];
  for (const c of candidates) {
    try {
      const f = await lumaFrame(c.file, local, SHOT_CHAIN);
      scored.push({label: c.label, file: path.basename(c.file), meanAbsLumaDiff: Number(mad(videoFrame, f).toFixed(3))});
    } catch (error) {
      scored.push({label: c.label, file: path.basename(c.file), error: error.message.slice(0, 160)});
    }
  }
  scored.sort((a, b) => (a.meanAbsLumaDiff ?? 1e9) - (b.meanAbsLumaDiff ?? 1e9));
  const best = scored[0];
  const runnerUp = scored[1];
  results.push({
    timeSec: t,
    timelineTimeSec: Number(tl.toFixed(3)),
    slotFromTimeline: shot.slotId,
    slotAbsoluteWindow: [shot.absoluteStartSec, shot.absoluteEndSec],
    localOffsetInShotSec: local,
    timelineDeclaredSource: path.basename(shot.sourcePath),
    approvedAssetId: ap?.assetId ?? null,
    candidates: scored,
    verdict: best ? best.label : null,
    marginToRunnerUp: runnerUp && best ? Number((runnerUp.meanAbsLumaDiff - best.meanAbsLumaDiff).toFixed(3)) : null,
  });
}

const out = {episode, video, offsetSec, times, results};
if (argv.includes("--json")) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`Rendered-source verification — ${episode}`);
  console.log(`video: ${video}\n`);
  for (const r of results) {
    if (r.error) { console.log(`t=${r.timeSec}s  ERROR ${r.error}`); continue; }
    console.log(`t=${r.timeSec}s -> timeline ${r.timelineTimeSec}s = ${r.slotFromTimeline} ` +
      `(window ${r.slotAbsoluteWindow[0]}-${r.slotAbsoluteWindow[1]}s, local +${r.localOffsetInShotSec}s)`);
    console.log(`   timeline source: ${r.timelineDeclaredSource} | approved asset: ${r.approvedAssetId}`);
    for (const c of r.candidates) {
      console.log(`   ${c.error ? "     ERR" : String(c.meanAbsLumaDiff).padStart(7)}  ${c.label}${c === r.candidates[0] ? "   <== MATCH" : ""}${c.error ? ` ${c.error}` : ""}`);
    }
    console.log(`   VERDICT: ${r.verdict} (margin ${r.marginToRunnerUp})\n`);
  }
}