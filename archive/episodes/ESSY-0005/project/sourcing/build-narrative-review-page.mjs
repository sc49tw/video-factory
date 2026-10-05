#!/usr/bin/env node
// ESSY-0005 Gate 2 narrative review page builder.
// SEARCH/REVIEW ONLY: merges Round 4 + Round 5 candidate data, attaches the
// approved English narration per narration block, a clearly marked zh-Hant
// reference translation, approved storyboard fields, and the seven
// already-watched Round 5 videos as "reviewed / provisional keep".
// Nothing is selected, approved, downloaded, or written to workflow state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const sourcingDir = here;
const episodeDir = path.join(repoRoot, "projects", "ESSY-0005");

const PATHS = {
  storyboard: path.join(repoRoot, "projects", "_drafts", "ESSY-0005", "storyboard.yaml"),
  script: path.join(episodeDir, "script.md"),
  manifest: path.join(episodeDir, "manifest.json"),
  zhHant: path.join(sourcingDir, "narrative-review-zh-hant.json"),
  round4: path.join(sourcingDir, "consolidated-candidates.json"),
  round5Raw: path.join(sourcingDir, "pexels-candidates-r5-targeted.json"),
  round5Consolidated: path.join(sourcingDir, "consolidated-r5-targeted-candidates.json"),
  dataOut: path.join(sourcingDir, "narrative-review-data.json"),
  htmlOut: path.join(sourcingDir, "narrative-review-page.html"),
};

// Videos watched in the previous Round 5 review. Marked as reviewed /
// provisional keep only - never as approved.
const PREVIOUSLY_WATCHED = [
  { pexelsId: "7225752", slotId: "N002-S4" },
  { pexelsId: "5712758", slotId: "N014-S1" },
  { pexelsId: "6374411", slotId: "N014-S1" },
  { pexelsId: "6263197", slotId: "N016-S1" },
  { pexelsId: "7702643", slotId: "N018-S1" },
  { pexelsId: "6337126", slotId: "N018-S2" },
  { pexelsId: "5949397", slotId: "N013-S3" },
];

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function parseScript(md) {
  const blocks = new Map();
  let current = null;
  for (const rawLine of md.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = line.match(/^##\s+(N\d{3})\s*$/);
    if (heading) {
      current = { narrationId: heading[1], paragraphs: [] };
      blocks.set(heading[1], current);
      continue;
    }
    if (!current || !line) continue;
    current.paragraphs.push(line);
  }
  return blocks;
}

function pexelsIdOf(candidate) {
  return String(candidate.id || "").replace(/^pexels-(video|photo)-/, "");
}

function candidateKey(mediaType, pexelsId) {
  return `${mediaType}:${pexelsId}`;
}

export function buildExportPayload(state, meta) {
  const slots = [];
  for (const block of meta.blocks) {
    for (const slot of block.slots) {
      const entry = (state && state.slots && state.slots[slot.slotId]) || {};
      const candidateMarks = entry.candidates || {};
      const candidates = [];
      for (const candidate of slot.candidates) {
        const mark = candidateMarks[candidate.key] || {};
        if (!mark.mark && !(mark.note || "").trim()) continue;
        candidates.push({
          key: candidate.key,
          pexelsId: candidate.pexelsId,
          mediaType: candidate.mediaType,
          rounds: candidate.rounds,
          provisionalKeep: mark.mark === "provisional-keep",
          rejected: mark.mark === "reject",
          note: (mark.note || "").trim(),
        });
      }
      const provisionalKeeps = candidates.filter((c) => c.provisionalKeep).length;
      slots.push({
        slotId: slot.slotId,
        narrationId: block.narrationId,
        order: slot.order,
        decision: entry.decision || null,
        notes: (entry.notes || "").trim(),
        candidates,
        provisionalKeepCount: provisionalKeeps,
        selectedForProposal: provisionalKeeps > 0,
      });
    }
  }
  const reviewed = slots.filter((s) => s.decision || s.notes || s.candidates.length > 0);
  const unresolved = slots.filter((s) => !s.decision && !s.notes && s.candidates.length === 0);
  const selectedForProposal = slots.filter((s) => s.selectedForProposal);
  return {
    schemaVersion: "1.0",
    episode: meta.episode,
    artifact: "narrative-review-decisions",
    mode: "gate2-narrative-review",
    approvalStatus: "not-approved",
    note: "Editorial review decisions captured in the local review page. Nothing here is a Gate 2 approval, a selection, or a download; every selection remains pending human approval.",
    exportedAt: (state && state.exportedAt) || null,
    alignment: meta.alignment,
    summary: {
      totalSlots: slots.length,
      reviewedSlots: reviewed.length,
      unresolvedSlots: unresolved.length,
      selectedForProposalSlots: selectedForProposal.length,
      provisionalKeepSlots: slots.filter((s) => s.decision === "provisional-keep").length,
      rejectSlots: slots.filter((s) => s.decision === "reject").length,
      needsAnotherSearchSlots: slots.filter((s) => s.decision === "needs-another-search").length,
      finalSelectionPendingSlots: slots.filter((s) => s.decision === "final-selection-pending-approval").length,
      candidateProvisionalKeeps: slots.reduce((n, s) => n + s.provisionalKeepCount, 0),
      candidateRejects: slots.reduce((n, s) => n + s.candidates.filter((c) => c.rejected).length, 0),
      previouslyWatchedProvisionalKeeps: meta.previouslyWatched.length,
    },
    slots,
  };
}

function collectRoundCandidates() {
  const perSlot = new Map();
  const add = (candidate, round, sourceFile, extra = {}) => {
    const slotId = candidate.slotId;
    if (!perSlot.has(slotId)) perSlot.set(slotId, new Map());
    const pexelsId = pexelsIdOf(candidate);
    const key = candidateKey(candidate.mediaType, pexelsId);
    const bucket = perSlot.get(slotId);
    if (!bucket.has(key)) {
      bucket.set(key, {
        key,
        pexelsId,
        mediaType: candidate.mediaType,
        role: candidate.role,
        creator: candidate.creator,
        creatorUrl: candidate.creatorUrl,
        license: candidate.license,
        sourceUrl: candidate.sourceUrl,
        previewUrl: candidate.previewUrl || candidate.posterUrl || null,
        videoFileUrl: candidate.videoFileUrl || null,
        videoFileQuality: candidate.videoFileQuality || "",
        fullResUrl: candidate.fullResUrl || null,
        altText: candidate.altText || null,
        durationSec: candidate.durationSec ?? null,
        width: candidate.width ?? null,
        height: candidate.height ?? null,
        orientation: candidate.orientation || null,
        selectionStatus: candidate.selectionStatus || "candidate",
        downloadedAt: candidate.downloadedAt ?? null,
        rounds: [],
        provenance: [],
        deduped: false,
        ...extra,
      });
    }
    const entry = bucket.get(key);
    entry.deduped = true;
    if (!entry.rounds.includes(round)) entry.rounds.push(round);
    entry.provenance.push({
      round,
      sourceFile,
      rank: candidate.rank ?? null,
      query: candidate.foundByQuery ?? candidate.searchQuery ?? null,
      groupId: extra.groupId ?? null,
    });
    if (round === 5) {
      // Round 5 is the newer search: prefer its richer media metadata.
      entry.previewUrl = candidate.previewUrl || candidate.posterUrl || entry.previewUrl;
      entry.videoFileUrl = candidate.videoFileUrl || entry.videoFileUrl;
      entry.durationSec = candidate.durationSec ?? entry.durationSec;
      entry.width = candidate.width ?? entry.width;
      entry.height = candidate.height ?? entry.height;
      entry.altText = candidate.altText || entry.altText;
    }
    return entry;
  };

  const r4 = readJson(PATHS.round4);
  for (const group of r4.groups) {
    for (const candidate of [...group.videos, ...group.photos]) {
      add(candidate, 4, path.basename(PATHS.round4), { groupId: group.groupId, roundLabel: "Round 4" });
    }
  }

  const r5 = readJson(PATHS.round5Raw);
  for (const section of r5.sections) {
    for (const slot of section.slots) {
      const searchQuery = slot.searchQuery || null;
      for (const candidate of [...(slot.videos || []), ...(slot.photoFallbacks || [])]) {
        const withQuery = { ...candidate, foundByQuery: candidate.foundByQuery || searchQuery };
        add(withQuery, 5, path.basename(PATHS.round5Raw), {
          groupId: section.sectionId,
          roundLabel: "Round 5",
        });
      }
    }
  }

  return perSlot;
}

function buildData() {
  const storyboard = readJson(PATHS.storyboard);
  const manifest = readJson(PATHS.manifest);
  const scriptBlocks = parseScript(fs.readFileSync(PATHS.script, "utf8"));
  const zh = readJson(PATHS.zhHant);
  const zhByBlock = new Map(zh.blocks.map((b) => [b.narrationId, b.paragraphs]));
  const candidates = collectRoundCandidates();

  const manifestByBlock = new Map(manifest.audio.map((a) => [a.blockId.toUpperCase(), a]));

  const blocks = storyboard.blocks.map((block) => {
    const narrationId = block.narrationId;
    const scriptBlock = scriptBlocks.get(narrationId);
    const audio = manifestByBlock.get(narrationId);
    const zhParagraphs = zhByBlock.get(narrationId) || [];
    return {
      narrationId,
      windowSec: block.windowSec,
      blockDurationSec: audio ? audio.durationSec : block.windowSec[1] - block.windowSec[0],
      audioPath: audio ? audio.path : null,
      vttPath: `projects/ESSY-0005/temp/sentence-${String(
        storyboard.blocks.indexOf(block) + 1,
      ).padStart(3, "0")}.vtt`,
      visualArc: block.visualArc,
      narrationEn: scriptBlock ? scriptBlock.paragraphs : [],
      narrationZhHant: zhParagraphs,
      translationNote: zh.note,
      slots: block.slots.map((slot, index) => {
        const bucket = candidates.get(slot.slotId) || new Map();
        const list = [...bucket.values()];
        const videos = list.filter((c) => c.mediaType === "video");
        const photos = list.filter((c) => c.mediaType !== "video");
        videos.sort((a, b) => a.rounds[0] - b.rounds[0] || a.pexelsId.localeCompare(b.pexelsId));
        photos.sort((a, b) => a.rounds[0] - b.rounds[0] || a.pexelsId.localeCompare(b.pexelsId));
        const ordered = [...videos, ...photos].map((candidate) => {
          const watched = PREVIOUSLY_WATCHED.find(
            (w) => w.pexelsId === candidate.pexelsId && w.slotId === slot.slotId,
          );
          return {
            ...candidate,
            watchedInPreviousReview: Boolean(watched),
            preReviewMark: watched ? "reviewed / provisional keep" : null,
          };
        });
        return {
          slotId: slot.slotId,
          order: `${narrationId}-${index + 1}`,
          slotIndexInBlock: index + 1,
          slotCountInBlock: block.slots.length,
          slotTiming: {
            startSec: null,
            endSec: null,
            available: false,
            reason:
              "The approved storyboard records per-narration-block windowSec only; it carries no per-slot start/end. Block window shown instead - no sentence-to-slot boundary was invented.",
          },
          editorialFunction: slot.editorialFunction,
          visualIntent: slot.visualIntent,
          avoid: slot.avoid,
          searchQuery: slot.query || null,
          videoCount: videos.length,
          photoFallbackCount: photos.length,
          candidates: ordered,
        };
      }),
    };
  });

  const flatSlots = blocks.flatMap((b) => b.slots);
  flatSlots.forEach((slot, index) => {
    slot.sequence = index + 1;
  });

  return {
    schemaVersion: "1.0",
    episode: storyboard.episode,
    title: manifest.title,
    mode: "gate2-narrative-review-no-selection",
    generatedAt: new Date().toISOString(),
    note: "Gate 2 review aid. Search + review only: nothing is selected, approved, or downloaded, and no workflow state is written. Decisions live in the local review page and are exported as JSON by the reviewer.",
    sources: {
      storyboard: path.relative(repoRoot, PATHS.storyboard).replace(/\\/g, "/"),
      script: path.relative(repoRoot, PATHS.script).replace(/\\/g, "/"),
      manifest: path.relative(repoRoot, PATHS.manifest).replace(/\\/g, "/"),
      round4Candidates: path.relative(repoRoot, PATHS.round4).replace(/\\/g, "/"),
      round5Candidates: path.relative(repoRoot, PATHS.round5Raw).replace(/\\/g, "/"),
      round5Consolidated: path.relative(repoRoot, PATHS.round5Consolidated).replace(/\\/g, "/"),
      translation: path.relative(repoRoot, PATHS.zhHant).replace(/\\/g, "/"),
    },
    alignment: {
      slotTimingAvailable: false,
      blockTimingAvailable: true,
      timingSource: "edge-tts word-boundary + storyboard windowSec (audio is the master timeline)",
      statement:
        "Exact sentence-to-slot alignment is NOT available. The approved storyboard defines windowSec per narration block (N001-N018) and no per-slot boundaries; TTS artifacts provide one VTT cue and one word-boundary stream per block. Narration is therefore shown at block level for every slot in that block, and no sentence-to-slot mapping was invented.",
    },
    previouslyWatched: PREVIOUSLY_WATCHED,
    counts: {
      blocks: blocks.length,
      slots: flatSlots.length,
      candidates: flatSlots.reduce((n, s) => n + s.candidates.length, 0),
      videos: flatSlots.reduce((n, s) => n + s.videoCount, 0),
      photos: flatSlots.reduce((n, s) => n + s.photoFallbackCount, 0),
      deduped: flatSlots.reduce(
        (n, s) => n + s.candidates.filter((c) => c.provenance.length > 1).length,
        0,
      ),
      previouslyWatched: flatSlots.reduce(
        (n, s) => n + s.candidates.filter((c) => c.watchedInPreviousReview).length,
        0,
      ),
    },
    blocks,
  };
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderHtml(data, exportFnSource) {
  const payload = JSON.stringify({
    episode: data.episode,
    title: data.title,
    mode: data.mode,
    note: data.note,
    sources: data.sources,
    alignment: data.alignment,
    previouslyWatched: data.previouslyWatched,
    counts: data.counts,
    blocks: data.blocks,
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.episode)} - Gate 2 narrative review (${data.counts.slots} slots)</title>
<style>
  :root {
    --bg: #101214; --panel: #171a1e; --panel-2: #1e2228; --line: #2b3138;
    --ink: #e8eaed; --muted: #9aa3ad; --accent: #7fb2ff; --keep: #6fcf97;
    --reject: #eb5757; --search: #f2c94c; --pending: #bb6bd9;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.5 -apple-system, "Segoe UI", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
  a { color: var(--accent); }
  header { padding: 20px 24px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { margin: 0 0 6px; font-size: 20px; }
  h2 { font-size: 17px; margin: 0; }
  h3 { font-size: 14px; margin: 18px 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .sub { color: var(--muted); font-size: 13px; }
  .banner { margin: 12px 0 0; padding: 10px 12px; border-left: 3px solid var(--search);
    background: #241f10; color: #f4e3b2; font-size: 13px; border-radius: 0 4px 4px 0; }
  .summary { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
  .stat { border: 1px solid var(--line); background: var(--panel-2); border-radius: 6px; padding: 8px 12px; min-width: 120px; }
  .stat b { display: block; font-size: 20px; }
  .stat span { color: var(--muted); font-size: 12px; }
  .toolbar { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; gap: 8px;
    align-items: center; padding: 10px 24px; background: #12151a; border-bottom: 1px solid var(--line); }
  button, select, textarea, input { font: inherit; }
  button { background: var(--panel-2); color: var(--ink); border: 1px solid var(--line);
    border-radius: 5px; padding: 6px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.on { background: #24303f; border-color: var(--accent); }
  main { padding: 0 24px 60px; }
  .block { margin: 26px 0 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
  .block-head { padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--panel-2);
    border-radius: 8px 8px 0 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  .block-head .arc { color: var(--muted); font-size: 13px; flex: 1 1 320px; }
  .block-narration { padding: 12px 16px; border-bottom: 1px solid var(--line); }
  .block-narration p { margin: 0 0 8px; }
  .zh { color: #bcd4f0; border-left: 3px solid #33506f; padding-left: 10px; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 10px;
    border: 1px solid var(--line); color: var(--muted); }
  .slot { display: grid; grid-template-columns: minmax(320px, 30%) 1fr; gap: 0; border-top: 1px solid var(--line); }
  .slot:first-child { border-top: none; }
  .slot-left { padding: 14px 16px; border-right: 1px solid var(--line); }
  .slot-right { padding: 14px 16px; min-width: 0; }
  @media (max-width: 1100px) { .slot { grid-template-columns: 1fr; } .slot-left { border-right: none; border-bottom: 1px solid var(--line); } }
  .slot-id { font-weight: 700; font-size: 16px; }
  .meta { color: var(--muted); font-size: 12px; margin: 4px 0 10px; }
  .field { margin: 10px 0 0; }
  .field b { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .field p, .field ul { margin: 4px 0 0; font-size: 13px; }
  .field ul { padding-left: 18px; }
  .note { font-size: 12px; color: var(--muted); border-left: 3px solid var(--search);
    padding: 6px 10px; background: #1d1a10; border-radius: 0 4px 4px 0; margin-top: 10px; }
  .decisions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .decisions .keep.on { background: #1c3327; border-color: var(--keep); }
  .decisions .reject.on { background: #3a1d1d; border-color: var(--reject); }
  .decisions .search.on { background: #332c14; border-color: var(--search); }
  .decisions .pending.on { background: #2a1d33; border-color: var(--pending); }
  .notes { width: 100%; min-height: 56px; margin-top: 8px; background: #12151a; color: var(--ink);
    border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; }
  .cands { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
  .cand { border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); padding: 8px; min-width: 0; }
  .cand.keep { border-color: var(--keep); }
  .cand.reject { border-color: var(--reject); opacity: .72; }
  .cand video { width: 100%; border-radius: 4px; background: #000; display: block; }
  .cand img { width: 100%; border-radius: 4px; display: block; }
  .cand .line { font-size: 12px; color: var(--muted); margin-top: 6px; word-break: break-word; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .badge { font-size: 11px; border: 1px solid var(--line); border-radius: 10px; padding: 0 6px; color: var(--muted); }
  .badge.r4 { color: #9ec5fe; border-color: #33506f; }
  .badge.r5 { color: #ffd9a0; border-color: #6f5320; }
  .badge.watched { color: var(--keep); border-color: var(--keep); }
  .badge.dedupe { color: var(--pending); border-color: var(--pending); }
  .cand .marks { display: flex; gap: 6px; margin-top: 8px; }
  .cand .marks button { font-size: 12px; padding: 3px 8px; }
  .cand .marks .keep.on { background: #1c3327; border-color: var(--keep); }
  .cand .marks .reject.on { background: #3a1d1d; border-color: var(--reject); }
  .cand input { width: 100%; margin-top: 6px; background: #12151a; color: var(--ink);
    border: 1px solid var(--line); border-radius: 4px; padding: 4px 6px; font-size: 12px; }
  pre#exportout { white-space: pre-wrap; word-break: break-word; background: #0c0e11; border: 1px solid var(--line);
    border-radius: 6px; padding: 12px; max-height: 380px; overflow: auto; font-size: 12px; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <h1>${esc(data.episode)} - Gate 2 narrative review</h1>
  <div class="sub">${esc(data.title)} &middot; ${data.counts.blocks} narration blocks &middot; ${data.counts.slots} storyboard slots &middot; ${data.counts.candidates} candidates (${data.counts.videos} video, ${data.counts.photos} photo fallback)</div>
  <div class="sub">Candidates: Round 4 + Round 5 search data only. Nothing selected, nothing approved, nothing downloaded. No workflow state is written by this page.</div>
  <div class="banner"><b>Narration alignment limitation:</b> ${esc(data.alignment.statement)}</div>
  <div class="summary" id="summary"></div>
</header>

<div class="toolbar">
  <select id="filter">
    <option value="all">All slots</option>
    <option value="unresolved">Unresolved only</option>
    <option value="reviewed">Reviewed only</option>
    <option value="proposal">Selected for proposal</option>
    <option value="needs-another-search">Needs another search</option>
    <option value="provisional-keep">Provisional keep</option>
  </select>
  <button id="export">Export decisions JSON</button>
  <button id="copy">Copy JSON</button>
  <button id="reset">Reset local decisions</button>
  <span class="sub" id="savedat"></span>
</div>

<main id="main"></main>
<div class="toolbar" style="position:static"><b>Export preview</b></div>
<main style="padding-top:12px"><pre id="exportout" class="hidden"></pre></main>

<script id="review-data" type="application/json">${payload.replace(/</g, "\\u003c")}</script>
<script>
const DATA = JSON.parse(document.getElementById("review-data").textContent);
const STORAGE_KEY = "essy-0005-narrative-review-v1";
const DECISIONS = [
  { id: "provisional-keep", label: "Provisional keep", cls: "keep" },
  { id: "reject", label: "Reject", cls: "reject" },
  { id: "needs-another-search", label: "Needs another search", cls: "search" },
  { id: "final-selection-pending-approval", label: "Final selection pending approval", cls: "pending" },
];
const PAYLOAD_BUILDER = ${exportFnSource};

const el = (tag, attrs = {}, kids = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid) node.appendChild(kid);
  return node;
};
const fmt = (n) => (n === null || n === undefined ? "-" : Number(n).toFixed(3));
const stamp = (w) => \`\${fmt(w[0])}s - \${fmt(w[1])}s (\${fmt(w[1] - w[0])}s)\`;

let state = { episode: DATA.episode, exportedAt: null, slots: {} };
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
  if (saved && saved.slots) state = saved;
} catch (err) { /* fresh start */ }

const slotState = (slotId) => (state.slots[slotId] = state.slots[slotId] || { decision: null, notes: "", candidates: {} });
const persist = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  document.getElementById("savedat").textContent = "Local decisions saved in this browser only.";
};

function candidateCard(candidate) {
  const card = el("div", { class: "cand", "data-key": candidate.key });
  if (candidate.mediaType === "video" && candidate.videoFileUrl) {
    card.appendChild(el("video", {
      src: candidate.videoFileUrl,
      poster: candidate.previewUrl || "",
      controls: "controls",
      preload: "none",
      playsinline: "playsinline",
    }));
  } else if (candidate.previewUrl) {
    const link = el("a", { href: candidate.sourceUrl, target: "_blank", rel: "noreferrer" });
    link.appendChild(el("img", { src: candidate.previewUrl, loading: "lazy", alt: candidate.altText || candidate.key }));
    card.appendChild(link);
  }
  card.appendChild(el("div", { class: "line" },
    el("a", { href: candidate.sourceUrl, target: "_blank", rel: "noreferrer", text: "Pexels " + candidate.pexelsId })));
  card.appendChild(el("div", { class: "line", text:
    (candidate.mediaType === "video" ? "video" : "photo")
    + (candidate.durationSec ? " - " + candidate.durationSec + "s" : "")
    + (candidate.width && candidate.height ? " - " + candidate.width + "x" + candidate.height : "")
    + (candidate.creator ? " - " + candidate.creator : "") }));

  const badges = el("div", { class: "badges" });
  for (const round of candidate.rounds) {
    badges.appendChild(el("span", { class: "badge r" + round, text: "Round " + round }));
  }
  if (candidate.provenance.length > 1) {
    badges.appendChild(el("span", { class: "badge dedupe", text: "deduped (" + candidate.provenance.length + " entries)" }));
  }
  if (candidate.watchedInPreviousReview) {
    badges.appendChild(el("span", { class: "badge watched", text: "reviewed / provisional keep" }));
  }
  badges.appendChild(el("span", { class: "badge", text: "selectionStatus: " + candidate.selectionStatus }));
  card.appendChild(badges);
  card.appendChild(el("div", { class: "line", text: "query: " + candidate.provenance.map((p) => p.query).filter(Boolean).join(" | ") }));

  const marks = el("div", { class: "marks" });
  for (const [id, label, cls] of [["provisional-keep", "Provisional keep", "keep"], ["reject", "Reject", "reject"]]) {
    const btn = el("button", { class: cls, "data-mark": id, text: label });
    btn.addEventListener("click", () => {
      const entry = slotStateByCard(card);
      const marksState = (entry.candidates[candidate.key] = entry.candidates[candidate.key] || { mark: null, note: "" });
      marksState.mark = marksState.mark === id ? null : id;
      persist();
      render();
    });
    marks.appendChild(btn);
  }
  card.appendChild(marks);

  const noteInput = el("input", { type: "text", placeholder: "candidate note (optional)", value: "" });
  noteInput.addEventListener("input", () => {
    const entry = slotStateByCard(card);
    const marksState = (entry.candidates[candidate.key] = entry.candidates[candidate.key] || { mark: null, note: "" });
    marksState.note = noteInput.value;
    persist();
  });
  card.appendChild(noteInput);
  return card;
}
function slotStateByCard(card) {
  return slotState(card.closest(".slot").dataset.slotid);
}

function slotSection(block, slot, prevSlot, nextSlot) {
  const left = el("div", { class: "slot-left" });
  left.appendChild(el("div", { class: "slot-id", text: slot.sequence + ". " + slot.slotId }));
  left.appendChild(el("div", { class: "meta", text:
    "Block " + block.narrationId + " window " + stamp(block.windowSec)
    + " - slot " + slot.slotIndexInBlock + " of " + slot.slotCountInBlock }));
  left.appendChild(el("div", { class: "note", text: slot.slotTiming.reason }));

  const en = el("div", { class: "field" });
  en.appendChild(el("b", { text: "Approved English narration (block level)" }));
  for (const paragraph of block.narrationEn) en.appendChild(el("p", { text: paragraph }));
  en.appendChild(el("div", { class: "meta", text: "source: " + DATA.sources.script + " (" + block.narrationId + ")" }));
  left.appendChild(en);

  const zh = el("div", { class: "field" });
  zh.appendChild(el("b", { text: "Reference translation (zh-Hant) - not narration" }));
  for (const paragraph of block.narrationZhHant) zh.appendChild(el("p", { class: "zh", text: paragraph }));
  left.appendChild(zh);

  const fn = el("div", { class: "field" });
  fn.appendChild(el("b", { text: "Editorial function (approved)" }));
  fn.appendChild(el("p", { text: slot.editorialFunction }));
  left.appendChild(fn);

  const vi = el("div", { class: "field" });
  vi.appendChild(el("b", { text: "Visual intent (approved)" }));
  vi.appendChild(el("p", { text: slot.visualIntent }));
  left.appendChild(vi);

  const av = el("div", { class: "field" });
  av.appendChild(el("b", { text: "Avoid (approved)" }));
  const list = el("ul");
  for (const item of slot.avoid) list.appendChild(el("li", { text: item }));
  av.appendChild(list);
  left.appendChild(av);

  const ctx = el("div", { class: "field" });
  ctx.appendChild(el("b", { text: "Sequence context (from approved storyboard)" }));
  ctx.appendChild(el("p", { text: "Block " + block.narrationId + " visual arc: " + block.visualArc }));
  ctx.appendChild(el("p", { text: "Preceding slot " + (prevSlot ? prevSlot.slotId + " - " + prevSlot.editorialFunction : "(none - first slot of the episode)") }));
  ctx.appendChild(el("p", { text: "Following slot " + (nextSlot ? nextSlot.slotId + " - " + nextSlot.editorialFunction : "(none - last slot of the episode)") }));
  ctx.appendChild(el("p", { class: "meta", text: "search query: " + (slot.searchQuery || "-") }));
  left.appendChild(ctx);

  const decisions = el("div", { class: "decisions" });
  for (const decision of DECISIONS) {
    const btn = el("button", { class: decision.cls, "data-decision": decision.id, text: decision.label });
    btn.addEventListener("click", () => {
      const entry = slotState(slot.slotId);
      entry.decision = entry.decision === decision.id ? null : decision.id;
      persist();
      render();
    });
    decisions.appendChild(btn);
  }
  left.appendChild(decisions);

  const notes = el("textarea", { class: "notes", placeholder: "Editorial notes for this slot (local to this page)", rows: "2" });
  notes.value = slotState(slot.slotId).notes || "";
  notes.addEventListener("input", () => {
    slotState(slot.slotId).notes = notes.value;
    persist();
  });
  left.appendChild(notes);

  const right = el("div", { class: "slot-right" });
  const videos = slot.candidates.filter((c) => c.mediaType === "video");
  const photos = slot.candidates.filter((c) => c.mediaType !== "video");
  const head = el("div", { class: "meta", text:
    videos.length + " video candidate(s) (video first) / " + photos.length + " photo fallback(s)" });
  right.appendChild(head);
  right.appendChild(el("h3", { text: "Video candidates" }));
  const videoGrid = el("div", { class: "cands" });
  for (const candidate of videos) videoGrid.appendChild(candidateCard(candidate));
  right.appendChild(videoGrid);
  right.appendChild(el("h3", { text: "Photo fallbacks" }));
  const photoGrid = el("div", { class: "cands" });
  for (const candidate of photos) photoGrid.appendChild(candidateCard(candidate));
  right.appendChild(photoGrid);

  return el("div", { class: "slot", "data-slotid": slot.slotId }, [left, right]);
}

const allSlots = DATA.blocks.flatMap((block) => block.slots.map((slot) => ({ block, slot })));
const slotIndex = new Map();
allSlots.forEach(({ block, slot }, i) => {
  slotIndex.set(slot.slotId, i);
});

function slotFilterState(entry) {
  if (!entry) return "unresolved";
  if (entry.decision === "needs-another-search") return "needs-another-search";
  if (entry.decision === "provisional-keep") return "provisional-keep";
  if (entry.decision) return "reviewed";
  if ((entry.notes || "").trim() || Object.keys(entry.candidates || {}).length) return "reviewed";
  return "unresolved";
}

function render() {
  const main = document.getElementById("main");
  const filter = document.getElementById("filter").value;
  main.textContent = "";
  const counts = { reviewed: 0, unresolved: 0, proposal: 0, search: 0, keep: 0 };

  for (const block of DATA.blocks) {
    const visible = block.slots.filter((slot) => {
      const kind = slotFilterState(state.slots[slot.slotId]);
      if (kind === "unresolved") counts.unresolved++;
      else counts.reviewed++;
      if (kind === "needs-another-search") counts.search++;
      if (kind === "provisional-keep") counts.keep++;
      if (filter === "all") return true;
      if (filter === "unresolved") return kind === "unresolved";
      if (filter === "reviewed") return kind !== "unresolved";
      if (filter === "needs-another-search") return kind === "needs-another-search";
      if (filter === "provisional-keep") return kind === "provisional-keep";
      return Object.values((state.slots[slot.slotId] || {}).candidates || {})
        .some((c) => c.mark === "provisional-keep");
    });
    if (!visible.length) continue;

    const section = el("section", { class: "block", id: "block-" + block.narrationId });
    const head = el("div", { class: "block-head" });
    head.appendChild(el("h2", { text: block.narrationId + " (" + fmt(block.windowSec[0]) + "s - " + fmt(block.windowSec[1]) + "s, " + block.blockDurationSec + "s narration)" }));
    head.appendChild(el("span", { class: "arc", text: block.visualArc }));
    section.appendChild(head);

    const narration = el("div", { class: "block-narration" });
    narration.appendChild(el("div", { class: "sub", text: "Approved English narration for " + block.narrationId + " (narration master: " + block.audioPath + ")" }));
    for (const paragraph of block.narrationEn) narration.appendChild(el("p", { text: paragraph }));
    const zhWrap = el("div", {});
    zhWrap.appendChild(el("div", { class: "sub", text: "Reference translation (zh-Hant) - not narration, for editorial reading only" }));
    for (const paragraph of block.narrationZhHant) zhWrap.appendChild(el("p", { class: "zh", text: paragraph }));
    narration.appendChild(zhWrap);
    section.appendChild(narration);

    for (const slot of visible) {
      const i = slotIndex.get(slot.slotId);
      section.appendChild(slotSection(block, slot, i > 0 ? allSlots[i - 1].slot : null, i + 1 < allSlots.length ? allSlots[i + 1].slot : null));
    }
    main.appendChild(section);
  }

  const payload = PAYLOAD_BUILDER(state, { blocks: DATA.blocks, alignment: DATA.alignment, episode: DATA.episode, previouslyWatched: DATA.previouslyWatched });
  for (const slot of payload.slots) if (slot.selectedForProposal) counts.proposal++;
  const summary = document.getElementById("summary");
  summary.textContent = "";
  const stats = [
    ["Slots", payload.summary.totalSlots],
    ["Reviewed", counts.reviewed],
    ["Unresolved", counts.unresolved],
    ["Selected for proposal", counts.proposal],
    ["Provisional keep (slot)", counts.keep],
    ["Needs another search", counts.search],
    ["Candidate provisional keeps", payload.summary.candidateProvisionalKeeps],
    ["Watched / provisional keeps", payload.summary.previouslyWatchedProvisionalKeeps],
  ];
  for (const [label, value] of stats) {
    summary.appendChild(el("div", { class: "stat" }, [el("b", { text: String(value) }), el("span", { text: label })]));
  }
  summary.appendChild(el("div", { class: "stat" }, [el("b", { text: "none" }), el("span", { text: "approved (Gate 2 approval is a separate human decision)" })]));

  // restore per-candidate marks after rebuild
  for (const card of document.querySelectorAll(".cand")) {
    const slotId = card.closest(".slot").dataset.slotid;
    const key = card.dataset.key;
    const entry = state.slots[slotId] && state.slots[slotId].candidates ? state.slots[slotId].candidates[key] : null;
    if (!entry) continue;
    if (entry.mark) {
      card.classList.add(entry.mark === "reject" ? "reject" : "keep");
      const btn = card.querySelector('[data-mark="' + entry.mark + '"]');
      if (btn) btn.classList.add("on");
    }
    const input = card.querySelector("input");
    if (input) input.value = entry.note || "";
  }
  for (const section of document.querySelectorAll(".slot")) {
    const entry = state.slots[section.dataset.slotid];
    if (!entry || !entry.decision) continue;
    const btn = section.querySelector('[data-decision="' + entry.decision + '"]');
    if (btn) btn.classList.add("on");
  }
  document.getElementById("exportout").textContent = JSON.stringify(payload, null, 2);
}

document.getElementById("filter").addEventListener("change", render);
document.getElementById("reset").addEventListener("click", () => {
  state = { episode: DATA.episode, exportedAt: null, slots: {} };
  localStorage.removeItem(STORAGE_KEY);
  render();
});
document.getElementById("export").addEventListener("click", () => {
  state.exportedAt = new Date().toISOString();
  persist();
  const payload = PAYLOAD_BUILDER(state, { blocks: DATA.blocks, alignment: DATA.alignment, episode: DATA.episode, previouslyWatched: DATA.previouslyWatched });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "essy-0005-narrative-review-decisions.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  document.getElementById("exportout").classList.remove("hidden");
  render();
});
document.getElementById("copy").addEventListener("click", () => {
  const text = document.getElementById("exportout").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  document.getElementById("exportout").classList.remove("hidden");
});

persist();
render();
</script>
</body>
</html>
`;
}

function main() {
  const data = buildData();
  fs.writeFileSync(PATHS.dataOut, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  const exportFnSource = buildExportPayload.toString();
  fs.writeFileSync(PATHS.htmlOut, renderHtml(data, exportFnSource), "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        data: path.relative(repoRoot, PATHS.dataOut).replace(/\\/g, "/"),
        html: path.relative(repoRoot, PATHS.htmlOut).replace(/\\/g, "/"),
        counts: data.counts,
        slotTimingAvailable: data.alignment.slotTimingAvailable,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
