import {readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import {validateEpisodeId} from "./lesson.mjs";

// Essay pipeline defaults. The MVP is English-only; other languages arrive
// with the multilingual phase together with CJK font and wrapping support.
export const ESSY_DEFAULTS = Object.freeze({
  language: "en",
  voice: "en-US-JennyNeural",
  rate: "+0%",
  pitch: "+0Hz",
  volume: "+0%",
  sampleRate: 48000,
  width: 1920,
  height: 1080,
  fps: 30,
  musicVolume: 0.08,
  blockPauseSeconds: 0.6,
  maxSubtitleCharsPerLine: 46,
});

const REQUIRED_PROVENANCE_FIELDS = Object.freeze([
  "sourceUrl",
  "license",
  "downloadedAt",
  "originalFilename",
]);

const schema = JSON.parse(
  readFileSync(
    new URL("../contracts/essay-episode.schema.json", import.meta.url),
    "utf8",
  ),
);
const validateSchema = new Ajv2020({allErrors: true, strict: false}).compile(
  schema,
);

export function isEssayInput(raw) {
  return Boolean(
    raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      (raw.series === "ESSY" || raw.renderMode === "essay-narration"),
  );
}

/**
 * Normalizes an essay episode input into the same internal shape produced by
 * normalizeLesson so the existing renderer, gates, TTS cache, subtitle
 * system, Ken Burns motion, BGM mixing, and QA can be reused unchanged.
 */
export async function normalizeEssayEpisode(raw, requestedEpisode, inboxRoot) {
  if (!validateSchema(raw)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Essay episode schema validation failed: ${details}`);
  }
  const episode = String(raw.episode ?? "").trim();
  validateEpisodeId(episode);
  if (
    requestedEpisode &&
    episode.toLowerCase() !== requestedEpisode.toLowerCase()
  ) {
    throw new Error(
      `Essay episode "${episode}" does not match requested episode "${requestedEpisode}".`,
    );
  }
  if (raw.language !== ESSY_DEFAULTS.language) {
    throw new Error(
      `Essay MVP supports language "en" only. Received "${raw.language}".`,
    );
  }
  if ((raw.voice?.provider ?? "edge") !== "edge") {
    throw new Error(
      `Unsupported TTS provider "${raw.voice?.provider}". Expected "edge".`,
    );
  }

  const scenes = [];
  const sentences = [];
  const seenSectionIds = new Set();
  for (const [sectionIndex, section] of raw.sections.entries()) {
    const sectionId = String(section.id ?? "").trim();
    if (!sectionId) {
      throw new Error(`sections[${sectionIndex}].id must be non-empty.`);
    }
    if (seenSectionIds.has(sectionId)) {
      throw new Error(`Duplicate section id "${sectionId}".`);
    }
    seenSectionIds.add(sectionId);
    const visual = section.visual ?? {};
    const image =
      typeof visual.image === "string" && visual.image.trim()
        ? visual.image.trim()
        : `scene${String(sectionIndex + 1).padStart(2, "0")}.png`;
    scenes.push({
      id: sectionId,
      kind: "essay-section",
      title: typeof section.heading === "string" ? section.heading.trim() : "",
      onScreenText: [],
      image,
      sentences: [],
    });
    for (const [blockIndex, block] of section.narration.entries()) {
      const text = String(block.text ?? "").trim();
      if (!text) {
        throw new Error(
          `sections[${sectionIndex}].narration[${blockIndex}].text is empty.`,
        );
      }
      sentences.push({
        id: `sentence-${String(sentences.length + 1).padStart(3, "0")}`,
        sectionIndex,
        sectionId,
        blockIndex,
        blockId:
          typeof block.id === "string" && block.id.trim()
            ? block.id.trim()
            : null,
        image,
        text,
        speaker: null,
        tts: normalizeBlockTts(block.tts),
        pauseAfterSec: nonNegativeNumber(
          block.pauseAfterSec,
          ESSY_DEFAULTS.blockPauseSeconds,
          `sections[${sectionIndex}].narration[${blockIndex}].pauseAfterSec`,
        ),
      });
    }
  }
  if (sentences.length === 0) {
    throw new Error("Essay episode requires at least one narration block.");
  }

  const visualProvenance = await loadVisualProvenance(
    inboxRoot,
    [...new Set(scenes.map((scene) => scene.image))],
  );

  return {
    schemaVersion: String(raw.schemaVersion ?? "1.0"),
    episode,
    series: "ESSY",
    subtype: "essay",
    title: String(raw.title ?? "").trim(),
    language: raw.language,
    renderMode: "essay-narration",
    topic: typeof raw.topic === "string" ? raw.topic : null,
    targetDurationSec: raw.targetDurationSec ?? null,
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    countdownSeconds: 0,
    transitionSeconds: 0,
    interRoundPromptSeconds: 0,
    introSeconds: 0,
    shadowingTempo: 1,
    tts: {
      provider: "edge",
      voice: raw.voice?.voice ?? ESSY_DEFAULTS.voice,
      rate: raw.voice?.rate ?? ESSY_DEFAULTS.rate,
      pitch: raw.voice?.pitch ?? ESSY_DEFAULTS.pitch,
      volume: raw.voice?.volume ?? ESSY_DEFAULTS.volume,
      sampleRate: positiveInteger(
        raw.voice?.sampleRate,
        ESSY_DEFAULTS.sampleRate,
        "voice.sampleRate",
      ),
    },
    video: {
      width: positiveInteger(
        raw.video?.width,
        ESSY_DEFAULTS.width,
        "video.width",
      ),
      height: positiveInteger(
        raw.video?.height,
        ESSY_DEFAULTS.height,
        "video.height",
      ),
      fps: positiveInteger(raw.video?.fps, ESSY_DEFAULTS.fps, "video.fps"),
    },
    backgroundMusic: {
      enabled: raw.music?.enabled === true,
      path:
        typeof raw.music?.path === "string" && raw.music.path.trim()
          ? raw.music.path.trim()
          : null,
      volume: nonNegativeNumber(
        raw.music?.volume,
        ESSY_DEFAULTS.musicVolume,
        "music.volume",
      ),
    },
    subtitles: {
      mode: raw.subtitles?.mode ?? "both",
      maxCharsPerLine: boundedInteger(
        raw.subtitles?.maxCharsPerLine,
        ESSY_DEFAULTS.maxSubtitleCharsPerLine,
        10,
        80,
        "subtitles.maxCharsPerLine",
      ),
    },
    sharedOpening: null,
    ending: [],
    moral: null,
    visualProvenance,
    scenes,
    sentences,
  };
}

async function loadVisualProvenance(inboxRoot, imageNames) {
  const provenancePath = path.join(inboxRoot, "visuals.json");
  let rawEntries;
  try {
    rawEntries = JSON.parse(await readFile(provenancePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Missing visuals provenance file ${provenancePath}. Essay episodes ` +
          `require provenance for every visual asset ` +
          `(${REQUIRED_PROVENANCE_FIELDS.join(", ")}, creator optional).`,
      );
    }
    throw new Error(`Invalid visuals.json: ${error.message}`);
  }
  if (!rawEntries || typeof rawEntries !== "object" || Array.isArray(rawEntries)) {
    throw new Error("visuals.json must be an object keyed by image filename.");
  }
  const problems = [];
  const resolved = {};
  for (const imageName of imageNames) {
    const entry = rawEntries[imageName];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${imageName}: missing entry`);
      continue;
    }
    const missing = REQUIRED_PROVENANCE_FIELDS.filter(
      (field) => typeof entry[field] !== "string" || !entry[field].trim(),
    );
    if (missing.length > 0) {
      problems.push(`${imageName}: missing ${missing.join(", ")}`);
      continue;
    }
    resolved[imageName] = {
      sourceUrl: entry.sourceUrl.trim(),
      creator:
        typeof entry.creator === "string" && entry.creator.trim()
          ? entry.creator.trim()
          : null,
      license: entry.license.trim(),
      downloadedAt: entry.downloadedAt.trim(),
      originalFilename: entry.originalFilename.trim(),
      ...(typeof entry.notes === "string" && entry.notes.trim()
        ? {notes: entry.notes.trim()}
        : {}),
    };
  }
  if (problems.length > 0) {
    throw new Error(
      `Incomplete visual provenance in visuals.json:\n- ${problems.join("\n- ")}`,
    );
  }
  return resolved;
}

function normalizeBlockTts(value) {
  if (!value || typeof value !== "object") return null;
  const tts = Object.fromEntries(
    ["voice", "rate", "pitch", "volume"]
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, String(value[key])]),
  );
  return Object.keys(tts).length > 0 ? tts : null;
}

// Local copies of the small numeric validators used by lesson.mjs. Phase 0
// will consolidate them into a shared module; kept here to avoid touching
// the existing pipeline during the essay MVP.
function positiveInteger(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return number;
}

function nonNegativeNumber(value, fallback, label) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be zero or greater.`);
  }
  return number;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}