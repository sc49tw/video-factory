import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {expectedDuration} from "../src/lesson.mjs";
import {
  ESSY_DEFAULTS,
  isEssayInput,
  normalizeEssayEpisode,
} from "../src/essay-episode.mjs";

const PROVENANCE = {
  "scene01.png": {
    sourceUrl: "https://example.com/city-morning",
    creator: "Example Creator",
    license: "CC0-1.0",
    downloadedAt: "2026-08-23",
    originalFilename: "city-morning.jpg",
  },
  "scene02.png": {
    sourceUrl: "generated locally",
    creator: null,
    license: "self-produced",
    downloadedAt: "2026-08-23",
    originalFilename: "desk-gradient.png",
  },
};

function validEssayInput(overrides = {}) {
  return {
    schemaVersion: "1.0",
    episode: "ESSY-0001",
    series: "ESSY",
    subtype: "essay",
    title: "Why Life Starts Feeling Different After 40",
    language: "en",
    renderMode: "essay-narration",
    topic: "midlife",
    sections: [
      {
        id: "opening",
        heading: "Opening",
        visual: {image: "scene01.png", mood: "quiet city morning"},
        narration: [
          {id: "n001", text: "At some point, the years begin to feel heavier."},
        ],
      },
      {
        id: "turn",
        narration: [
          {id: "n002", text: "Nothing collapses. Everything just slows down."},
        ],
      },
    ],
    ...overrides,
  };
}

async function createInbox(t, {withProvenance = true} = {}) {
  const inboxRoot = await mkdtemp(path.join(tmpdir(), "essy-inbox-"));
  t.after(() => rm(inboxRoot, {recursive: true, force: true}));
  await mkdir(inboxRoot, {recursive: true});
  if (withProvenance) {
    await writeFile(
      path.join(inboxRoot, "visuals.json"),
      JSON.stringify(PROVENANCE, null, 2),
      "utf8",
    );
  }
  return inboxRoot;
}

test("isEssayInput detects essay inputs by series or render mode", () => {
  assert.equal(isEssayInput(validEssayInput()), true);
  assert.equal(isEssayInput({series: "ESSY"}), true);
  assert.equal(isEssayInput({renderMode: "essay-narration"}), true);
  assert.equal(isEssayInput({series: "ESSD"}), false);
  assert.equal(isEssayInput(null), false);
  assert.equal(isEssayInput([]), false);
});

test("maps sections and narration blocks onto the lesson model with defaults", async (t) => {
  const inboxRoot = await createInbox(t);
  const lesson = await normalizeEssayEpisode(
    validEssayInput(),
    "ESSY-0001",
    inboxRoot,
  );

  assert.equal(lesson.episode, "ESSY-0001");
  assert.equal(lesson.series, "ESSY");
  assert.equal(lesson.renderMode, "essay-narration");
  assert.equal(lesson.scenes.length, 2);
  assert.equal(lesson.scenes[0].image, "scene01.png");
  assert.equal(lesson.scenes[1].image, "scene02.png");

  assert.equal(lesson.sentences.length, 2);
  assert.deepEqual(
    lesson.sentences.map((sentence) => sentence.id),
    ["sentence-001", "sentence-002"],
  );
  assert.equal(lesson.sentences[0].sectionId, "opening");
  assert.equal(lesson.sentences[0].image, "scene01.png");
  assert.equal(
    lesson.sentences[0].pauseAfterSec,
    ESSY_DEFAULTS.blockPauseSeconds,
  );

  assert.equal(lesson.tts.provider, "edge");
  assert.equal(lesson.tts.voice, ESSY_DEFAULTS.voice);
  assert.deepEqual(lesson.video, {width: 1920, height: 1080, fps: 30});
  assert.deepEqual(lesson.backgroundMusic, {
    enabled: false,
    path: null,
    volume: 0.08,
  });
  assert.deepEqual(lesson.ending, []);
});

test("carries visual provenance through to the normalized lesson", async (t) => {
  const inboxRoot = await createInbox(t);
  const lesson = await normalizeEssayEpisode(
    validEssayInput(),
    "ESSY-0001",
    inboxRoot,
  );
  assert.equal(lesson.visualProvenance["scene01.png"].license, "CC0-1.0");
  assert.equal(lesson.visualProvenance["scene02.png"].creator, null);
});

test("respects per-block pauses, TTS overrides, voice and music settings", async (t) => {
  const inboxRoot = await createInbox(t);
  const input = validEssayInput({
    voice: {provider: "edge", voice: "en-US-GuyNeural", rate: "-5%"},
    music: {enabled: true, path: "bgm.mp3", volume: 0.06},
    sections: [
      {
        id: "opening",
        visual: {image: "scene01.png"},
        narration: [
          {
            id: "n001",
            text: "First block.",
            pauseAfterSec: 1.2,
            tts: {rate: "+10%"},
          },
        ],
      },
      {
        id: "turn",
        narration: [{id: "n002", text: "Second block.", pauseAfterSec: 0}],
      },
    ],
  });
  const lesson = await normalizeEssayEpisode(input, "ESSY-0001", inboxRoot);

  assert.equal(lesson.sentences[0].pauseAfterSec, 1.2);
  assert.deepEqual(lesson.sentences[0].tts, {rate: "+10%"});
  assert.equal(lesson.sentences[1].pauseAfterSec, 0);
  assert.equal(lesson.tts.voice, "en-US-GuyNeural");
  assert.equal(lesson.tts.rate, "-5%");
  assert.equal(lesson.backgroundMusic.enabled, true);
  assert.equal(lesson.backgroundMusic.path, "bgm.mp3");
  assert.equal(lesson.backgroundMusic.volume, 0.06);
});

test("rejects episodes without complete visual provenance", async (t) => {
  const missingFile = await createInbox(t, {withProvenance: false});
  await assert.rejects(
    () => normalizeEssayEpisode(validEssayInput(), "ESSY-0001", missingFile),
    /Missing visuals provenance file/,
  );

  const incomplete = await createInbox(t);
  await writeFile(
    path.join(incomplete, "visuals.json"),
    JSON.stringify({"scene01.png": PROVENANCE["scene01.png"]}, null, 2),
    "utf8",
  );
  await assert.rejects(
    () => normalizeEssayEpisode(validEssayInput(), "ESSY-0001", incomplete),
    /Incomplete visual provenance[\s\S]*scene02\.png[\s\S]*missing entry/,
  );

  const missingDownloadedAt = await createInbox(t);
  await writeFile(
    path.join(missingDownloadedAt, "visuals.json"),
    JSON.stringify(
      {
        "scene01.png": {
          sourceUrl: "https://example.com/a",
          creator: "Example Creator",
          license: "CC0-1.0",
          originalFilename: "a.jpg",
        },
        "scene02.png": PROVENANCE["scene02.png"],
      },
      null,
      2,
    ),
    "utf8",
  );
  await assert.rejects(
    () =>
      normalizeEssayEpisode(
        validEssayInput(),
        "ESSY-0001",
        missingDownloadedAt,
      ),
    /Incomplete visual provenance[\s\S]*scene01\.png[\s\S]*downloadedAt/,
  );
});

test("rejects non-English languages, bad identity, and invalid blocks", async (t) => {
  const inboxRoot = await createInbox(t);

  // The JSON Schema enum rejects unsupported languages before the adapter's
  // friendlier runtime guard can run.
  await assert.rejects(
    () =>
      normalizeEssayEpisode(
        validEssayInput({language: "ja"}),
        "ESSY-0001",
        inboxRoot,
      ),
    /language must be equal to one of the allowed values/,
  );
  await assert.rejects(
    () => normalizeEssayEpisode(validEssayInput(), "ESSY-9999", inboxRoot),
    /does not match requested episode/,
  );
  await assert.rejects(
    () =>
      normalizeEssayEpisode(
        validEssayInput({
          sections: [{id: "empty", narration: [{id: "n001", text: " "}]}],
        }),
        "ESSY-0001",
        inboxRoot,
      ),
    /narration\[0\]\.text is empty/,
  );
  await assert.rejects(
    () =>
      normalizeEssayEpisode(
        validEssayInput({sections: [{narration: [{text: "No id."}]}]}),
        "ESSY-0001",
        inboxRoot,
      ),
    /schema validation failed/,
  );
});

test("expectedDuration sums narration audio plus block pauses for ESSY", () => {
  const lesson = {
    series: "ESSY",
    sentences: [{pauseAfterSec: 0.5}, {pauseAfterSec: 0}, {pauseAfterSec: 1}],
  };
  assert.equal(expectedDuration(lesson, [2, 3, 4]), 10.5);
});
