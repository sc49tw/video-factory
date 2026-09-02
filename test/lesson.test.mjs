import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  expectedDuration,
  normalizeLesson,
  resolveInside,
  validateEpisodeId,
} from "../src/lesson.mjs";

test("normalizes scenes with multiple sentences", () => {
  const lesson = normalizeLesson(
    {
      episode: "CT001",
      title: "Test",
      scenes: [
        {image: "scene01.png", sentences: ["One.", "Two."]},
      ],
    },
    "CT001",
  );
  assert.equal(lesson.sentences.length, 2);
  assert.equal(lesson.sentences[1].image, "scene01.png");
  assert.equal(lesson.countdownSeconds, 4);
  assert.deepEqual(lesson.ending, ["Great job!", "See you next time."]);
});

test("preserves per-sentence speaker and TTS overrides", () => {
  const lesson = normalizeLesson(
    {
      episode: "ESSD-0011",
      title: "Voices",
      scenes: [
        {
          image: "scene01.png",
          sentences: [
            {
              text: "Wolf! Wolf!",
              speaker: "boy",
              tts: {
                voice: "en-US-AnaNeural",
                rate: "+18%",
                pitch: "+8Hz",
                volume: "+4%",
              },
            },
          ],
        },
      ],
    },
    "ESSD-0011",
  );
  assert.equal(lesson.sentences[0].speaker, "boy");
  assert.deepEqual(lesson.sentences[0].tts, {
    voice: "en-US-AnaNeural",
    rate: "+18%",
    pitch: "+8Hz",
    volume: "+4%",
  });
  assert.equal(lesson.tts.volume, "+0%");
});

test("keeps backward compatibility with segments/text", () => {
  const lesson = normalizeLesson(
    {
      lesson_id: "legacy-001",
      title: "Legacy",
      production: {voice: "en-US-JennyNeural"},
      segments: [{id: "s01", text: "Hello.", image: "scene1.png"}],
    },
    "legacy-001",
  );
  assert.equal(lesson.sentences[0].text, "Hello.");
  assert.equal(lesson.tts.voice, "en-US-JennyNeural");
});

test("rejects unsafe episode IDs and mismatches", () => {
  assert.throws(() => validateEpisodeId("../escape"), /Invalid episode ID/);
  assert.throws(
    () =>
      normalizeLesson(
        {episode: "CT002", title: "Wrong", scenes: [{sentences: ["Hi."]}]},
        "CT001",
      ),
    /does not match/,
  );
});

test("rejects empty scenes and sentences", () => {
  assert.throws(
    () => normalizeLesson({episode: "CT001", title: "Empty", scenes: []}),
    /at least one scene/,
  );
  assert.throws(
    () =>
      normalizeLesson({
        episode: "CT001",
        title: "Empty",
        scenes: [{image: "scene01.png", sentences: [""]}],
      }),
    /sentence 1 is empty/,
  );
});

test("path validation blocks traversal", () => {
  const root = path.resolve("/tmp/video-factory-test");
  assert.equal(
    resolveInside(root, "scene01.png", "image"),
    path.join(root, "scene01.png"),
  );
  assert.throws(() => resolveInside(root, "../secret", "image"), /must stay inside/);
});

test("timeline duration includes both passes, countdowns, transitions and ending", () => {
  const lesson = normalizeLesson({
    episode: "CT001",
    title: "Timing",
    countdownSeconds: 4,
    transitionSeconds: 0.4,
    scenes: [{image: "scene01.png", sentences: ["One.", "Two."]}],
  });
  assert.ok(Math.abs(expectedDuration(lesson, [2, 3]) - 22.8) < 1e-9);
});

test("ESSD duration uses full first round, inter-round prompt, then shadowing", () => {
  const lesson = normalizeLesson({
    episode: "ESSD-0012",
    series: "ESSD",
    subtype: "classic-twisted",
    title: "ESSD Timing",
    countdownSeconds: 4,
    transitionSeconds: 0.4,
    interRoundPromptSeconds: 3,
    scenes: [{image: "scene01.png", sentences: ["One.", "Two."]}],
  });
  // Intro (3s), normal audio (5s), 85%-tempo shadowing audio,
  // two countdowns (8s), one inter-round transition (0.4s), prompt (3s),
  // and ending (4s).
  const expected = 3 + 5 + 5 / 0.85 + 8 + 0.4 + 3 + 4;
  assert.ok(Math.abs(expectedDuration(lesson, [2, 3]) - expected) < 1e-9);
});

test("LLFC preserves opening and report text with a single narration timeline", () => {
  const lesson = normalizeLesson({
    episode: "LLFC-0002",
    series: "LLFC",
    subtype: "default",
    title: "Security Review",
    transitionSeconds: 0.4,
    sharedOpening: {image: "common-opening.png", durationSec: 2.5},
    scenes: [
      {
        id: "page-01",
        kind: "case-study-page",
        title: "PROJECT OVERVIEW",
        image: "page01.png",
        onScreenText: ["PROJECT OVERVIEW", "ON-SITE STAFF  1"],
        sentences: ["One.", "Two."],
      },
    ],
  });
  assert.deepEqual(lesson.sharedOpening, {
    image: "common-opening.png",
    durationSec: 2.5,
  });
  assert.equal(lesson.scenes[0].id, "page-01");
  assert.equal(lesson.scenes[0].kind, "case-study-page");
  assert.deepEqual(lesson.scenes[0].onScreenText, [
    "PROJECT OVERVIEW",
    "ON-SITE STAFF  1",
  ]);
  assert.deepEqual(lesson.ending, []);
  assert.ok(Math.abs(expectedDuration(lesson, [2, 3]) - 8.3) < 1e-9);
});

test("ESSD lesson appends the approved moral with its spoken prefix", () => {
  const lesson = normalizeLesson({
    episode: "ESSD-0012",
    series: "ESSD",
    subtype: "classic-twisted",
    title: "Moral",
    scenes: [{image: "scene01.png", sentences: ["Story."]}],
    ending: {
      text: "Slow and steady wins the race.",
      tts: true,
    },
  });
  assert.equal(lesson.sentences.length, 2);
  assert.equal(
    lesson.sentences[1].text,
    "The moral is... Slow and steady wins the race.",
  );
  assert.equal(lesson.sentences[1].kind, "moral");
});

test("ESSD lesson splits a multi-sentence moral into separate shadowing rounds", () => {
  const lesson = normalizeLesson({
    episode: "ESSD-0013",
    series: "ESSD",
    subtype: "classic-twisted",
    title: "Split Moral",
    scenes: [{image: "scene01.png", sentences: ["Story."]}],
    ending: {
      text: "Sometimes, silence doesn't mean blindness. People simply know the cost of speaking the truth.",
      tts: true,
    },
  });
  assert.equal(lesson.sentences.length, 3);
  assert.equal(
    lesson.sentences[1].text,
    "The moral is... Sometimes, silence doesn't mean blindness.",
  );
  assert.equal(
    lesson.sentences[2].text,
    "People simply know the cost of speaking the truth.",
  );
  assert.equal(lesson.sentences[1].kind, "moral");
  assert.equal(lesson.sentences[2].kind, "moral");
});
