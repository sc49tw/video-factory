// EPISODE-AGNOSTIC SUBTITLE TIMELINE BUILDER (deterministic, globally valid).
//
// The shared, reusable ESSY subtitle pipeline:
//   edge-tts VTT -> parse source timing -> DP balanced segmentation ->
//   phrase-aware breakpoint scoring -> orphan prevention ->
//   monotonic child timing allocation -> global non-overlap normalization ->
//   subtitle QA gate -> SRT -> burn-in renderer.
//
// Builds one episode-wide subtitle cue timeline from the per-block edge-tts
// VTT files + assembly-timeline block offsets. Timing is DERIVED from TTS/VTT
// only — never regenerated from reading-speed estimates, and NEVER from the
// visual timeline (shot boundaries must not influence cue boundaries).
//
// Guarantees on the flattened timeline:
//   - cues strictly ordered by start time
//   - no overlaps: prev.end <= next.start (deterministic clamp, 1ms guard gap)
//   - no zero/negative-duration cues
//   - max 2 rendered lines per cue (<= MAX_CHARS per line, MAX_LINES per cue)
//   - narration wording preserved exactly (only whitespace-joined line wrap)
//
// Exports buildSubtitleTimeline(), segmentParentText(), expandCue(),
// normalizeCueTimeline() and writes a machine-readable QA report.
// All limits/thresholds come from scripts/subtitle-config.mjs.
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {resolveSubtitleConfig} from "./subtitle-config.mjs";

const GUARD_GAP_SEC = 0.001;

function parseVtt(text) {
  const cues = [];
  const lines = text.split("\n");
  const timeMatch = (line) =>
    line.match(
      /(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{3})/,
    );
  const t = (h, mi, s, ms) => h * 3600 + mi * 60 + s + ms / 1000;
  const timingIndices = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (timeMatch(lines[i])) timingIndices.push(i);
  }
  timingIndices.forEach((idx, k) => {
    const m = timeMatch(lines[idx]);
    if (!m) return;
    const nextIdx = k + 1 < timingIndices.length ? timingIndices[k + 1] : lines.length;
    const textLines = [];
    for (let j = idx + 1; j < nextIdx; j += 1) {
      const line = lines[j].trim();
      if (line && line !== "WEBVTT" && !timeMatch(line)) textLines.push(line);
    }
    if (!textLines.length) return;
    cues.push({
      startSec: t(+m[1], +m[2], +m[3], +m[4]),
      endSec: t(+m[5], +m[6], +m[7], +m[8]),
      text: textLines.join(" "),
    });
  });
  return cues;
}

function wrapText(value, maxChars) {
  const lines = [];
  let line = "";
  for (const word of String(value).trim().split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ---- Balanced, phrase-aware segmentation (DP, not greedy) ----
//
// Splits a parent cue into sequential children by minimizing a global cost:
//   - hard invalid: > MAX_LINES lines or any line > MAX_CHARS
//   - 1-word generated child: very high penalty
//   - 2-word generated child: high penalty
//   - <12 chars generated child: penalty
//   - estimated child duration < 700ms: penalty
//   - length imbalance between adjacent children: medium penalty
//   - unnatural break (after preposition/conjunction): penalty
//   - natural break (sentence punctuation / comma / before conjunction): bonus
// A parent that fits in a single cue always costs 0, so naturally short
// standalone sentences ("Maybe.", "Someone falls.") are never split.
const DEFAULT_CONFIG = resolveSubtitleConfig();

const CONJUNCTIONS = new Set([
  "and", "but", "or", "so", "yet", "because", "although", "though", "while",
  "when", "whenever", "if", "unless", "until", "after", "before", "since",
  "that", "which", "who", "whom", "whose", "where", "as",
]);
// Words that should not be separated from what follows across a child boundary.
const TIGHT_PRECEDERS = new Set([
  "at", "around", "of", "to", "in", "on", "for", "with", "from", "by",
  "into", "onto", "about", "over", "under", "up", "down", "out", "off", "a", "an", "the",
]);

const PENALTY_ONE_WORD = 5000;
const PENALTY_TWO_WORDS = 900;
const PENALTY_SHORT_CHARS = 400;
const PENALTY_SHORT_DURATION = 500;
const PENALTY_TIGHT_BREAK = 250;
const PENALTY_DISCOURSE_BREAK = 300;
const BONUS_SENTENCE_BREAK = -150;
const BONUS_CLAUSE_BREAK = -70;
const BONUS_CONJ_BREAK = -25;
const PENALTY_IMBALANCE_SCALE = 160;

// Discourse markers / negation particles that must stay joined to the
// following phrase. Breaking after these orphans a connector (e.g. "Not:",
// "is not", "But:", "Because", "even") and produces a semantically
// incomplete micro-cue. Checked BEFORE the clause-break bonus so that a
// colon-terminated marker is penalized rather than rewarded.
const DISCOURSE_MARKERS = new Set([
  "not", "but", "so", "and", "or", "because", "if", "while", "when", "even",
  "yet", "nor", "whether", "although", "though", "since", "until", "unless",
]);

function boundaryPenalty(prevChild, nextChild) {
  const prevWord = prevChild.split(/\s+/).pop() ?? "";
  const nextWord = nextChild.split(/\s+/)[0] ?? "";
  if (/[.!?]["')\]]?$/.test(prevWord)) return BONUS_SENTENCE_BREAK;
  if (DISCOURSE_MARKERS.has(prevWord.replace(/[^'\w-]/g, "").toLowerCase())) return PENALTY_DISCOURSE_BREAK;
  if (/[,;:]["')\]]?$/.test(prevWord) || /[—–-]$/.test(prevWord)) return BONUS_CLAUSE_BREAK;
  if (TIGHT_PRECEDERS.has(prevWord.replace(/[^'\w-]/g, "").toLowerCase())) return PENALTY_TIGHT_BREAK;
  if (CONJUNCTIONS.has(nextWord.replace(/[^'\w-]/g, "").toLowerCase())) return BONUS_CONJ_BREAK;
  return 0;
}

// Choose the segmentation of `text` (a parent cue) minimizing total cost.
// `durationSec` (optional) enables the sub-minimum-duration penalty via
// char-proportional time estimates. Returns an array of child strings.
// Pure function, exported for tests. `config` defaults to the shared
// subtitle config; episode overrides can be passed explicitly.
export function segmentParentText(text, durationSec = null, config = DEFAULT_CONFIG) {
  const {MAX_CHARS, MAX_LINES, MIN_GENERATED_WORDS, MIN_GENERATED_CHARS, MIN_GENERATED_DURATION_MS} = config;
  const words = String(text).trim().split(/\s+/);
  const n = words.length;
  if (n === 0) return [];
  const totalChars = words.join(" ").length;
  const charShare = (from, to) => words.slice(from, to).join(" ").length / totalChars;
  const estDuration = (from, to) =>
    durationSec == null ? charShare(from, to) : durationSec * charShare(from, to);

  const INF = Number.POSITIVE_INFINITY;
  const cost = new Array(n + 1).fill(INF);
  const prevIndex = new Array(n + 1).fill(-1);
  const lastLen = new Array(n + 1).fill(0);
  cost[0] = 0;

  for (let j = 1; j <= n; j += 1) {
    for (let i = 0; i < j; i += 1) {
      if (cost[i] === INF) continue;
      const child = words.slice(i, j).join(" ");
      const lines = wrapText(child, MAX_CHARS);
      if (lines.length > MAX_LINES || lines.some((l) => l.length > MAX_CHARS)) continue;

      let c = cost[i];
      const multiChild = i > 0 || j < n;
      if (multiChild) {
        const childWords = j - i;
        if (childWords < MIN_GENERATED_WORDS) {
          // Orphan prevention: 1-word children are near-forbidden, 2-word
          // children strongly discouraged.
          c += childWords === 1 ? PENALTY_ONE_WORD : PENALTY_TWO_WORDS;
        }
        if (child.length < MIN_GENERATED_CHARS) c += PENALTY_SHORT_CHARS;
        if (estDuration(i, j) * 1000 < MIN_GENERATED_DURATION_MS) c += PENALTY_SHORT_DURATION;
      }
      if (i > 0) {
        const prevChild = words.slice(prevIndex[i], i).join(" ");
        c += boundaryPenalty(prevChild, child);
        const prevLen = lastLen[i];
        c += (Math.abs(prevLen - child.length) / (prevLen + child.length)) * PENALTY_IMBALANCE_SCALE;
      }
      if (c < cost[j]) {
        cost[j] = c;
        prevIndex[j] = i;
        lastLen[j] = child.length;
      }
    }
  }

  const parts = [];
  let at = n;
  while (at > 0) {
    parts.unshift(words.slice(prevIndex[at], at).join(" "));
    at = prevIndex[at];
  }
  return parts;
}

// ---- Word-timing artifact (authoritative fine-grained subtitle timing) ----
//
// Per-block artifacts (`temp/<sentenceId>.words.json`) carry edge-tts
// WordBoundary offsets captured at TTS generation time. Semantic segmentation
// still decides WHAT text is shown together; word timing decides WHEN that
// text is spoken. Character-proportional interpolation is a legacy fallback
// only and is always explicitly identified via timingSource.
//
// timingSource values per cue:
//   "edge-word-boundary" — cue times derived from word-timing artifact
//   "legacy-vtt"         — untouched single VTT cue, no word timing available
//   "char-estimate"      — generated children timed by char-share (legacy)

const normalizeToken = (t) => String(t).toLowerCase().replace(/[^a-z0-9']/g, "");

// Sequentially map a cue's text tokens onto the block's word-boundary list.
// `cursor` carries position across sibling cues of the same parent. Returns
// null when the text cannot be matched to the artifact (caller must fall back).
export function mapCueTextToWords(text, words, cursor = 0) {
  const tokens = String(text)
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => /[a-z0-9]/.test(t));
  if (!tokens.length) return null;
  let firstIndex = -1;
  let lastIndex = -1;
  let at = cursor;
  for (const token of tokens) {
    while (at < words.length && normalizeToken(words[at].text) !== token) at += 1;
    if (at >= words.length) return null;
    if (firstIndex === -1) firstIndex = at;
    lastIndex = at;
    at += 1;
  }
  return {
    firstIndex,
    lastIndex,
    speechStartSec: words[firstIndex].startSec,
    speechEndSec: words[lastIndex].endSec,
    cursor: lastIndex + 1,
  };
}

// Largest internal silence between consecutive mapped words of a cue (sec).
function maxInternalWordGapSec(words, firstIndex, lastIndex) {
  let maxGap = 0;
  for (let i = firstIndex; i < lastIndex; i += 1) {
    const gap = words[i + 1].startSec - words[i].endSec;
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap;
}

// Split a narrative cue into sequential <=2-line sub-cues. With a word-timing
// artifact, child times come from the ACTUAL spoken words (speech timing);
// display times apply only the configured lead/linger presentation policy.
// Without an artifact, legacy char-share interpolation is used and the cue is
// explicitly marked timingSource "char-estimate".
export function expandCue(cue, config = DEFAULT_CONFIG, words = null, offsetSec = 0) {
  const parts = segmentParentText(cue.text, cue.endSec - cue.startSec, config);
  if (parts.length <= 1 && !words) {
    return [{startSec: cue.startSec, endSec: cue.endSec, text: cue.text, generated: false, timingSource: "legacy-vtt"}];
  }
  const leadSec = (config.PRESENTATION_LEAD_MS ?? 0) / 1000;
  const lingerSec = (config.PRESENTATION_LINGER_MS ?? 0) / 1000;
  const finish = (text, startSec, endSec, extra) => ({
    startSec,
    endSec,
    text,
    generated: parts.length > 1,
    ...extra,
  });
  if (words && words.length) {
    const mapped = [];
    let cursor = 0;
    for (const text of parts) {
      const m = mapCueTextToWords(text, words, cursor);
      if (!m) {
        mapped.length = 0;
        break;
      }
      mapped.push(m);
      cursor = m.cursor;
    }
    if (mapped.length) {
      return parts.map((text, index) => {
        const m = mapped[index];
        const speechStart = m.speechStartSec + offsetSec;
        const speechEnd = m.speechEndSec + offsetSec;
        return finish(text, Math.max(0, speechStart - leadSec), speechEnd + lingerSec, {
          timingSource: "edge-word-boundary",
          speechStartSec: speechStart,
          speechEndSec: speechEnd,
          wordStartIndex: m.firstIndex,
          wordEndIndex: m.lastIndex,
          maxInternalWordGapSec: Number(maxInternalWordGapSec(words, m.firstIndex, m.lastIndex).toFixed(3)),
        });
      });
    }
  }
  // Legacy fallback: char-share interpolation inside the parent window.
  const duration = cue.endSec - cue.startSec;
  const totalChars = parts.reduce((sum, t) => sum + t.length, 0);
  const out = [];
  let cursor = cue.startSec;
  for (const [index, text] of parts.entries()) {
    const span = duration * (text.length / totalChars);
    const isLast = index === parts.length - 1;
    out.push(finish(text, cursor, isLast ? cue.endSec : cursor + span, {
      timingSource: parts.length > 1 ? "char-estimate" : "legacy-vtt",
    }));
    cursor += span;
  }
  return out;
}

// Deterministic overlap normalization: preserve the next cue's start time and
// clamp the previous cue's end to (next.start - guard). Never moves text.
// Exported for tests.
export function normalizeCueTimeline(cues) {
  const corrections = [];
  const out = cues.map((c) => ({...c}));
  out.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  for (let i = 0; i < out.length - 1; i += 1) {
    const prev = out[i];
    const next = out[i + 1];
    const limit = next.startSec - GUARD_GAP_SEC;
    if (prev.endSec > limit) {
      const before = prev.endSec;
      prev.endSec = limit;
      corrections.push({
        index: i,
        block: prev.blockId,
        before: Number(before.toFixed(3)),
        after: Number(prev.endSec.toFixed(3)),
        clampedTo: Number(next.startSec.toFixed(3)),
        prevText: prev.text,
        nextText: next.text,
      });
    }
  }
  const kept = out.filter((c) => c.endSec - c.startSec > 0);
  return {cues: kept, corrections};
}

export async function buildSubtitleTimeline({root, episode, config: configOverrides} = {}) {
  const config = resolveSubtitleConfig(configOverrides);
  const project = path.join(root, "projects", episode);
  const timeline = JSON.parse(await readFile(path.join(project, "assembly-timeline.json"), "utf8"));
  const blockStart = new Map(timeline.blocks.map((b) => [b.sentenceId, b.startSec ?? 0]));

  // ---- Per-generation word-timing requirement policy ----
  // New-generation ESSY manifests carry subtitleTiming.policy =
  // "word-boundary-required" (written by render-lesson.mjs at TTS time).
  // Legacy manifests (ESSY-0001/0002/0003) have no such field and keep the
  // explicit warn/fallback behavior. char-estimate NEVER silently counts as
  // production-grade timing in either mode.
  let manifestWordTimingPolicy = null;
  try {
    const manifest = JSON.parse(await readFile(path.join(project, "manifest.json"), "utf8"));
    manifestWordTimingPolicy = manifest?.subtitleTiming?.policy ?? null;
  } catch {
    // No manifest (non-ESSY or stripped project) — fall back to config policy.
  }
  const wordTimingRequired =
    manifestWordTimingPolicy === "word-boundary-required"
      ? true
      : manifestWordTimingPolicy == null
        ? (config.REQUIRE_WORD_TIMING ?? false)
        : false;
  const effectiveConfig = wordTimingRequired
    ? {...config, REQUIRE_WORD_TIMING: true}
    : config;

  // Cold-open title-card blocks (e.g. channel name + episode title) are rendered
  // by the title layer, NEVER as ordinary narration subtitle cues. Read the
  // production-package's coldOpenExperiment.titleCards and derive the narration
  // block ids (n002 -> sentence-002) whose VTT cues must be excluded.
  const titleCardSentenceIds = new Set();
  try {
    const pkgPath = path.join(root, "projects", "_drafts", episode, "production-package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    for (const card of pkg?.packaging?.coldOpenExperiment?.titleCards ?? []) {
      if (card?.blockId) {
        titleCardSentenceIds.add(`sentence-${String(card.blockId).replace(/^n/i, "")}`);
      }
    }
  } catch {
    // No production package (or no title cards) — nothing to skip.
  }

  const raw = [];
  const timing = {
    blocksTotal: blockStart.size - titleCardSentenceIds.size,
    blocksWithWordTiming: 0,
    fallbackBlocks: [],
    totalWords: 0,
    matchedWords: 0,
  };
  for (const [sentenceId, offset] of blockStart.entries()) {
    if (titleCardSentenceIds.has(sentenceId)) continue;
    const vttPath = path.join(project, "temp", `${sentenceId}.vtt`);
    const vtt = await readFile(vttPath, "utf8");
    let words = null;
    try {
      const artifact = JSON.parse(await readFile(path.join(project, "temp", `${sentenceId}.words.json`), "utf8"));
      if (artifact?.timingSource === "edge-tts-word-boundary" && Array.isArray(artifact.words) && artifact.words.length) {
        if (artifact.cacheIdentity?.matchesManifest === false) {
          throw new Error(`word-timing artifact cache identity mismatch for ${sentenceId}`);
        }
        words = artifact.words;
        timing.blocksWithWordTiming += 1;
        timing.totalWords += words.length;
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const cue of parseVtt(vtt)) {
      const children = expandCue({
        startSec: cue.startSec + offset,
        endSec: cue.endSec + offset,
        text: cue.text,
      }, effectiveConfig, words, offset);
      // words are relative to block audio start; cue times are absolute
      for (const expanded of children) {
        raw.push({...expanded, blockId: sentenceId});
      }
      if (words) {
        for (const child of children) {
          if (child.timingSource === "edge-word-boundary") {
            timing.matchedWords += child.wordEndIndex - child.wordStartIndex + 1;
          }
        }
      }
    }
    if (!words) timing.fallbackBlocks.push(sentenceId);
  }

  const {cues, corrections} = normalizeCueTimeline(raw);

  // ---- QA metrics ----
  const {MAX_CHARS, MAX_LINES, MIN_GENERATED_WORDS, MIN_GENERATED_CHARS, MIN_GENERATED_DURATION_MS} = config;
  const overlapsAfter = cues.reduce(
    (n, c, i) => (i > 0 && c.startSec < cues[i - 1].endSec ? n + 1 : n),
    0,
  );
  const zeroDuration = cues.filter((c) => c.endSec - c.startSec <= 0).length;
  const over2Lines = cues.filter((c) => wrapText(c.text, MAX_CHARS).length > MAX_LINES).length;
  const maxRenderedLines = cues.reduce(
    (max, c) => Math.max(max, wrapText(c.text, MAX_CHARS).length),
    0,
  );
  const durations = cues.map((c) => c.endSec - c.startSec);

  // ---- Orphan / short-generated-cue QA (only generated children are judged;
  //      natural standalone short sentences are never offenders) ----
  const wordCount = (t) => t.trim().split(/\s+/).length;
  const generated = cues.filter((c) => c.generated);
  const cueInfo = (c) => ({
    text: c.text,
    block: c.blockId,
    start: Number(c.startSec.toFixed(3)),
    end: Number(c.endSec.toFixed(3)),
    durationMs: Math.round((c.endSec - c.startSec) * 1000),
    chars: c.text.length,
    words: wordCount(c.text),
  });
  const minDurationSec = MIN_GENERATED_DURATION_MS / 1000;

  // ---- Timing-integrity QA (perceptual sync) ----
  const percentile = (sortedValues, p) => {
    if (!sortedValues.length) return null;
    const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
    return sortedValues[Math.max(0, idx)];
  };
  const distribution = (valuesMs) => {
    const sorted = [...valuesMs].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.length ? sorted[sorted.length - 1] : null,
    };
  };
  const timingSourceCounts = cues.reduce((acc, c) => {
    acc[c.timingSource ?? "unknown"] = (acc[c.timingSource ?? "unknown"] ?? 0) + 1;
    return acc;
  }, {});
  const wordCues = cues.filter((c) => c.timingSource === "edge-word-boundary");
  const startDeltasMs = wordCues.map((c) => Math.round((c.startSec - c.speechStartSec) * 1000));
  const endDeltasMs = wordCues.map((c) => Math.round((c.endSec - c.speechEndSec) * 1000));
  const driftByBlock = {};
  for (const c of wordCues) {
    const d = Math.abs(Math.round((c.startSec - c.speechStartSec) * 1000));
    driftByBlock[c.blockId] = Math.max(driftByBlock[c.blockId] ?? 0, d);
  }
  const maxWithinBlockDriftMs = Object.values(driftByBlock);
  const SPEECH_GAP_RESIDUAL_MS = 1000;
  const speechGapResidualCueCount = wordCues.filter(
    (c) => (c.maxInternalWordGapSec ?? 0) * 1000 > SPEECH_GAP_RESIDUAL_MS,
  ).length;
  const wordCoverageRatio = timing.totalWords
    ? Number((timing.matchedWords / timing.totalWords).toFixed(4))
    : null;
  const fallbackCueCount = cues.filter(
    (c) => c.timingSource === "char-estimate" || c.timingSource === "legacy-vtt",
  ).length;
  const timingIntegrityStatus =
    timing.fallbackBlocks.length === 0
      ? "pass"
      : effectiveConfig.REQUIRE_WORD_TIMING ? "fail" : "warn";
  const orphanOffenders = generated
    .filter((c) => wordCount(c.text) < MIN_GENERATED_WORDS && wordCount(c.text) === 1)
    .map(cueInfo);
  const twoWordOffenders = generated
    .filter((c) => wordCount(c.text) < MIN_GENERATED_WORDS && wordCount(c.text) === 2)
    .map(cueInfo);
  const shortCharOffenders = generated.filter((c) => c.text.length < MIN_GENERATED_CHARS).map(cueInfo);
  const sub700Offenders = generated.filter((c) => c.endSec - c.startSec < minDurationSec).map(cueInfo);
  const shortestGenerated = generated.length
    ? cueInfo(generated.reduce((a, b) => (b.endSec - b.startSec < a.endSec - a.startSec ? b : a)))
    : null;

  const ids = [...blockStart.keys()];
  const report = {
    schemaVersion: "1.3",
    episode,
    generatedFrom: "per-block edge-tts VTT + word-timing artifacts + assembly-timeline offsets (no re-estimation)",
    segmentation: "balanced phrase-aware DP (segmentParentText), MAX_CHARS hard bound",
    totalCueCount: cues.length,
    overlapCountBeforeNormalization: corrections.length,
    overlapCountAfterNormalization: overlapsAfter,
    invalidDurationCueCount: zeroDuration,
    maxRenderedLines,
    minimumCueDurationSec: Number(Math.min(...durations).toFixed(3)),
    maximumCueDurationSec: Number(Math.max(...durations).toFixed(3)),
    orphanChildCueCount: orphanOffenders.length,
    orphanOffenders,
    twoWordChildCueCount: twoWordOffenders.length,
    twoWordOffenders,
    shortGeneratedCueCount: shortCharOffenders.length,
    shortGeneratedCueOffenders: shortCharOffenders,
    shortestGeneratedCue: shortestGenerated,
    generatedCueDurationBelow700msCount: sub700Offenders.length,
    generatedCueDurationBelow700msOffenders: sub700Offenders,
    correctedOverlaps: corrections,
    timingSourceCounts,
    timingIntegrity: {
      status: timingIntegrityStatus,
      requireWordTiming: effectiveConfig.REQUIRE_WORD_TIMING ?? false,
      manifestPolicy: manifestWordTimingPolicy,
      blocksTotal: timing.blocksTotal,
      blocksWithWordTiming: timing.blocksWithWordTiming,
      blocksUsingFallback: timing.fallbackBlocks.length,
      fallbackBlocks: timing.fallbackBlocks,
      fallbackCueCount,
      wordCoverageRatio,
      cueStartVsFirstWordDeltaMs: distribution(startDeltasMs),
      cueEndVsLastWordDeltaMs: distribution(endDeltasMs),
      maxWithinBlockDriftMs: distribution(maxWithinBlockDriftMs),
      speechGapResidualCueCount,
    },
    passed:
      overlapsAfter === 0
      && zeroDuration === 0
      && over2Lines === 0
      && orphanOffenders.length === 0
      && twoWordOffenders.length === 0
      && sub700Offenders.length === 0
      && timingIntegrityStatus !== "fail",
    narrationBlockBoundaries: ids.slice(1).map((id, i) => {
      const prevLast = [...cues].reverse().find((c) => c.blockId === ids[i]);
      const nextFirst = cues.find((c) => c.blockId === id);
      return {
        boundary: `${ids[i]}/${id}`,
        prevLastEndSec: prevLast ? Number(prevLast.endSec.toFixed(3)) : null,
        nextFirstStartSec: nextFirst ? Number(nextFirst.startSec.toFixed(3)) : null,
        noOverlap: prevLast && nextFirst ? prevLast.endSec <= nextFirst.startSec : false,
      };
    }),
  };

  const qaPath = path.join(project, "temp", `${episode}-subtitle-qa.json`);
  const srtPath = path.join(project, "temp", `${episode}-subtitles.srt`);
  await mkdir(path.dirname(srtPath), {recursive: true});

  const srtTimestamp = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss},${String(ms % 1000).padStart(3, "0")}`;
  };
  const srtLines = [];
  cues.forEach((cue, index) => {
    srtLines.push(String(index + 1));
    srtLines.push(`${srtTimestamp(cue.startSec)} --> ${srtTimestamp(cue.endSec)}`);
    srtLines.push(cue.text);
    srtLines.push("");
  });
  await writeFile(srtPath, srtLines.join("\n"), "utf8");
  await writeFile(qaPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return {cues, srtPath, qaPath, report};
}
