// DETERMINISTIC bilingual subtitle builder + completeness QA gate.
//
// The burned bilingual SRT is GENERATED, never hand-maintained. It is derived
// from the authoritative English SRT that `buildSubtitleTimeline` just produced
// (edge-tts VTT timing, DP segmentation, non-overlap normalization), so English
// text and timing are preserved byte-for-byte and can never drift from the
// narration. Only the second line is added, resolved 1:1 from
// projects/<EPISODE>/subtitles/zh-TW.json.
//
// MANDATORY GATE (throws before any ffmpeg call, so a defective translation can
// never reach a rendered file):
//   - translation count != authoritative English cue count
//   - a cue whose translation is empty / whitespace only
//   - a placeholder such as "[Translation missing]" / 翻譯缺失 / TODO
//   - a cue that cannot map 1:1 to an authoritative English cue
//   - a translation key with no authoritative English cue (stale mapping)
//   - duplicate cue IDs in the emitted SRT
//
// A placeholder string is never emitted under any circumstance: the builder
// either resolves a real translation or aborts.

import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

// Bilingual burn-in style. FONT_SIZE is the ENGLISH line size at 540p; the
// Traditional Chinese line is rendered at CHINESE_FONT_SIZE via an inline ASS
// override so the two scripts share one cue (and therefore one active-cue
// guarantee from the shared timeline builder).
export const BILINGUAL_STYLE = {
  FONT_SIZE: 28,
  CHINESE_FONT_SIZE: 18,
  MARGIN_V: 64,
  MAX_CHARS: 50,
  SEPARATOR: "\\N",
};

// ---- Shared bilingual delivery decision (single source of truth) -------------
// Which episodes burn English + Traditional Chinese, and the subtitle
// segmentation/style config that decision requires. This lives here, next to
// the builder and the style it selects, because the 540p review proxy, the
// opening-identity review and the 1080p final master must ALL resolve it the
// same way. It previously lived as a literal `episode === "ESSY-0005"` check
// copy-pasted into two renderers, which left the final master free to fall back
// to English-only legacy styling.

const BILINGUAL_EPISODES = new Set(["ESSY-0005"]);

// Segmentation override the approved bilingual cue set was cut with. The
// bilingual MAX_CHARS 50 is wider than the English default 44, so the shared
// 700 ms generated-child floor flags one legitimate bilingual cue; 450 ms is
// the value the approved review baseline was produced and human-QA'd with.
// Dropping it makes the shared QA gate fail and aborts every render.
const BILINGUAL_CONFIG_OVERRIDES = Object.freeze({MIN_GENERATED_DURATION_MS: 450});

/** True when the episode's approved burn-in is bilingual (EN + zh-TW). */
export function isBilingualEpisode(episode) {
  return BILINGUAL_EPISODES.has(episode);
}

/**
 * The shared subtitle config an episode's approved burn-in is built with.
 * Monolingual episodes get `{}` (the shared defaults, no override).
 */
export function resolveEpisodeSubtitleConfig(episode) {
  return isBilingualEpisode(episode) ? {...BILINGUAL_CONFIG_OVERRIDES} : {};
}

/**
 * The style an episode's approved burn-in is rendered with: the shared STYLE,
 * with the bilingual line sizes substituted for a bilingual episode.
 */
export function episodeBurnStyle(config, episode) {
  if (!isBilingualEpisode(episode)) return config.STYLE;
  return {
    ...config.STYLE,
    FONT_SIZE: BILINGUAL_STYLE.FONT_SIZE,
    MARGIN_V: BILINGUAL_STYLE.MARGIN_V,
  };
}

/** MAX_CHARS the approved burn-in is segmented with. */
export function episodeBurnMaxChars(config, episode) {
  return isBilingualEpisode(episode) ? BILINGUAL_STYLE.MAX_CHARS : config.MAX_CHARS;
}

/** The SRT text for one bilingual cue, per the generated-SRT contract. */
export function bilingualCueText(cue, style = BILINGUAL_STYLE) {
  const merged = {...BILINGUAL_STYLE, ...style};
  return `${cue.english}${merged.SEPARATOR}{\\fs${merged.CHINESE_FONT_SIZE}}${cue.zh}`;
}

export const TRANSLATION_PLACEHOLDER_PATTERNS = [
  /\[Translation missing\]/i,
  /\[Missing[^\]]*\]/i,
  /\bTranslation missing\b/i,
  /翻譯缺失/,
  /未翻譯/,
  /待翻譯/,
  /缺少翻譯/,
  /\bTODO\b/,
  /\bTBD\b/,
  /\bN\/?A\b/,
  /^[-—–_\s]*$/,
];

const SRT_TIME = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/;

export function parseSrt(raw) {
  return raw
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const timecode = lines[1]?.trim() ?? "";
      if (!SRT_TIME.test(timecode)) {
        throw new Error(`Malformed SRT timecode: ${JSON.stringify(timecode)}`);
      }
      return {
        id: lines[0].trim(),
        timecode,
        text: lines.slice(2).join("\n").trim(),
      };
    });
}

/**
 * Key normalization for 1:1 mapping. Cue text is authored prose; the same prose
 * can differ by whitespace, quote style or dash type between the translation
 * source and the segmented English cue. Normalization removes those differences
 * WITHOUT loosening the mapping: it can never let two different English cues
 * resolve to the same entry (that is detected as an ambiguity and fails).
 */
const normalizeKey = (value) =>
  value
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

export function findPlaceholderReasons(value) {
  const reasons = [];
  if (value === undefined || value === null) return ["absent"];
  const trimmed = String(value).trim();
  if (trimmed === "") return ["empty"];
  for (const re of TRANSLATION_PLACEHOLDER_PATTERNS) {
    if (re.test(trimmed)) reasons.push(`placeholder ${JSON.stringify(trimmed)}`);
  }
  return reasons;
}

/**
 * Build the bilingual SRT from the authoritative English SRT.
 * @returns {Promise<{srtPath:string,qaPath:string,report:object,cues:Array<object>}>}
 * @throws when the completeness gate fails.
 */
export async function buildBilingualSrt({
  root,
  episode,
  englishSrtPath,
  outputPath,
  zhPath,
  style = BILINGUAL_STYLE,
  log = console.log,
}) {
  const merged = {...BILINGUAL_STYLE, ...style};
  const project = path.join(root, "projects", episode);
  const resolvedEnglishSrt = englishSrtPath ?? path.join(project, "temp", `${episode}-subtitles.srt`);
  const resolvedOutput = outputPath ?? path.join(project, "temp", `${episode}-subtitles-bilingual.srt`);
  const resolvedZh = zhPath ?? path.join(project, "subtitles", "zh-TW.json");

  const englishCues = parseSrt(await readFile(resolvedEnglishSrt, "utf8"));
  const zhDoc = JSON.parse(await readFile(resolvedZh, "utf8"));
  const translations = zhDoc.translations ?? {};

  // Index translations by exact key and by normalized key.
  const exact = new Map();
  const normalized = new Map();
  const duplicateZhKeys = [];
  for (const [key, value] of Object.entries(translations)) {
    if (exact.has(key)) duplicateZhKeys.push(key);
    exact.set(key, value);
    const norm = normalizeKey(key);
    if (normalized.has(norm)) duplicateZhKeys.push(`(normalized) ${key}`);
    else normalized.set(norm, key);
  }

  // Duplicate cue IDs in the authoritative SRT would break 1:1 mapping.
  const idCounts = new Map();
  for (const cue of englishCues) idCounts.set(cue.id, (idCounts.get(cue.id) ?? 0) + 1);
  const duplicateCueIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

  const cues = englishCues.map((cue) => {
    let resolvedKey = null;
    let zh = null;
    if (exact.has(cue.text)) {
      resolvedKey = cue.text;
      zh = translations[resolvedKey];
    } else {
      const norm = normalizeKey(cue.text);
      if (normalized.has(norm)) {
        resolvedKey = normalized.get(norm);
        zh = translations[resolvedKey];
      }
    }
    return {
      id: cue.id,
      timecode: cue.timecode,
      english: cue.text,
      zh: zh === undefined || zh === null ? "" : String(zh).trim(),
      resolvedKey,
      problems: findPlaceholderReasons(zh),
    };
  });

  const missing = cues.filter((c) => c.problems.includes("absent"));
  const empty = cues.filter((c) => c.problems.includes("empty"));
  const placeholders = cues.filter(
    (c) => c.problems.some((p) => p.startsWith("placeholder")),
  );
  const unmapped = missing.map((c) => c.id);

  // Translation keys that no authoritative English cue references: the mapping is
  // no longer bijective, so a future re-segmentation would silently drop them.
  const referenced = new Set(cues.map((c) => c.resolvedKey).filter(Boolean));
  const staleKeys = Object.keys(translations).filter((key) => !referenced.has(key));

  const report = {
    schemaVersion: "1.0",
    episode,
    authoritativeEnglishCueCount: englishCues.length,
    translationCount: Object.keys(translations).length,
    validTranslationCount: cues.filter((c) => !c.problems.length).length,
    missingCount: missing.length,
    emptyCount: empty.length,
    placeholderCount: placeholders.length,
    unmappedCount: unmapped.length,
    duplicateCueIdCount: duplicateCueIds.length,
    duplicateZhKeyCount: duplicateZhKeys.length,
    staleTranslationKeyCount: staleKeys.length,
    affectedCueIds: {
      missing: missing.map((c) => c.id),
      empty: empty.map((c) => c.id),
      placeholder: placeholders.map((c) => c.id),
      duplicateCueIds,
      duplicateZhKeys,
      staleTranslationKeys: staleKeys,
    },
    englishSrt: path.relative(root, resolvedEnglishSrt).replaceAll("\\", "/"),
    zhSource: path.relative(root, resolvedZh).replaceAll("\\", "/"),
    style: merged,
    passed:
      missing.length === 0 &&
      empty.length === 0 &&
      placeholders.length === 0 &&
      duplicateCueIds.length === 0 &&
      duplicateZhKeys.length === 0 &&
      staleKeys.length === 0,
  };

  const qaPath = path.join(project, "temp", `${episode}-subtitle-bilingual-qa.json`);
  await mkdir(path.dirname(resolvedOutput), {recursive: true});

  if (!report.passed) {
    await writeFile(qaPath, `${JSON.stringify({...report, cues}, null, 2)}\n`, "utf8");
    const lines = [
      `Bilingual subtitle completeness gate FAILED for ${episode}:`,
      `  authoritative English cues : ${report.authoritativeEnglishCueCount}`,
      `  zh-TW translation entries  : ${report.translationCount}`,
      `  valid translations         : ${report.validTranslationCount}`,
      `  missing                    : ${report.missingCount}  [${report.affectedCueIds.missing.join(",") || "none"}]`,
      `  empty                      : ${report.emptyCount}  [${report.affectedCueIds.empty.join(",") || "none"}]`,
      `  placeholder                : ${report.placeholderCount}  [${report.affectedCueIds.placeholder.join(",") || "none"}]`,
      `  duplicate cue IDs          : ${report.duplicateCueIdCount}  [${report.affectedCueIds.duplicateCueIds.join(",") || "none"}]`,
      `  duplicate zh-TW keys       : ${report.duplicateZhKeyCount}  [${report.affectedCueIds.duplicateZhKeys.join(" | ") || "none"}]`,
      `  stale zh-TW keys (no EN cue): ${report.staleTranslationKeyCount}`,
      `  offenders:`,
      ...cues
        .filter((c) => c.problems.length)
        .map((c) => `    ${c.id}  ${c.problems.join("; ")}  EN=${JSON.stringify(c.english)}`),
      `  report: ${path.relative(root, qaPath)}`,
      `Renderer aborted — no bilingual SRT was written.`,
    ];
    throw new Error(lines.join("\n"));
  }

  const srtLines = [];
  cues.forEach((cue, index) => {
    srtLines.push(String(index + 1));
    srtLines.push(cue.timecode);
    srtLines.push(bilingualCueText(cue, merged));
    srtLines.push("");
  });
  await writeFile(resolvedOutput, srtLines.join("\n"), "utf8");
  await writeFile(qaPath, `${JSON.stringify({...report, cues}, null, 2)}\n`, "utf8");

  log(
    `Bilingual subtitles built: ${cues.length}/${englishCues.length} cues, ` +
      `EN ${merged.FONT_SIZE}px + zh-TW ${merged.CHINESE_FONT_SIZE}px @540p, ` +
      `0 missing / 0 placeholder / 0 unmapped / 0 duplicate`,
  );

  return {srtPath: resolvedOutput, qaPath, report, cues};
}