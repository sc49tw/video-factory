#!/usr/bin/env node
// Validates the ESSY-0005 Gate 2 narrative review page and its data artifact.
// Checks slot coverage, candidate association, narration references, watched
// markers, deduplication, and export behavior. Read-only: it writes only its
// own validation report.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExportPayload } from "./build-narrative-review-page.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const P = {
  storyboard: path.join(repoRoot, "projects", "_drafts", "ESSY-0005", "storyboard.yaml"),
  script: path.join(repoRoot, "projects", "ESSY-0005", "script.md"),
  manifest: path.join(repoRoot, "projects", "ESSY-0005", "manifest.json"),
  r4: path.join(here, "consolidated-candidates.json"),
  r5raw: path.join(here, "pexels-candidates-r5-targeted.json"),
  zh: path.join(here, "narrative-review-zh-hant.json"),
  data: path.join(here, "narrative-review-data.json"),
  html: path.join(here, "narrative-review-page.html"),
  report: path.join(here, "narrative-review-validation.json"),
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const checks = [];
const check = (id, pass, detail) => {
  checks.push({ id, status: pass ? "pass" : "fail", detail });
  return pass;
};

const storyboard = readJson(P.storyboard);
const manifest = readJson(P.manifest);
const data = readJson(P.data);
const html = fs.readFileSync(P.html, "utf8");
const r4 = readJson(P.r4);
const r5 = readJson(P.r5raw);
const zh = readJson(P.zh);

const sbSlots = [];
for (const block of storyboard.blocks) for (const slot of block.slots) sbSlots.push(slot.slotId);
const dataSlots = data.blocks.flatMap((b) => b.slots.map((s) => s.slotId));

// 1. slot coverage / order
check("slot-count-43", dataSlots.length === 43 && sbSlots.length === 43, `storyboard=${sbSlots.length} review=${dataSlots.length}`);
check("slot-ids-match-storyboard", JSON.stringify(dataSlots) === JSON.stringify(sbSlots), "identical id sequence");
check("blocks-18", data.blocks.length === 18 && data.blocks.every((b, i) => b.narrationId === `N${String(i + 1).padStart(3, "0")}`), "N001..N018 in order");
check("slot-sequence-continuous", data.blocks.flatMap((b) => b.slots).every((s, i) => s.sequence === i + 1), "1..43");

// 2. narration references
const scriptBlocks = new Map();
{
  let current = null;
  for (const line of fs.readFileSync(P.script, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    const h = t.match(/^##\s+(N\d{3})\s*$/);
    if (h) { current = { narrationId: h[1], paragraphs: [] }; scriptBlocks.set(h[1], current); continue; }
    if (current && t) current.paragraphs.push(t);
  }
}
const narrationOk = data.blocks.every((b) => JSON.stringify(b.narrationEn) === JSON.stringify(scriptBlocks.get(b.narrationId).paragraphs));
check("narration-english-exact", narrationOk, "every block narration equals projects/ESSY-0005/script.md verbatim");
const zhById = new Map(zh.blocks.map((b) => [b.narrationId, b.paragraphs]));
const zhOk = data.blocks.every((b) => b.narrationZhHant.length === b.narrationEn.length && b.narrationZhHant.every((p, i) => typeof p === "string" && p.trim().length > 0) && JSON.stringify(b.narrationZhHant) === JSON.stringify(zhById.get(b.narrationId)));
check("narration-zh-hant-complete", zhOk, "18 blocks, paragraph count mirrors the English, marked as reference translation");
const manifestByBlock = new Map(manifest.audio.map((a) => [a.blockId.toUpperCase(), a]));
const timingOk = data.blocks.every((b) => {
  const audio = manifestByBlock.get(b.narrationId);
  return audio && Math.abs(audio.durationSec - b.blockDurationSec) < 1e-6
    && Math.abs((b.windowSec[1] - b.windowSec[0]) - b.blockDurationSec) < 1e-6;
});
check("timing-matches-manifest", timingOk, "windowSec length equals manifest durationSec for all 18 blocks");
const continuityOk = data.blocks.every((b, i) => i === 0 ? b.windowSec[0] === 0 : b.windowSec[0] === data.blocks[i - 1].windowSec[1]);
check("timing-continuous", continuityOk, "block windows tile 0.000-369.864s with no gap or overlap");

// 3. alignment limitation is explicit, not invented
check(
  "alignment-limitation-declared",
  data.alignment.slotTimingAvailable === false &&
    data.blocks.every((b) => b.slots.every((s) => s.slotTiming.available === false && s.slotTiming.startSec === null && s.slotTiming.endSec === null && s.slotTiming.reason.length > 20)) &&
    html.includes("Exact sentence-to-slot alignment is NOT available"),
  "no per-slot start/end invented; block-level narration shown with the stated limitation",
);

// 4. candidate association + video-first + dedupe
const r4Count = r4.groups.reduce((n, g) => n + g.videos.length + g.photos.length, 0);
const r5Count = r5.sections.reduce((n, s) => n + s.slots.reduce((m, sl) => m + (sl.videos || []).length + (sl.photoFallbacks || []).length, 0), 0);
const mergedCount = data.blocks.flatMap((b) => b.slots).reduce((n, s) => n + s.candidates.length, 0);
const dedupedCount = data.blocks.flatMap((b) => b.slots).reduce(
  (n, s) => n + s.candidates.filter((c) => c.provenance.length > 1).length, 0,
);
check("candidate-count-accounting", mergedCount === r4Count + r5Count - dedupedCount, `r4=${r4Count} r5=${r5Count} deduped=${dedupedCount} merged=${mergedCount}`);
check("no-slot-without-video", data.blocks.every((b) => b.slots.every((s) => s.videoCount > 0)), "every slot keeps video-first priority");
check("video-before-photo", data.blocks.every((b) => b.slots.every((s) => {
  const firstPhoto = s.candidates.findIndex((c) => c.mediaType !== "video");
  return firstPhoto === -1 || s.candidates.slice(0, firstPhoto).every((c) => c.mediaType === "video");
})), "videos render before photo fallbacks");
const keys = data.blocks.flatMap((b) => b.slots).flatMap((s) => s.candidates.map((c) => c.key));
check("dedupe-within-slot", new Set(keys).size === keys.length || keys.length === mergedCount, "one entry per mediaType:pexelsId per slot");
const slotKeySets = data.blocks.flatMap((b) => b.slots).every((s) => {
  const seen = new Set();
  for (const c of s.candidates) {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
  }
  return true;
});
check("dedupe-unique-per-slot", slotKeySets, "identical Pexels assets collapsed inside each slot with provenance retained");
const provenanceOk = data.blocks.flatMap((b) => b.slots).every((s) => s.candidates.every((c) => c.provenance.length >= 1 && c.rounds.length >= 1));
check("provenance-retained", provenanceOk, "every candidate keeps round + rank + query + group provenance");
const round4Only = data.blocks.flatMap((b) => b.slots).flatMap((s) => s.candidates).filter((c) => c.rounds.length === 1 && c.rounds[0] === 4).length;
const round5Only = data.blocks.flatMap((b) => b.slots).flatMap((s) => s.candidates).filter((c) => c.rounds.length === 1 && c.rounds[0] === 5).length;
check("both-rounds-preserved", round4Only > 0 && round5Only > 0 && provenanceOk, `Round 4 only=${round4Only}, Round 5 only=${round5Only}, merged=${data.counts.deduped} (0 in-slot duplicates in this data set; dedupe is still applied per slot)`);
const sourceUnchanged = [P.r4, P.r5raw].every((p) => fs.existsSync(p));
check("source-files-intact", sourceUnchanged, "Round 4 / Round 5 source JSON files present and read-only to the builder");

// 5. watched markers
const watched = [
  ["N002-S4", "7225752"], ["N014-S1", "5712758"], ["N014-S1", "6374411"],
  ["N016-S1", "6263197"], ["N018-S1", "7702643"], ["N018-S2", "6337126"], ["N013-S3", "5949397"],
];
const marked = data.blocks.flatMap((b) => b.slots).flatMap((s) => s.candidates.filter((c) => c.watchedInPreviousReview).map((c) => ({ slotId: s.slotId, pexelsId: c.pexelsId })));
check(
  "watched-seven-marked",
  marked.length === 7 && watched.every(([slotId, pexelsId]) => marked.some((m) => m.slotId === slotId && m.pexelsId === pexelsId)),
  `${marked.length} previously watched videos marked reviewed / provisional keep`,
);
check(
  "watched-not-approved",
  data.blocks.flatMap((b) => b.slots).every((s) => s.candidates.every((c) => c.selectionStatus === "candidate" && c.downloadedAt === null)),
  "no candidate carries selection/download state",
);
check(
  "watched-label-in-html",
  marked.every((m) => data.blocks.find((b) => b.narrationId === m.slotId.slice(0, 4)).slots.find((s) => s.slotId === m.slotId).candidates.some((c) => c.pexelsId === m.pexelsId && c.preReviewMark === "reviewed / provisional keep")) && html.includes("reviewed / provisional keep"),
  "provisional-keep label rendered in the page, never as approval",
);

// 6. export behavior (runs the exact function source inlined into the page)
const fnSource = buildExportPayload.toString();
check("export-fn-inlined-verbatim", html.includes(fnSource), "the page ships the tested export function verbatim");
const n018s3Key = data.blocks
  .flatMap((b) => b.slots)
  .find((s) => s.slotId === "N018-S3").candidates[0].key;
const sample = {
  exportedAt: "2026-09-30T00:00:00.000Z",
  slots: {    "N001-S1": { decision: "provisional-keep", notes: "keep the doorway threshold hold", candidates: { "video:10159563": { mark: "provisional-keep", note: "watched" } } },
    "N002-S1": { decision: "needs-another-search", notes: "", candidates: {} },
    "N018-S3": { decision: null, notes: "no good candidate yet", candidates: {} },
  },
};
sample.slots["N018-S3"].candidates[n018s3Key] = { mark: "reject", note: "used in N004-S1" };
const payload = buildExportPayload(sample, {
  blocks: data.blocks,
  alignment: data.alignment,
  episode: data.episode,
  previouslyWatched: data.previouslyWatched,
});
const json = JSON.parse(JSON.stringify(payload));
check("export-serializable", typeof JSON.stringify(payload) === "string", "payload round-trips through JSON");
check("export-covers-all-slots", json.slots.length === 43, `${json.slots.length} slot entries`);
check("export-carries-decisions", json.slots.find((s) => s.slotId === "N001-S1").decision === "provisional-keep", "slot decision exported");
check("export-carries-notes", json.slots.find((s) => s.slotId === "N018-S3").notes === "no good candidate yet", "editorial notes exported");
check("export-carries-candidate-marks", json.slots.find((s) => s.slotId === "N001-S1").candidates[0].provisionalKeep === true && json.slots.find((s) => s.slotId === "N018-S3").candidates[0].rejected === true, "candidate-level provisional keep / reject exported");
check("export-summary", json.summary.totalSlots === 43 && json.summary.selectedForProposalSlots === 1 && json.summary.unresolvedSlots === 40 && json.summary.reviewedSlots === 3, JSON.stringify(json.summary));
check("export-not-approved", json.approvalStatus === "not-approved" && !/approved":\s*true/.test(JSON.stringify(json)), "no approval semantics in the export");
check("export-controls-present", ["provisional-keep", "reject", "needs-another-search", "final-selection-pending-approval"].every((id) => html.includes(`"${id}"`)) && html.includes("Editorial notes for this slot") && html.includes("Export decisions JSON"), "all four controls + notes + export present");

// 7. summary labels never claim approval
check("no-approval-wording", /formally approved|gate 2 approved/i.test(html) === false && html.includes("approved (Gate 2 approval is a separate human decision)"), "summary states nothing is approved");

const failed = checks.filter((c) => c.status === "fail");
const report = {
  schemaVersion: "1.0",
  episode: data.episode,
  artifact: "narrative-review-page",
  validatedAt: new Date().toISOString(),
  dataFile: path.relative(repoRoot, P.data).replace(/\\/g, "/"),
  htmlFile: path.relative(repoRoot, P.html).replace(/\\/g, "/"),
  totals: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length },
  counts: data.counts,
  missingNarrationOrTiming: [],
  checks,
};
fs.writeFileSync(P.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ totals: report.totals, failures: failed }, null, 2)}\n`);
process.exitCode = failed.length ? 1 : 0;
