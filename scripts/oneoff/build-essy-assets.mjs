// Builds the ASSETS stage handoff artifacts for ESSY draft episodes.
// Creates:
//   projects/_drafts/<EP>/assets/manifest.json   (ASSETS stage output)
//   projects/<EP>/source/lesson.json              (renderer input, from production package)
//   projects/<EP>/visual-plan.json                (renderer input, from storyboard + provenance)
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const factoryRoot = process.cwd();
const episode = process.argv[2];
if (!episode || !/^ESSY-\d{4}$/.test(episode)) {
  console.error("Usage: node scripts/oneoff/build-essy-assets.mjs ESSY-0003");
  process.exit(1);
}

const draftRoot = path.join(factoryRoot, "projects", "_drafts", episode);
const projectRoot = path.join(factoryRoot, "projects", episode);

// --- 1. Read approved production-package.json and provenance ---
const pkg = JSON.parse(await readFile(path.join(draftRoot, "production-package.json"), "utf8"));
const storyboard = JSON.parse(await readFile(path.join(draftRoot, "storyboard.yaml"), "utf8"));
const provenance = JSON.parse(await readFile(path.join(projectRoot, "sourcing", "downloads", "provenance.json"), "utf8"));

// --- 2. Create assets/manifest.json (ASSETS stage output) ---
const bySlot = new Map();
for (const item of provenance.items) {
  if (/^N\d{3}-S\d+$/.test(item.slotId)) bySlot.set(item.slotId, item);
}

const slotToAsset = [];
for (const block of storyboard.blocks) {
  for (const slot of block.slots) {
    const item = bySlot.get(slot.slotId);
    if (!item) throw new Error(`Unresolved slot: ${slot.slotId}`);
    slotToAsset.push({
      slotId: slot.slotId,
      narrationId: block.narrationId,
      familyId: item.familyId ?? null,
      asset: {id: item.id, mediaType: item.mediaType, localPath: item.localPath, sha256: item.sha256},
      selectionNote: item.selectionNote ?? null,
      intentionalMotifReuse: item.intentionalMotifReuse ?? false,
      editorialFunction: slot.editorialFunction,
      visualIntent: slot.visualIntent,
      targetDurationSec: slot.targetDurationSec,
    });
  }
}

await mkdir(path.join(draftRoot, "assets"), {recursive: true});
const manifest = {
  schemaVersion: "1.0",
  episode,
  draftId: episode,
  createdAt: new Date().toISOString(),
  totalSlots: slotToAsset.length,
  mapping: slotToAsset,
  provenanceFile: "projects/" + episode + "/sourcing/downloads/provenance.json",
  gate: {
    allSlotsCovered: bySlot.size === 101,
    distinctAssets: new Set(provenance.items.map(i => i.id)).size,
    intentionalReprises: provenance.items.filter(i => i.intentionalMotifReuse).length,
  },
};
await writeFile(
  path.join(draftRoot, "assets", "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);
console.log(`Wrote assets/manifest.json: ${manifest.totalSlots} slots, ${manifest.gate.distinctAssets} distinct assets, ${manifest.gate.intentionalReprises} reprises`);

// --- 3. Create source/lesson.json (renderer input) ---
await mkdir(path.join(projectRoot, "source"), {recursive: true});
const lesson = {
  schemaVersion: "1.0",
  episode,
  series: pkg.series,
  subtype: pkg.subtype,
  title: pkg.title,
  language: pkg.language,
  renderMode: pkg.renderMode,
  voice: pkg.voice,
  sections: pkg.sections.map((section) => ({
    id: section.id,
    heading: section.heading ?? section.id.toUpperCase(),
    narration: section.narration.map((block) => ({
      id: block.id,
      text: block.text,
      pauseAfterSec: block.pauseAfterSec ?? 0.6,
    })),
  })),
};
await writeFile(
  path.join(projectRoot, "source", "lesson.json"),
  JSON.stringify(lesson, null, 2) + "\n",
  "utf8",
);
console.log(`Wrote source/lesson.json: ${lesson.sections.length} sections`);

// --- 4. Create visual-plan.json (rendering plan with real asset slots) ---
const vpShots = [];
for (const entry of slotToAsset) {
  const blockId = entry.narrationId;
  const section = pkg.sections.find(s => s.id === blockId);
  const narrationBlock = section?.narration?.find(b => b.id === blockId);
  vpShots.push({
    sectionId: blockId,
    slotId: entry.slotId,
    startSec: 0,
    endSec: entry.targetDurationSec ?? 7,
    cues: [],
    asset: entry.asset.id,
    mediaType: entry.asset.mediaType,
  });
}
const visualPlan = {
  schemaVersion: "1.0",
  episode,
  strategy: "audio-master-real-assets",
  shots: vpShots,
};
await writeFile(
  path.join(projectRoot, "visual-plan.json"),
  JSON.stringify(visualPlan, null, 2) + "\n",
  "utf8",
);
console.log(`Wrote visual-plan.json: ${vpShots.length} shots`);
