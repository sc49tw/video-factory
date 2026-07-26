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
  // two countdowns (8s), one transition (0.4s), inter-round prompt (3s),
  // and ending (4s).
  const expected = 3 + 5 + 5 / 0.85 + 8 + 0.4 + 3 + 4;
  assert.ok(Math.abs(expectedDuration(lesson, [2, 3]) - expected) < 1e-9);
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
