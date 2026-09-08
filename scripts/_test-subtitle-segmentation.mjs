// GENERIC REGRESSION TESTS for the shared balanced phrase-aware subtitle
// segmentation pipeline (scripts/_build-subtitle-timeline.mjs).
//
// The first two cases are named after the ESSY-0002 incidents that motivated
// them ("medication" orphan, "at once" tight phrase). They are REGRESSION
// FIXTURES ONLY — there is no text-specific logic in the runtime pipeline.
//
// Run: pnpm test:subtitle
import assert from "node:assert/strict";
import {SUBTITLE_CONFIG} from "./subtitle-config.mjs";
import {
  segmentParentText,
  expandCue,
  normalizeCueTimeline,
  mapCueTextToWords,
} from "./_build-subtitle-timeline.mjs";

const {MAX_CHARS, MAX_LINES} = SUBTITLE_CONFIG;

const cases = [];
const test = (name, fn) => cases.push({name, fn});
const words = (t) => t.trim().split(/\s+/).length;

test("regression fixture (medication orphan case): no 1-word orphan, balanced children", () => {
  const parent = "My father had already gone to bed when he remembered that he still needed to take his medication.";
  const parts = segmentParentText(parent, 6.383);
  assert.ok(parts.length >= 2, "must split");
  for (const p of parts) {
    assert.ok(words(p) >= 3, `no orphan children, got: ${parts.join(" || ")}`);
    assert.ok(p.length >= 12, `no tiny children, got: ${parts.join(" || ")}`);
  }
  assert.ok(parts.at(-1).includes("medication"), "last child ends with 'medication'");
  assert.equal(parts.join(" "), parent, "wording preserved exactly");
});

test("regression fixture (at-once tight phrase case): no orphan 'once.', no break after 'at'", () => {
  const parent = "And then there are moments when all those gradual changes suddenly become visible at once.";
  const parts = segmentParentText(parent, 2.702);
  assert.ok(parts.length >= 2, "must split");
  for (const p of parts) {
    assert.ok(words(p) >= 3, `no orphan children, got: ${parts.join(" || ")}`);
  }
  assert.ok(parts.at(-1).includes("at once"), "'at once' stays together in the final child");
  assert.equal(parts.join(" "), parent, "wording preserved exactly");
});

test("sentence that fits in one cue is NOT split", () => {
  const parent = "Normally, this would have been nothing.";
  const parts = segmentParentText(parent, 3.1);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], parent);
});

test("naturally short standalone sentences stay intact", () => {
  for (const parent of ["Maybe.", "Someone falls.", "Bodies age.", "Circumstances change."]) {
    const parts = segmentParentText(parent, 1.2);
    assert.equal(parts.length, 1, `${parent} must not be split`);
    assert.equal(parts[0], parent);
  }
});

test("long sentence yields 3+ balanced children within MAX_CHARS x MAX_LINES", () => {
  const parent = "The doctors ran several tests that afternoon and every single result came back completely normal which somehow made the whole situation feel even more unsettling than before.";
  const parts = segmentParentText(parent, 9.5);
  assert.ok(parts.length >= 3, `expected 3+ children, got ${parts.length}`);
  for (const p of parts) {
    const lines = [];
    let line = "";
    for (const w of p.split(/\s+/)) {
      const cand = line ? `${line} ${w}` : w;
      if (cand.length > MAX_CHARS && line) { lines.push(line); line = w; } else { line = cand; }
    }
    if (line) lines.push(line);
    assert.ok(lines.length <= MAX_LINES, `child exceeds ${MAX_LINES} lines: ${p}`);
    for (const l of lines) assert.ok(l.length <= MAX_CHARS, `line exceeds MAX_CHARS: ${l}`);
    assert.ok(words(p) >= 3, `no orphan children, got: ${parts.join(" || ")}`);
  }
  assert.equal(parts.join(" "), parent, "wording preserved exactly");
});

test("expandCue: monotonic strictly-increasing times filling the parent window", () => {
  const cue = {startSec: 10, endSec: 16, text: "My father had already gone to bed when he remembered that he still needed to take his medication."};
  const children = expandCue(cue);
  assert.ok(children.length >= 2);
  assert.ok(children.every((c) => c.generated === true), "children flagged generated");
  assert.equal(children[0].startSec, cue.startSec);
  assert.equal(children.at(-1).endSec, cue.endSec);
  for (let i = 1; i < children.length; i += 1) {
    assert.ok(children[i].startSec > children[i - 1].startSec, "strictly increasing");
    assert.ok(Math.abs(children[i - 1].endSec - children[i].startSec) < 1e-9, "contiguous");
  }
  assert.ok(children.every((c) => c.endSec - c.startSec > 0), "positive durations");
});

test("expandCue: single-cue parent untouched and not marked generated", () => {
  const cue = {startSec: 5, endSec: 8, text: "Someone falls."};
  const [child] = expandCue(cue);
  assert.equal(child.generated, false);
  assert.equal(child.startSec, 5);
  assert.equal(child.endSec, 8);
  assert.equal(child.text, "Someone falls.");
});

test("normalizeCueTimeline: no overlap survives, 1ms clamp, nothing valid dropped", () => {
  const input = [
    {startSec: 10.0, endSec: 12.5, text: "overlapping tail", generated: false, blockId: "a"},
    {startSec: 12.0, endSec: 14.0, text: "next cue keeps its start", generated: false, blockId: "b"},
    {startSec: 14.5, endSec: 16.0, text: "already clean", generated: false, blockId: "c"},
  ];
  const {cues, corrections} = normalizeCueTimeline(input);
  assert.equal(cues.length, 3, "no cue is dropped");
  assert.equal(corrections.length, 1, "exactly one clamp applied");
  for (let i = 1; i < cues.length; i += 1) {
    assert.ok(cues[i - 1].endSec <= cues[i].startSec, `no overlap at index ${i}`);
    assert.ok(cues[i].startSec > cues[i - 1].startSec, "strictly increasing starts");
  }
  assert.ok(Math.abs(cues[0].endSec - (cues[1].startSec - 0.001)) < 1e-9, "1ms guard gap");
  assert.equal(cues[2].endSec, 16.0, "untouched cue keeps its end");
});

test("expandCue output never produces generated orphans or sub-minimum children", () => {
  const longCue = {
    startSec: 100,
    endSec: 106.4,
    text: "My father had already gone to bed when he remembered that he still needed to take his medication.",
  };
  const children = expandCue(longCue);
  for (const c of children) {
    if (!c.generated) continue;
    assert.ok(c.text.trim().split(/\s+/).length >= SUBTITLE_CONFIG.MIN_GENERATED_WORDS, `no orphan: ${c.text}`);
    assert.ok((c.endSec - c.startSec) * 1000 >= SUBTITLE_CONFIG.MIN_GENERATED_DURATION_MS, `not too short: ${c.text}`);
  }
});

// ===========================================================================
// Word-boundary timing regression tests (perceptual-sync P0 fix)
// ===========================================================================

// Build a synthetic word-timing artifact from [text, startSec, endSec] tuples.
const buildWords = (entries) =>
  entries.map(([text, startSec, endSec]) => ({text, startSec, endSec}));

test("word timing A: long multi-sentence block in ONE parent VTT cue splits into multiple word-timed children", () => {
  const parentText =
    "There is a strange point in a career when work can become difficult to think about. " +
    "Not because the job is terrible. Sometimes, the opposite is true. You are good at it.";
  // Uneven speech with sentence pauses (see tests C/B).
  const words = buildWords([
    ["There", 0.10, 0.40], ["is", 0.40, 0.55], ["a", 0.55, 0.62], ["strange", 0.62, 1.20],
    ["point", 1.20, 1.65], ["in", 1.65, 1.80], ["a", 1.80, 1.87], ["career", 1.87, 2.50],
    ["when", 2.50, 2.80], ["work", 2.80, 3.20], ["can", 3.20, 3.40], ["become", 3.40, 3.90],
    ["difficult", 3.90, 4.70], ["to", 4.70, 4.82], ["think", 4.82, 5.20], ["about", 5.20, 5.60],
    // 1.5 s sentence pause 5.60 -> 7.10
    ["Not", 7.10, 7.30], ["because", 7.30, 7.75], ["the", 7.75, 7.85], ["job", 7.85, 8.10],
    ["is", 8.10, 8.22], ["terrible", 8.22, 8.90],
    // 1.2 s pause 8.90 -> 10.10
    ["Sometimes", 10.10, 10.75], ["the", 10.75, 10.85], ["opposite", 10.85, 11.45], ["is", 11.45, 11.57], ["true", 11.57, 11.90],
    // pause 11.90 -> 12.60
    ["You", 12.60, 12.75], ["are", 12.75, 12.90], ["good", 12.90, 13.30], ["at", 13.30, 13.40], ["it", 13.40, 13.55],
  ]);
  const cue = {startSec: 100, endSec: 113.55, text: parentText};
  const children = expandCue(cue, undefined, words);
  assert.ok(children.length >= 3, `expected 3+ children, got ${children.length}`);
  for (const c of children) assert.equal(c.timingSource, "edge-word-boundary");
  assert.equal(children.map((c) => c.text).join(" "), parentText, "wording preserved");
  // F: no cumulative drift — every child is exactly its first/last word span.
  for (const c of children) {
    assert.equal(c.speechStartSec, words[c.wordStartIndex].startSec, "child starts at its first word");
    assert.equal(c.speechEndSec, words[c.wordEndIndex].endSec, "child ends at its last word");
    assert.equal(c.startSec, c.speechStartSec, "display == speech with zero presentation policy");
  }
});

test("word timing B: uneven word durations — child boundaries land on real word starts, not char share", () => {
  const parentText = "Slow deliberate words then quickwords rush onward together here.";
  const words = buildWords([
    ["Slow", 0.00, 1.20], ["deliberate", 1.20, 2.10], ["words", 2.10, 2.25], ["then", 2.25, 2.40],
    ["quickwords", 2.40, 2.52], ["rush", 2.52, 2.60], ["onward", 2.60, 2.68], ["together", 2.68, 2.76], ["here", 2.76, 3.00],
  ]);
  const children = expandCue({startSec: 0, endSec: 3.0, text: parentText}, undefined, words);
  const starts = children.map((c) => c.speechStartSec);
  for (const s of starts) {
    assert.ok(words.some((w) => w.startSec === s), `start ${s} must be a real word start`);
  }
});

test("word timing C: sentence pauses preserved — no cue lingers across a speech gap", () => {
  const parentText = "First sentence ends here. Second sentence begins now.";
  const words = buildWords([
    ["First", 0.00, 0.30], ["sentence", 0.30, 0.70], ["ends", 0.70, 1.00], ["here", 1.00, 1.30],
    ["Second", 5.00, 5.30], ["sentence", 5.30, 5.75], ["begins", 5.75, 6.20], ["now", 6.20, 6.50],
  ]);
  const children = expandCue({startSec: 10, endSec: 16.5, text: parentText}, undefined, words, 10);
  assert.ok(children.length >= 2);
  const first = children[0];
  const second = children[children.length - 1];
  assert.equal(first.speechEndSec, 11.30, "first child ends at last spoken word");
  assert.equal(second.speechStartSec, 15.00, "second child starts at its first spoken word");
  assert.ok(second.speechStartSec - first.speechEndSec >= 3.0, "pause kept outside cue windows");
  // Old char-share behavior: the 2nd sentence cue would have appeared early.
  const charsBeforeSecond = children.slice(0, -1).reduce((s, c) => s + c.text.length, 0);
  const charShareStart = 10 + 6.5 * (charsBeforeSecond / parentText.length);
  assert.ok(second.speechStartSec - charShareStart > 1.0,
    `char-share timing would start the 2nd sentence too early (char-share ${charShareStart.toFixed(2)} vs speech 15.00)`);
});

test("word timing D: semantic segmentation unchanged by word timing — same text boundaries", () => {
  const parentText = "My father had already gone to bed when he remembered that he still needed to take his medication.";
  const words = buildWords(
    parentText.split(/\s+/).map((t, i) => [t.replace(/[^a-z']/gi, ""), 0.1 + i * 0.28, 0.24 + i * 0.28]),
  );
  const cue = {startSec: 50, endSec: 56.383, text: parentText};
  const withWords = expandCue(cue, undefined, words, 50);
  const withoutWords = expandCue(cue);
  assert.deepEqual(
    withWords.map((c) => c.text),
    withoutWords.map((c) => c.text),
    "word timing must not change WHAT text is grouped",
  );
});

test("word timing E: cue text maps to correct word boundaries, incl. punctuation and repeats", () => {
  const words = buildWords([
    ["Well", 0.0, 0.4], ["well", 0.9, 1.3], ["said", 1.3, 1.8], ["friend", 1.8, 2.4],
  ]);
  const m1 = mapCueTextToWords("Well, well.", words, 0);
  assert.equal(m1.firstIndex, 0);
  assert.equal(m1.lastIndex, 1);
  assert.equal(m1.cursor, 2);
  const m2 = mapCueTextToWords("said friend!", words, m1.cursor);
  assert.equal(m2.firstIndex, 2);
  assert.equal(m2.lastIndex, 3);
  assert.equal(m2.speechStartSec, 1.3);
  assert.equal(m2.speechEndSec, 2.4);
  assert.equal(mapCueTextToWords("totally absent word", words, 0), null, "unmatched text must fail mapping");
});

test("word timing G: full word coverage — no word lost between sibling cues", () => {
  const parentText = "One two three four five six seven eight nine ten eleven twelve.";
  const tokens = ["One", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
  const words = buildWords(tokens.map((t, i) => [t, i * 0.3, i * 0.3 + 0.25]));
  const children = expandCue({startSec: 0, endSec: 3.6, text: parentText}, undefined, words);
  assert.equal(children[0].wordStartIndex, 0, "first child starts at word 0");
  assert.equal(children.at(-1).wordEndIndex, words.length - 1, "last child ends at final word");
  for (let i = 1; i < children.length; i += 1) {
    assert.equal(children[i].wordStartIndex, children[i - 1].wordEndIndex + 1, "word ranges are contiguous");
  }
});

test("word timing H: block offset converts relative word timing to the global assembly timeline", () => {
  const words = buildWords([
    ["Hello", 0.35, 0.70], ["there", 0.70, 1.10], ["again", 1.10, 1.60],
  ]);
  const [only] = expandCue({startSec: 24.36, endSec: 25.96, text: "Hello there again"}, undefined, words, 24.36);
  assert.equal(only.speechStartSec, 24.71, "speech start = word start + block offset");
  assert.equal(only.speechEndSec, 25.96, "speech end = word end + block offset");
  assert.equal(only.timingSource, "edge-word-boundary");
});

test("word timing I: legacy fallback is explicitly identified, never silent", () => {
  const cue = {startSec: 0, endSec: 6.4, text: "My father had already gone to bed when he remembered that he still needed to take his medication."};
  const split = expandCue(cue);
  assert.ok(split.length > 1);
  for (const c of split) {
    assert.equal(c.timingSource, "char-estimate", "generated children without word timing must be marked char-estimate");
    assert.equal(c.speechStartSec, undefined, "no fake speech timing on fallback cues");
  }
  const single = expandCue({startSec: 0, endSec: 3, text: "Someone falls."});
  assert.equal(single[0].timingSource, "legacy-vtt");
});

test("word timing: unmatchable artifact falls back to char-estimate instead of failing the render", () => {
  const words = buildWords([["unrelated", 0.0, 0.5], ["tokens", 0.5, 1.0]]);
  const cue = {startSec: 0, endSec: 6.4, text: "My father had already gone to bed when he remembered that he still needed to take his medication."};
  const children = expandCue(cue, undefined, words);
  for (const c of children) assert.equal(c.timingSource, "char-estimate");
});

// ===========================================================================
// Canonical production-integration tests (per-generation policy, cache identity)
// ===========================================================================
import {mkdtemp, mkdir, rm, writeFile, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {buildSubtitleTimeline} from "./_build-subtitle-timeline.mjs";

test("policy: new-generation manifest REQUIRES word timing — missing artifact fails QA", async () => {
  const {root, project} = await makeFixtureEpisode({manifestPolicy: "word-boundary-required", withWords: false});
  try {
    const report = (await buildSubtitleTimeline({root, episode: "FIX-0001"})).report;
    assert.equal(report.timingIntegrity.status, "fail", "missing word timing must FAIL");
    assert.equal(report.passed, false);
    assert.equal(report.timingIntegrity.manifestPolicy, "word-boundary-required");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("policy: valid word timing on new-generation manifest passes and uses word timing", async () => {
  const {root} = await makeFixtureEpisode({manifestPolicy: "word-boundary-required", withWords: true});
  try {
    const report = (await buildSubtitleTimeline({root, episode: "FIX-0001"})).report;
    assert.equal(report.timingIntegrity.status, "pass");
    assert.equal(report.passed, true);
    assert.equal(report.timingSourceCounts["edge-word-boundary"] > 0, true);
    assert.equal(report.timingSourceCounts["char-estimate"], undefined, "no silent char-estimate fallback");
    assert.equal(report.timingIntegrity.wordCoverageRatio, 1);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("policy: legacy manifest (no policy) warns but passes, fallback explicitly listed", async () => {
  const {root} = await makeFixtureEpisode({manifestPolicy: null, withWords: false});
  try {
    const report = (await buildSubtitleTimeline({root, episode: "FIX-0001"})).report;
    assert.equal(report.timingIntegrity.status, "warn");
    assert.equal(report.passed, true, "legacy episodes must not break");
    assert.deepEqual(report.timingIntegrity.fallbackBlocks, ["sentence-001"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("cache identity: word-timing artifact with mismatched identity is rejected", async () => {
  const {root} = await makeFixtureEpisode({
    manifestPolicy: "word-boundary-required", withWords: true, matchesManifest: false,
  });
  try {
    await assert.rejects(
      () => buildSubtitleTimeline({root, episode: "FIX-0001"}),
      /cache identity mismatch/,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("canonical fixture artifact stays readable (sanity)", async () => {
  const {root, project} = await makeFixtureEpisode({manifestPolicy: "word-boundary-required", withWords: true});
  try {
    const artifact = JSON.parse(await readFile(path.join(project, "temp", "sentence-001.words.json"), "utf8"));
    assert.equal(artifact.timingSource, "edge-tts-word-boundary");
    assert.equal(artifact.cacheIdentity.matchesManifest, true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

async function makeFixtureEpisode({manifestPolicy, withWords, matchesManifest = true, coldOpen = false}) {
  const root = await mkdtemp(path.join(tmpdir(), "essy-wt-fixture-"));
  const project = path.join(root, "projects", "FIX-0001");
  await mkdir(path.join(project, "temp"), {recursive: true});
  const text = "First sentence ends here. Second sentence begins now.";
  const words = [
    ["First", 0.00, 0.30], ["sentence", 0.30, 0.70], ["ends", 0.70, 1.00], ["here", 1.00, 1.30],
    ["Second", 2.00, 2.30], ["sentence", 2.30, 2.75], ["begins", 2.75, 3.20], ["now", 3.20, 3.50],
  ].map(([t, s, e]) => ({text: t, startSec: s, endSec: e}));
  await writeFile(path.join(project, "temp", "sentence-001.vtt"),
    `WEBVTT\n\n00:00:00,000 --> 00:00:03,500\n${text}\n`, "utf8");
  if (withWords) {
    await writeFile(path.join(project, "temp", "sentence-001.words.json"), JSON.stringify({
      schemaVersion: "1.0",
      sentenceId: "sentence-001",
      blockId: "n001",
      timingSource: "edge-tts-word-boundary",
      cacheIdentity: {textSha256: "x", matchesManifest, audioDurationSec: 3.6, tts: {}},
      validation: {wordCount: words.length, lastWordEndSec: 3.5, fitsAudioDuration: true},
      words,
    }), "utf8");
  }
  const blocks = [{sentenceId: "sentence-001", startSec: 0, endSec: 3.6}];
  if (coldOpen) {
    // Title-card block N002: has narration audio + VTT (which the regression
    // must EXCLUDE from subtitles) and a production-package cold-open window.
    await mkdir(path.join(root, "projects", "_drafts", "FIX-0001"), {recursive: true});
    await writeFile(path.join(project, "temp", "sentence-002.vtt"),
      "WEBVTT\n\n00:00:00,000 --> 00:00:06,400\nA Second Look at Life\n\n00:00:06,400 --> 00:00:06,900\nFixture Episode Title\n", "utf8");
    await writeFile(path.join(root, "projects", "_drafts", "FIX-0001", "production-package.json"), JSON.stringify({
      packaging: {
        coldOpenExperiment: {
          id: "cold-open-fixture",
          suppressBlockNarration: true,
          titleCards: [
            {kind: "channel", text: "A Second Look at Life", startSec: 4.1, endSec: 6.6, blockId: "n002"},
            {kind: "episode", text: "Fixture Episode Title", startSec: 7.1, endSec: 9.9, blockId: "n002"},
          ],
        },
      },
    }), "utf8");
    blocks.push({sentenceId: "sentence-002", startSec: 3.6, endSec: 10.0});
  }
  await writeFile(path.join(project, "manifest.json"), JSON.stringify({
    schemaVersion: "1.0",
    episode: "FIX-0001",
    ...(manifestPolicy ? {subtitleTiming: {policy: manifestPolicy, schemaVersion: "1.0"}} : {}),
  }), "utf8");
  await writeFile(path.join(project, "assembly-timeline.json"), JSON.stringify({blocks}), "utf8");
  return {root, project};
}

test("cold-open parity: metadata-defined title-card block never becomes a subtitle; spoken narration and timing intact", async () => {
  const {root} = await makeFixtureEpisode({
    manifestPolicy: "word-boundary-required", withWords: true, coldOpen: true,
  });
  try {
    const {cues, report} = await buildSubtitleTimeline({root, episode: "FIX-0001"});
    // Title-card text must NOT become subtitle cues...
    assert.equal(cues.some((c) => /A Second Look at Life|Fixture Episode Title/i.test(c.text)), false,
      "title-card narration text must be excluded from subtitles");
    // ...while the spoken block remains fully intact...
    assert.ok(cues.some((c) => c.text.includes("Second sentence begins now")), "spoken cues intact");
    assert.equal(cues.filter((c) => c.blockId === "sentence-001").length > 0, true);
    // ...and total assembly timing does not shift (last block window unchanged).
    assert.ok(report.passed, "QA passes with the cold-open fixture");
    const lastBoundary = report.narrationBlockBoundaries.at(-1);
    assert.equal(lastBoundary.nextFirstStartSec, 3.6, "N002 window timing preserved");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------
// P1 still-image motion policy (scripts/_still-motion.mjs)
// ---------------------------------------------------------------------------
import {readFileSync} from "node:fs";
import {
  resolveStillMotion,
  stillImageFilter,
  SLOW_PUSH_ZOOM_MAX,
  STILL_MOTION_VALUES,
} from "./_still-motion.mjs";

const FILTER_ARGS = {width: 960, height: 540, fps: 25, frameCount: 200};

test("still motion A: absent stillMotion metadata -> STATIC (no zoompan)", () => {
  const f = stillImageFilter({...FILTER_ARGS, stillMotion: resolveStillMotion({slotId: "N001-S1"})});
  assert.ok(!f.includes("zoompan"), "static must not use zoompan");
  assert.ok(f.includes("crop="), "static must scale+crop");
});

test("still motion B: stillMotion='static' -> STATIC", () => {
  const f = stillImageFilter({...FILTER_ARGS, stillMotion: resolveStillMotion({stillMotion: "static"})});
  assert.ok(!f.includes("zoompan"));
});

test("still motion C: stillMotion='slow-push' -> stable center push", () => {
  const motion = resolveStillMotion({stillMotion: "slow-push"});
  const f = stillImageFilter({...FILTER_ARGS, stillMotion: motion});
  assert.ok(f.includes("zoompan"), "slow-push uses zoompan");
  // Fixed center anchor: exact center x/y for every frame.
  assert.ok(f.includes("x='(iw-iw/zoom)/2'"), "center anchor x");
  assert.ok(f.includes("y='(ih-ih/zoom)/2'"), "center anchor y");
  // Scale-only, spans the full shot, no alternation.
  assert.ok(f.includes(`1+(${SLOW_PUSH_ZOOM_MAX}-1)*on/199`), "linear ramp over full frameCount");
  assert.ok(!f.includes("min(zoom+"), "no legacy clamped zoom that freezes early");
  // 4x supersample quantization then lanczos downscale.
  assert.ok(f.includes("zoompan"), "uses zoompan");
  assert.ok(f.includes("s=3840x2160"), "quantizes at 4x supersample");
  assert.ok(f.trimEnd().endsWith("flags=lanczos"), "ends with lanczos downscale");
});

test("still motion D: shot index does NOT affect motion selection", () => {
  for (const index of [0, 1, 2, 5, 9]) {
    assert.equal(resolveStillMotion({index}), "static", `index ${index} no metadata`);
    assert.equal(resolveStillMotion({index, stillMotion: "static"}), "static");
    assert.equal(resolveStillMotion({index, stillMotion: "slow-push"}), "slow-push");
  }
  // Same treatment regardless of index parity.
  assert.equal(
    stillImageFilter({...FILTER_ARGS, stillMotion: "slow-push"}),
    stillImageFilter({...FILTER_ARGS, stillMotion: "slow-push"}),
  );
});

test("still motion E: review and final resolve the SAME shared semantics", () => {
  const review = readFileSync("scripts/render-lesson.mjs", "utf8");
  const final = readFileSync("scripts/render-essay-final.mjs", "utf8");
  const imp = "from \"./_still-motion.mjs\"";
  assert.ok(review.includes(imp), "review renderer imports shared policy");
  assert.ok(final.includes(imp), "final renderer imports shared policy");
  for (const src of [review, final]) {
    assert.ok(src.includes("resolveStillMotion(shot)"), "renderers resolve per shot");
    assert.ok(!src.includes("blockShotIndex % 2"), "no index-parity motion");
  }
  assert.ok(!/kenBurnsFilter\(/.test(final), "final renderer has no legacy Ken Burns");
  assert.ok(
    review.includes('lesson.series === "ESSY"'),
    "review renderer branches ESSY to shared policy",
  );
  assert.ok(
    review.includes("? stillImageFilter({width, height, fps, frameCount, stillMotion})"),
    "review renderer uses shared stillImageFilter for ESSY stills",
  );
});

test("still motion F: video assets unaffected + unsupported values fall back to STATIC", () => {
  // Renderers only call the policy for photo shots; video path untouched.
  const review = readFileSync("scripts/render-lesson.mjs", "utf8");
  assert.ok(review.includes('shot.mediaType === "photo"'), "video shots bypass still-motion filter");
  assert.deepEqual(STILL_MOTION_VALUES, ["static", "slow-push"], "canonical values");
  assert.equal(resolveStillMotion({stillMotion: "slow-pull"}), "static", "slow-pull not canonical yet");
  assert.equal(resolveStillMotion({stillMotion: "pan"}), "static", "pan not canonical yet");
  assert.equal(resolveStillMotion({stillMotion: ""}), "static");
});

let failed = 0;
for (const {name, fn} of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
console.log(failed === 0 ? "\nAll segmentation regression tests passed." : `\n${failed} test(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);