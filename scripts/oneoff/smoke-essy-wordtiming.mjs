// PRODUCTION-PATH SMOKE TEST assembler: builds a controlled ~72.5 s smoke
// episode (projects/SMOKE-ESSY-WT/) from ESSY-0003 blocks N001–N003 so the
// CANONICAL pipeline (build-narration-master -> render-full-draft ->
// video:subtitle-review, shared subtitle timeline + QA gate) can be exercised
// end-to-end without touching published masters or approval state.
//
// ESSY-0003 material is used read-only; source video paths point at the
// existing sourcing/downloads files. Writes ONLY under projects/SMOKE-ESSY-WT/.
//
// Usage: node scripts/oneoff/smoke-essy-wordtiming.mjs
import {copyFile, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const factoryRoot = process.cwd();
const source = path.join(factoryRoot, "projects", "ESSY-0003");
const smoke = path.join(factoryRoot, "projects", "SMOKE-ESSY-WT");
const blockIds = ["sentence-001", "sentence-002", "sentence-003"];

await rm(smoke, {recursive: true, force: true});
await mkdir(path.join(smoke, "audio"), {recursive: true});
await mkdir(path.join(smoke, "temp"), {recursive: true});

const timeline = JSON.parse(await readFile(path.join(source, "assembly-timeline.json"), "utf8"));
const blocks = timeline.blocks.filter((b) => blockIds.includes(b.sentenceId));
const shots = timeline.shots.filter((s) => blockIds.includes(s.blockId));
const trimmed = {
  ...timeline,
  episode: "SMOKE-ESSY-WT",
  blocks,
  shots: shots.map((s, i) => ({...s, index: i})),
  plannedDurationSec: Math.round(blocks.at(-1).endSec),
  note: "SMOKE: ESSY-0003 N001-N003 controlled production-path validation",
};
for (const id of blockIds) {
  await copyFile(path.join(source, "audio", `${id}.mp3`), path.join(smoke, "audio", `${id}.mp3`));
  await copyFile(path.join(source, "temp", `${id}.vtt`), path.join(smoke, "temp", `${id}.vtt`));
  await copyFile(path.join(source, "temp", `${id}.words.json`), path.join(smoke, "temp", `${id}.words.json`));
}
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
manifest.episode = "SMOKE-ESSY-WT";
manifest.sentenceCount = blockIds.length;
manifest.audio = manifest.audio.filter((a) => blockIds.includes(a.id));
// New-generation policy: this smoke exercises the REQUIRING pipeline.
manifest.subtitleTiming = {policy: "word-boundary-required", schemaVersion: "1.0"};
manifest.smoke = {
  source: "ESSY-0003 N001-N003",
  purpose: "canonical production-path word-boundary subtitle timing validation",
};
await writeFile(path.join(smoke, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(path.join(smoke, "assembly-timeline.json"), `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");

// Cold-open parity: copy the REAL approved ESSY-0003 production package so the
// canonical review/final metadata consumers see coldOpenExperiment.titleCards
// (blockId n002) + suppressBlockNarration. Without it, the N002 title-card
// block is narrated and burned as subtitles — the ESSY-0003 v1 regression.
await mkdir(path.join(factoryRoot, "projects", "_drafts", "SMOKE-ESSY-WT"), {recursive: true});
await copyFile(
  path.join(factoryRoot, "projects", "_drafts", "ESSY-0003", "production-package.json"),
  path.join(factoryRoot, "projects", "_drafts", "SMOKE-ESSY-WT", "production-package.json"),
);
console.log(`Smoke episode ready: ${smoke}`);
console.log(`blocks=${blocks.length} shots=${shots.length} duration=${blocks.at(-1).endSec}s policy=word-boundary-required`);
