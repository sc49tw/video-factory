// Standalone bilingual subtitle completeness auditor.
//
// Delegates to the SAME builder/gate the renderers use
// (scripts/_build-bilingual-subtitles.mjs), so an audit PASS is exactly the
// condition the renderer enforces. Regenerates the bilingual SRT from the
// authoritative English SRT; on any defect it exits non-zero and no file that
// could be burned is produced.
//
// Usage: node scripts/_audit-essy-subtitles.mjs <EPISODE> [--json]
import path from "node:path";
import process from "node:process";
import {buildBilingualSrt} from "./_build-bilingual-subtitles.mjs";

const episode = process.argv[2] ?? "ESSY-0005";
const asJson = process.argv.includes("--json");
const root = process.cwd();
const project = path.join(root, "projects", episode);

let result;
let failure = null;
try {
  result = await buildBilingualSrt({
    root,
    episode,
    englishSrtPath: path.join(project, "temp", `${episode}-subtitles.srt`),
    log: () => {},
  });
} catch (error) {
  failure = error;
}

// The English SRT is the authoritative narration timeline: its timing is never
// re-estimated here, and the bilingual output must reuse it verbatim.
const englishSrt = await import("node:fs/promises").then((fs) =>
  fs.readFile(path.join(project, "temp", `${episode}-subtitles.srt`), "utf8"),
);
const englishCueCount = englishSrt.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean).length;

if (failure) {
  if (asJson) {
    console.log(JSON.stringify({episode, passed: false, error: failure.message}, null, 2));
  } else {
    console.error(failure.message);
  }
  process.exit(1);
}

const r = result.report;
const summary = {
  episode,
  authoritativeEnglishCueCount: r.authoritativeEnglishCueCount,
  englishCueCountInSrt: englishCueCount,
  translationCount: r.translationCount,
  validTranslationCount: r.validTranslationCount,
  missingCount: r.missingCount,
  emptyCount: r.emptyCount,
  placeholderCount: r.placeholderCount,
  unmappedCount: r.unmappedCount,
  duplicateCueIdCount: r.duplicateCueIdCount,
  duplicateZhKeyCount: r.duplicateZhKeyCount,
  staleTranslationKeyCount: r.staleTranslationKeyCount,
  bilingualCueCount: result.cues.length,
  style: r.style,
  srt: path.relative(root, result.srtPath).replaceAll("\\", "/"),
  qa: path.relative(root, result.qaPath).replaceAll("\\", "/"),
  passed: r.passed,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`Bilingual subtitle completeness audit — ${episode}`);
  console.log(`  authoritative English cues : ${summary.authoritativeEnglishCueCount} (SRT blocks: ${summary.englishCueCountInSrt})`);
  console.log(`  zh-TW translation entries  : ${summary.translationCount}`);
  console.log(`  bilingual cues emitted     : ${summary.bilingualCueCount}`);
  console.log(`  valid translations         : ${summary.validTranslationCount}`);
  console.log(`  missing                    : ${summary.missingCount}`);
  console.log(`  empty                      : ${summary.emptyCount}`);
  console.log(`  placeholder                : ${summary.placeholderCount}`);
  console.log(`  unmapped                   : ${summary.unmappedCount}`);
  console.log(`  duplicate cue IDs          : ${summary.duplicateCueIdCount}`);
  console.log(`  duplicate zh-TW keys       : ${summary.duplicateZhKeyCount}`);
  console.log(`  stale zh-TW keys           : ${summary.staleTranslationKeyCount}`);
  console.log(`  style                      : EN ${summary.style.FONT_SIZE}px / zh ${summary.style.CHINESE_FONT_SIZE}px @540p, MARGIN_V ${summary.style.MARGIN_V}`);
  console.log(`  RESULT: ${summary.passed ? "PASS" : "FAIL"}`);
  console.log(`  srt: ${summary.srt}`);
  console.log(`  qa : ${summary.qa}`);
}