import path from "node:path";

export const DEFAULTS = Object.freeze({
  renderMode: "double-pass-shadowing",
  countdownSeconds: 4,
  transitionSeconds: 0.4,
  interRoundPromptSeconds: 3,
  introSeconds: 3,
  shadowingTempo: 0.85,
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  voice: "en-US-JennyNeural",
  rate: "+0%",
  pitch: "+0Hz",
  volume: "+0%",
});

export function validateEpisodeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) {
    throw new Error(
      `Invalid episode ID "${value ?? ""}". Use letters, numbers, "_" or "-" only.`,
    );
  }
  return value;
}

export function normalizeLesson(raw, requestedEpisode) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("lesson.json must contain a JSON object.");
  }

  const episode = String(
    raw.episode ?? raw.lesson_id ?? raw.episodeId ?? requestedEpisode ?? "",
  ).trim();
  validateEpisodeId(episode);
  if (requestedEpisode && episode.toLowerCase() !== requestedEpisode.toLowerCase()) {
    throw new Error(
      `lesson.json episode "${episode}" does not match requested episode "${requestedEpisode}".`,
    );
  }

  const title = String(raw.title ?? raw.project?.title ?? "").trim();
  if (!title) {
    throw new Error("lesson.json requires a non-empty title.");
  }

  const scenes = normalizeScenes(raw);
  if (scenes.length === 0) {
    throw new Error("lesson.json requires at least one scene or segment.");
  }

  const sentences = [];
  for (const [sceneIndex, scene] of scenes.entries()) {
    if (!scene.image) {
      throw new Error(`Scene ${sceneIndex + 1} requires an image.`);
    }
    if (!Array.isArray(scene.sentences) || scene.sentences.length === 0) {
      throw new Error(`Scene ${sceneIndex + 1} must contain at least one sentence.`);
    }
    for (const [sentenceIndex, sentence] of scene.sentences.entries()) {
      const text = sentence.text;
      if (!text) {
        throw new Error(
          `Scene ${sceneIndex + 1}, sentence ${sentenceIndex + 1} is empty.`,
        );
      }
      sentences.push({
        id: `sentence-${String(sentences.length + 1).padStart(3, "0")}`,
        sceneIndex,
        sentenceIndex,
        image: scene.image,
        text,
        speaker: sentence.speaker,
        tts: sentence.tts,
      });
    }
  }
  const moral = normalizeMoral(raw.ending ?? raw.moral);
  if (moral?.text) {
    sentences.push({
      id: `sentence-${String(sentences.length + 1).padStart(3, "0")}`,
      sceneIndex: scenes.length - 1,
      sentenceIndex: scenes.at(-1).sentences.length,
      image: scenes.at(-1).image,
      text: `${moral.prefix} ${moral.text}`.trim(),
      kind: "moral",
    });
  }

  const tts = raw.tts ?? raw.production?.tts ?? {};
  const video = raw.video ?? raw.production?.video ?? {};
  const production = raw.production ?? {};
  const resolution = production.resolution ?? {};
  const backgroundMusic =
    raw.backgroundMusic ??
    raw.background_music ??
    production.backgroundMusic ??
    production.background_music ??
    null;

  const normalized = {
    schemaVersion: String(raw.schema_version ?? raw.schemaVersion ?? "1.0"),
    episode,
    series: typeof raw.series === "string" ? raw.series.trim() : null,
    subtype: typeof raw.subtype === "string" ? raw.subtype.trim() : null,
    title,
    language: String(raw.language ?? "en"),
    renderMode: String(
      raw.renderMode ??
        raw.render_mode ??
        production.renderMode ??
        DEFAULTS.renderMode,
    ),
    countdownSeconds: positiveInteger(
      raw.countdownSeconds ??
        raw.countdown_seconds ??
        production.countdown_seconds,
      DEFAULTS.countdownSeconds,
      "countdownSeconds",
    ),
    transitionSeconds: nonNegativeNumber(
      raw.transitionSeconds ??
        raw.transition_seconds ??
        production.transition_seconds,
      DEFAULTS.transitionSeconds,
      "transitionSeconds",
    ),
    interRoundPromptSeconds: nonNegativeNumber(
      raw.interRoundPromptSeconds ??
        raw.inter_round_prompt_seconds ??
        production.inter_round_prompt_seconds,
      DEFAULTS.interRoundPromptSeconds,
      "interRoundPromptSeconds",
    ),
    introSeconds: nonNegativeNumber(
      raw.introSeconds ?? raw.intro_seconds ?? production.intro_seconds,
      DEFAULTS.introSeconds,
      "introSeconds",
    ),
    shadowingTempo: boundedNumber(
      raw.shadowingTempo ??
        raw.shadowing_tempo ??
        production.shadowing_tempo,
      DEFAULTS.shadowingTempo,
      0.5,
      1,
      "shadowingTempo",
    ),
    tts: {
      provider: String(tts.provider ?? "edge"),
      voice: String(tts.voice ?? production.voice ?? DEFAULTS.voice),
      rate: String(tts.rate ?? production.speech_rate ?? DEFAULTS.rate),
      pitch: String(tts.pitch ?? production.speech_pitch ?? DEFAULTS.pitch),
      volume: String(tts.volume ?? production.speech_volume ?? DEFAULTS.volume),
      sampleRate: positiveInteger(
        tts.sampleRate ?? production.sample_rate,
        DEFAULTS.sampleRate,
        "tts.sampleRate",
      ),
    },
    video: {
      width: positiveInteger(
        video.width ?? resolution.width,
        DEFAULTS.width,
        "video.width",
      ),
      height: positiveInteger(
        video.height ?? resolution.height,
        DEFAULTS.height,
        "video.height",
      ),
      fps: positiveInteger(
        video.fps ?? production.fps,
        DEFAULTS.fps,
        "video.fps",
      ),
    },
    backgroundMusic: normalizeBackgroundMusic(backgroundMusic, raw, production),
    sharedOpening: normalizeSharedOpening(raw.sharedOpening ?? production.sharedOpening),
    ending: normalizeEnding(raw.ending ?? production.ending, raw.series),
    moral,
    scenes,
    sentences,
  };

  if (normalized.renderMode !== "double-pass-shadowing") {
    throw new Error(
      `Unsupported renderMode "${normalized.renderMode}". Expected "double-pass-shadowing".`,
    );
  }
  if (normalized.tts.provider !== "edge") {
    throw new Error(
      `Unsupported TTS provider "${normalized.tts.provider}". Expected "edge".`,
    );
  }
  return normalized;
}

export function expectedDuration(lesson, audioDurations) {
  if (audioDurations.length !== lesson.sentences.length) {
    throw new Error("Audio duration count does not match sentence count.");
  }
  const endingSeconds = lesson.ending.length > 0 ? 4 : 0;
  if (lesson.series === "ESSD") {
    return (
      lesson.introSeconds +
      audioDurations.reduce(
        (total, duration) =>
          total + duration + duration / lesson.shadowingTempo,
        0,
      ) +
      lesson.countdownSeconds * audioDurations.length +
      lesson.transitionSeconds +
      lesson.interRoundPromptSeconds +
      endingSeconds
    );
  }
  if (lesson.series === "LLFC") {
    return (
      (lesson.sharedOpening?.durationSec ?? 0) +
      audioDurations.reduce(
        (total, duration) => total + duration + lesson.transitionSeconds,
        0,
      ) +
      endingSeconds
    );
  }
  return audioDurations.reduce(
    (total, duration) =>
      total +
      duration * 2 +
      lesson.countdownSeconds +
      lesson.transitionSeconds,
    endingSeconds,
  );
}

export function resolveInside(root, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`${label} must be a non-empty path.`);
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`${label} must stay inside ${resolvedRoot}: ${relativePath}`);
  }
  return resolved;
}

function normalizeScenes(raw) {
  if (Array.isArray(raw.scenes)) {
    return raw.scenes.map((scene, index) => ({
      id: String(scene?.id ?? scene?.sceneId ?? `scene${String(index + 1).padStart(2, "0")}`),
      kind: String(scene?.kind ?? "scene"),
      title: String(scene?.title ?? scene?.heading ?? "").trim(),
      onScreenText: normalizeOnScreenText(scene?.onScreenText),
      image: normalizeImage(scene, index),
      sentences: normalizeSentenceList(scene),
    }));
  }

  const segments =
    raw.segments ?? raw.content?.segments ?? raw.content_segments ?? null;
  if (Array.isArray(segments)) {
    return segments.map((segment, index) => ({
      image: normalizeImage(segment, index),
      sentences: normalizeSentenceList(segment),
    }));
  }

  if (Array.isArray(raw.content?.scenes)) {
    return raw.content.scenes.map((scene, index) => ({
      id: String(scene?.id ?? scene?.sceneId ?? `scene${String(index + 1).padStart(2, "0")}`),
      kind: String(scene?.kind ?? "scene"),
      title: String(scene?.title ?? scene?.heading ?? "").trim(),
      onScreenText: normalizeOnScreenText(scene?.onScreenText),
      image: normalizeImage(scene, index),
      sentences: normalizeSentenceList(scene),
    }));
  }
  return [];
}

function normalizeOnScreenText(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function normalizeSharedOpening(value) {
  if (!value || typeof value !== "object") return null;
  const image = typeof value.image === "string" ? value.image.trim() : "";
  if (!image) return null;
  return {
    image,
    durationSec: nonNegativeNumber(
      value.durationSec ?? value.duration_seconds,
      2.5,
      "sharedOpening.durationSec",
    ),
  };
}

function normalizeImage(item, index) {
  const value =
    item?.image ??
    item?.imagePath ??
    item?.image_path ??
    item?.asset ??
    item?.assetPath;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return `scene${String(index + 1).padStart(2, "0")}.png`;
}

function normalizeSentenceList(item) {
  const list = item?.sentences ?? item?.lines;
  if (Array.isArray(list)) {
    return list.map(normalizeSentence);
  }
  const single = item?.text ?? item?.narration;
  return single === undefined ? [] : [normalizeSentence(single)];
}

function normalizeSentence(value) {
  if (typeof value !== "object" || !value) {
    return {text: String(value ?? "").trim(), speaker: null, tts: null};
  }
  const rawTts = value.tts && typeof value.tts === "object" ? value.tts : null;
  const tts = rawTts
    ? Object.fromEntries(
        ["voice", "rate", "pitch", "volume"]
          .filter((key) => rawTts[key] !== undefined)
          .map((key) => [key, String(rawTts[key])]),
      )
    : null;
  return {
    text: String(value.text ?? value.narration ?? "").trim(),
    speaker:
      typeof value.speaker === "string" && value.speaker.trim()
        ? value.speaker.trim()
        : null,
    tts: tts && Object.keys(tts).length > 0 ? tts : null,
  };
}

function normalizeBackgroundMusic(value, raw, production) {
  if (value === false || raw.musicEnabled === false || production.musicEnabled === false) {
    return {enabled: false, path: null, volume: 0.08};
  }
  if (typeof value === "string" && value.trim()) {
    return {enabled: true, path: value.trim(), volume: 0.08};
  }
  if (value && typeof value === "object") {
    return {
      enabled: value.enabled === true,
      path: typeof value.path === "string" ? value.path : null,
      volume: nonNegativeNumber(value.volume, 0.08, "backgroundMusic.volume"),
    };
  }
  return {enabled: false, path: null, volume: 0.08};
}

function normalizeEnding(value, series) {
  if (value === false) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((line) => String(line).trim()).filter(Boolean);
  }
  return series === "LLFC" ? [] : ["Great job!", "See you next time."];
}

function normalizeMoral(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!text || value.tts === false) return null;
  return {
    prefix:
      typeof value.prefix === "string" && value.prefix.trim()
        ? value.prefix.trim()
        : "The moral is...",
    text,
  };
}

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

function boundedNumber(value, fallback, minimum, maximum, label) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}
