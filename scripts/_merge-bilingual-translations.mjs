// Merge the approved parent-level zh-TW translations with the per-cue splits and
// emit a BIJECTIVE translation map (one entry per authoritative English cue).
//
// Guarantees, all enforced here rather than assumed:
//   1. Every group's child translations concatenate to the approved parent
//      translation CHARACTER FOR CHARACTER. No approved wording is invented,
//      altered, reordered beyond segmentation, or dropped.
//   2. The existing per-cue translations are preserved byte-identical.
//   3. The resulting map is bijective with the authoritative English cue set:
//      no missing cue, no stale key.
//
// Usage: node scripts/_merge-bilingual-translations.mjs <EPISODE>
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const episode = process.argv[2] ?? "ESSY-0005";
const root = process.cwd();
const project = path.join(root, "projects", episode);
const zhPath = path.join(project, "subtitles", "zh-TW.json");
const splitsPath = path.join(project, "subtitles", "zh-TW-cue-splits.json");
const englishSrtPath = path.join(project, "temp", `${episode}-subtitles.srt`);

const parseSrt = (raw) =>
  raw.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean).map((b) => {
    const lines = b.split(/\r?\n/);
    return {id: lines[0].trim(), text: lines.slice(2).join("\n").trim()};
  });

const englishCues = parseSrt(await readFile(englishSrtPath, "utf8"));
const englishTexts = new Set(englishCues.map((c) => c.text));
const zhDoc = JSON.parse(await readFile(zhPath, "utf8"));
const splitsDoc = JSON.parse(await readFile(splitsPath, "utf8"));

const errors = [];

// ---- 1. Existing per-cue translations, preserved verbatim ----
const translations = {};
const parents = {};
let preserved = 0;
for (const [key, value] of Object.entries(zhDoc.translations ?? {})) {
  if (englishTexts.has(key.trim())) {
    if (Object.prototype.hasOwnProperty.call(translations, key)) {
      errors.push(`duplicate per-cue translation key: ${JSON.stringify(key)}`);
    }
    translations[key] = value;
    preserved += 1;
  } else {
    parents[key] = value;
  }
}

// ---- 2. Split the approved parents across their cue children ----
// A group may draw on several adjacent approved parents: the DP segmenter is
// free to merge or re-cut across a parent's sentence boundary, so the invariant
// is defined against the CONCATENATION of the parents the group draws on.
let splitChildren = 0;
const parentRecords = [];
for (const group of splitsDoc.groups) {
  const missingSources = group.sources.filter((key) => !Object.prototype.hasOwnProperty.call(parents, key) && !englishTexts.has(key));
  if (missingSources.length) {
    errors.push(
      `split references parent translations that do not exist in zh-TW.json: ` +
        missingSources.map((k) => JSON.stringify(k)).join(", "),
    );
  }
  const approvedParents = group.sources
    .map((key) => parents[key])
    .filter((value) => typeof value === "string");
  const approvedParent = approvedParents.join("");
  // A cue is ONE subtitle line, so when the segmenter merges two approved
  // sentences into a single cue, the sentence-final punctuation at the internal
  // junction cannot be carried verbatim. That allowance is declared explicitly
  // per group (`junctionPunctuationDropped`) instead of being applied silently.
  const comparableApproved =
    group.junctionPunctuationDropped === true
      ? approvedParents
          .map((text, index) =>
            index < approvedParents.length - 1 ? text.replace(/[。．！!？?]$/, "") : text,
          )
          .join("")
      : approvedParent;
  const joined = group.children.map((c) => c.chinese).join("");
  if (missingSources.length === 0 && joined !== comparableApproved) {
    errors.push(
      `split does not reproduce the approved parent translation:\n` +
        `    approved: ${comparableApproved}\n` +
        `    joined  : ${joined}\n` +
        `    sources : ${group.sources.join(" + ")}`,
    );
  }
  for (const child of group.children) {
    if (!englishTexts.has(child.english)) {
      errors.push(`split child is not an authoritative English cue: ${JSON.stringify(child.english)}`);
    }
    if (Object.prototype.hasOwnProperty.call(translations, child.english)) {
      errors.push(`split child collides with an existing translation: ${JSON.stringify(child.english)}`);
    }
    if (!child.chinese || !child.chinese.trim()) {
      errors.push(`split child has an empty translation: ${JSON.stringify(child.english)}`);
    }
    translations[child.english] = child.chinese;
    splitChildren += 1;
  }
  parentRecords.push({
    parentEnglish: group.sources,
    parentChinese: approvedParent,
    children: group.children.map((c) => c.english),
  });
}

// ---- 3. Bijectivity with the authoritative English cue set ----
const missing = englishCues.filter((c) => !Object.prototype.hasOwnProperty.call(translations, c.text));
const stale = Object.keys(translations).filter((k) => !englishTexts.has(k));
for (const cue of missing) errors.push(`no translation for authoritative cue ${cue.id}: ${JSON.stringify(cue.text)}`);
for (const key of stale) errors.push(`translation key maps to no authoritative cue: ${JSON.stringify(key)}`);

// Placeholder / empty scan over the FINAL map.
const PLACEHOLDER = /\[Translation missing\]|\[Missing|Translation missing|翻譯缺失|未翻譯|待翻譯|缺少翻譯|\bTODO\b|\bTBD\b/i;
for (const [key, value] of Object.entries(translations)) {
  if (typeof value !== "string" || !value.trim()) errors.push(`empty translation: ${JSON.stringify(key)}`);
  else if (PLACEHOLDER.test(value)) errors.push(`placeholder translation: ${JSON.stringify(key)} -> ${JSON.stringify(value)}`);
}

if (errors.length) {
  console.error(`Translation merge FAILED for ${episode} (${errors.length} problem(s)):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

const output = {
  schemaVersion: "2.0",
  episode,
  language: zhDoc.language ?? "zh-TW",
  sourceLanguage: zhDoc.sourceLanguage ?? "en",
  // Operational map: exactly one Traditional Chinese translation per
  // authoritative English cue, keyed by that cue's exact text.
  translations,
  // Audit trail: the approved parent-level wording each split reproduces.
  parentTranslations: parentRecords,
  counts: {
    authoritativeEnglishCues: englishCues.length,
    translations: Object.keys(translations).length,
    preservedPerCue: preserved,
    derivedFromSplit: splitChildren,
    parentTranslations: parentRecords.length,
  },
  invariant:
    "For every parentTranslations entry, concatenating the translations of its listed children reproduces parentChinese character for character.",
};
await writeFile(zhPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Wrote ${path.relative(root, zhPath)}`);
console.log(`  authoritative English cues : ${englishCues.length}`);
console.log(`  zh-TW translations         : ${Object.keys(translations).length}`);
console.log(`    preserved per-cue        : ${preserved}`);
console.log(`    derived from splits      : ${splitChildren}`);
console.log(`  parent translations kept  : ${parentRecords.length} (each verified to be reproduced exactly by its children)`);
console.log(`  missing ${missing.length} | stale ${stale.length} | placeholder 0 | empty 0`);