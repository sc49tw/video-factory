// Regression tests for the bilingual subtitle completeness gate.
//
// The gate exists because a hand-maintained bilingual SRT shipped 84
// "[Translation missing]" cues: the approved zh-TW translations were keyed by
// PARENT sentence, while the authoritative English SRT contains the DP
// segmenter's CHILDREN, so every split parent silently lost its translation.
//
// These tests pin the failure modes that produced it.
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BILINGUAL_STYLE,
  buildBilingualSrt,
  findPlaceholderReasons,
  parseSrt,
} from "./_build-bilingual-subtitles.mjs";

const srtTime = (sec) => {
  const ms = Math.round(sec * 1000);
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
};

const buildSrt = (cues) =>
  cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`)
    .join("\n\n") + "\n";

async function scaffold({cues, translations}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "bilingual-gate-"));
  const episode = "TEST-0001";
  await mkdir(path.join(root, "projects", episode, "temp"), {recursive: true});
  await mkdir(path.join(root, "projects", episode, "subtitles"), {recursive: true});
  const englishSrtPath = path.join(root, "projects", episode, "temp", `${episode}-subtitles.srt`);
  await writeFile(englishSrtPath, buildSrt(cues), "utf8");
  await writeFile(
    path.join(root, "projects", episode, "subtitles", "zh-TW.json"),
    JSON.stringify({episode, language: "zh-TW", sourceLanguage: "en", translations}, null, 2),
    "utf8",
  );
  return {root, episode, englishSrtPath};
}

const THREE = [
  {start: 0.1, end: 2.0, text: "First line here."},
  {start: 2.1, end: 4.0, text: "Second line here."},
  {start: 4.1, end: 6.0, text: "Third line here."},
];

test("placeholder detection covers every shipped failure string", () => {
  assert.deepEqual(findPlaceholderReasons(undefined), ["absent"]);
  assert.deepEqual(findPlaceholderReasons("   "), ["empty"]);
  assert.ok(findPlaceholderReasons("[Translation missing]").some((r) => r.startsWith("placeholder")));
  assert.ok(findPlaceholderReasons("翻譯缺失").some((r) => r.startsWith("placeholder")));
  assert.ok(findPlaceholderReasons("未翻譯").some((r) => r.startsWith("placeholder")));
  assert.ok(findPlaceholderReasons("TODO").some((r) => r.startsWith("placeholder")));
  assert.deepEqual(findPlaceholderReasons("我沒有問題。"), []);
});

test("complete translation set builds 1:1 bilingual cues with English timing preserved", async () => {
  const {root, episode, englishSrtPath} = await scaffold({
    cues: THREE,
    translations: {
      "First line here.": "第一行。",
      "Second line here.": "第二行。",
      "Third line here.": "第三行。",
    },
  });
  const {srtPath, report, cues} = await buildBilingualSrt({
    root, episode, englishSrtPath, log: () => {},
  });
  assert.equal(report.passed, true);
  assert.equal(report.missingCount, 0);
  assert.equal(report.placeholderCount, 0);
  assert.equal(report.unmappedCount, 0);
  assert.equal(cues.length, 3);

  const english = parseSrt(await readFile(englishSrtPath, "utf8"));
  const bilingual = parseSrt(await readFile(srtPath, "utf8"));
  assert.equal(bilingual.length, english.length);
  for (const [index, cue] of bilingual.entries()) {
    // Timing is the authoritative English timing, never re-derived.
    assert.equal(cue.timecode, english[index].timecode);
    assert.ok(cue.text.startsWith(english[index].text));
    assert.ok(cue.text.includes("第一行") || cue.text.includes("第二行") || cue.text.includes("第三行"));
    assert.ok(!cue.text.includes("[Translation missing]"));
  }
  // Cue IDs are renumbered 1..N with no duplicates.
  assert.deepEqual(bilingual.map((c) => c.id), ["1", "2", "3"]);
});

test("a missing translation aborts and writes no burnable SRT", async () => {
  const {root, episode, englishSrtPath} = await scaffold({
    cues: THREE,
    translations: {"First line here.": "第一行。", "[Translation missing]": ""},
  });
  await assert.rejects(
    () => buildBilingualSrt({root, episode, englishSrtPath, log: () => {}}),
    (error) => {
      assert.match(error.message, /completeness gate FAILED/);
      assert.match(error.message, /missing\s*:\s*2/);
      return true;
    },
  );
});

test("a placeholder translation aborts even when the count matches", async () => {
  const {root, episode, englishSrtPath} = await scaffold({
    cues: THREE,
    translations: {
      "First line here.": "第一行。",
      "Second line here.": "[Translation missing]",
      "Third line here.": "第三行。",
    },
  });
  await assert.rejects(
    () => buildBilingualSrt({root, episode, englishSrtPath, log: () => {}}),
    /placeholder\s*:\s*1/,
  );
});

test("an empty translation aborts", async () => {
  const {root, episode, englishSrtPath} = await scaffold({
    cues: THREE,
    translations: {
      "First line here.": "第一行。",
      "Second line here.": "   ",
      "Third line here.": "第三行。",
    },
  });
  await assert.rejects(() => buildBilingualSrt({root, episode, englishSrtPath, log: () => {}}), /empty\s*:\s*1/);
});

test("a stale translation key aborts, keeping the mapping bijective", async () => {
  const {root, episode, englishSrtPath} = await scaffold({
    cues: THREE,
    translations: {
      "First line here.": "第一行。",
      "Second line here.": "第二行。",
      "Third line here.": "第三行。",
      "A parent sentence the segmenter no longer emits.": "舊的。",
    },
  });
  await assert.rejects(
    () => buildBilingualSrt({root, episode, englishSrtPath, log: () => {}}),
    /stale zh-TW keys \(no EN cue\)\s*:\s*1/,
  );
});

test("duplicate English cue IDs abort", async () => {
  const {root, episode, englishSrtPath} = await scaffold({
    cues: [
      {start: 0.1, end: 2.0, text: "First line here."},
      {start: 2.1, end: 4.0, text: "Second line here."},
    ],
    translations: {"First line here.": "第一行。", "Second line here.": "第二行。"},
  });
  // Rewrite the SRT with a duplicated cue index.
  const raw = await readFile(englishSrtPath, "utf8");
  await writeFile(englishSrtPath, raw.replace(/\n2\n/, "\n1\n"), "utf8");
  await assert.rejects(
    () => buildBilingualSrt({root, episode, englishSrtPath, log: () => {}}),
    /duplicate cue IDs\s*:\s*1/,
  );
});

test("duplicate translation keys abort", async () => {
  const {root, episode, englishSrtPath} = await scaffold({
    cues: THREE,
    translations: {
      "First line here.": "第一行。",
      "Second line here.": "第二行。",
      "Third line here.": "第三行。",
    },
  });
  const zhPath = path.join(root, "projects", episode, "subtitles", "zh-TW.json");
  await writeFile(
    zhPath,
    // A key that normalizes onto an existing one (whitespace/case/dash/quotes).
    JSON.stringify(
      {
        episode,
        language: "zh-TW",
        sourceLanguage: "en",
        translations: {
          "First line here.": "第一行。",
          "First  Line Here.": "重複。",
          "Second line here.": "第二行。",
          "Third line here.": "第三行。",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await assert.rejects(
    () => buildBilingualSrt({root, episode, englishSrtPath, log: () => {}}),
    /duplicate zh-TW keys\s*:\s*1/,
  );
});

test("whitespace and punctuation variants still map 1:1", async () => {
  const cues = [
    {start: 0.1, end: 2.0, text: "He said — “no”, then left."},
    {start: 2.1, end: 4.0, text: "Second line here."},
  ];
  const {root, episode, englishSrtPath} = await scaffold({
    cues,
    translations: {
      // Straight quotes and a spaced dash: same prose, different glyphs.
      "He said - \"no\", then left.": "他說「不」，然後離開。",
      "Second line here.": "第二行。",
    },
  });
  const {report} = await buildBilingualSrt({root, episode, englishSrtPath, log: () => {}});
  assert.equal(report.passed, true);
  assert.equal(report.missingCount, 0);
});

test("bilingual style keeps English at 28px and Chinese at 18px", () => {
  assert.equal(BILINGUAL_STYLE.FONT_SIZE, 28);
  assert.equal(BILINGUAL_STYLE.CHINESE_FONT_SIZE, 18);
  assert.equal(BILINGUAL_STYLE.MARGIN_V, 64);
});

test("malformed SRT timecodes are rejected rather than silently accepted", () => {
  assert.throws(() => parseSrt("1\n00:00:00.100 --> 00:00:02.000\nText\n"), /Malformed SRT timecode/);
});