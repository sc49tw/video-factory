import {test} from "node:test";
import assert from "node:assert/strict";
import {
  buildBlockWindows,
  buildAssemblyTimeline,
  distributeEvenly,
  filterTimeline,
  sliceCues,
  validateAssemblyTimeline,
} from "../src/assembly-timeline.mjs";

test("distributeEvenly splits evenly when caps are sufficient", () => {
  const result = distributeEvenly(24, [10, 10, 10]);
  assert.deepEqual(result.map((d) => Math.round(d)), [8, 8, 8]);
  assert.equal(result.reduce((a, b) => a + b, 0), 24);
});

test("distributeEvenly caps tight sources and spreads the remainder", () => {
  const result = distributeEvenly(23.256, [12.112, 10.027, 7.841]);
  const sum = result.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 23.256) < 1e-6);
  assert.ok(result.every((d) => d > 0));
  assert.ok(result[2] <= 7.841 + 1e-6);
  assert.ok(result[0] <= 12.112 + 1e-6);
});

test("distributeEvenly handles unbounded (photo) caps", () => {
  const result = distributeEvenly(18, [4, null, 4]);
  assert.equal(result.length, 3);
  assert.equal(result[1], 10);
});

test("distributeEvenly throws when sources cannot cover the window", () => {
  assert.throws(() => distributeEvenly(10, [3, 3, 3]), /INSUFFICIENT_SOURCE/);
});

test("sliceCues clips into windows and re-bases timing", () => {
  const cues = [
    {startSec: 0, endSec: 5, text: "A"},
    {startSec: 6, endSec: 9, text: "B"},
    {startSec: 8, endSec: 12, text: "C"},
  ];
  const sliced = sliceCues(cues, 4, 10);
  assert.deepEqual(sliced, [
    {startSec: 0, endSec: 1, text: "A"},
    {startSec: 2, endSec: 5, text: "B"},
    {startSec: 4, endSec: 6, text: "C"},
  ]);
});

test("sliceCues drops sub-threshold fragments", () => {
  const cues = [{startSec: 0, endSec: 5, text: "A"}];
  const sliced = sliceCues(cues, 4.9, 10);
  assert.deepEqual(sliced, []);
});

test("buildBlockWindows computes cumulative narration master windows", () => {
  const windows = buildBlockWindows([
    {sentenceId: "sentence-001", audioDurationSec: 10, pauseAfterSec: 0.6},
    {sentenceId: "sentence-002", audioDurationSec: 8, pauseAfterSec: 0.6},
  ]);
  assert.deepEqual(windows, [
    {sentenceId: "sentence-001", startSec: 0, endSec: 10.6, durationSec: 10.6},
    {sentenceId: "sentence-002", startSec: 10.6, endSec: 19.2, durationSec: 8.6},
  ]);
});

const TIMELINE_INPUT = {
  blocks: [
    {sentenceId: "sentence-001", audioDurationSec: 10, pauseAfterSec: 0.6},
    {sentenceId: "sentence-002", audioDurationSec: 8, pauseAfterSec: 0.6},
  ],
  slotsByBlock: new Map([
    [
      "sentence-001",
      [
        {slotId: "N001-S1", mediaType: "video", sourcePath: "/a.mp4", sourceDurationSec: 12},
        {slotId: "N001-S2", mediaType: "photo", sourcePath: "/b.jpg", sourceDurationSec: null},
      ],
    ],
    [
      "sentence-002",
      [
        {slotId: "N002-S1", mediaType: "photo", sourcePath: "/c.jpg", sourceDurationSec: null},
        {slotId: "N002-S2", mediaType: "video", sourcePath: "/d.mp4", sourceDurationSec: 9},
      ],
    ],
  ]),
  cuesByBlock: new Map([
    ["sentence-001", [
      {startSec: 0, endSec: 4, text: "A"},
      {startSec: 4, endSec: 8, text: "B"},
    ]],
    ["sentence-002", [
      {startSec: 0, endSec: 3, text: "C"},
    ]],
  ]),
};

test("buildAssemblyTimeline produces a contiguous, covered timeline", () => {
  const timeline = buildAssemblyTimeline(TIMELINE_INPUT);
  assert.equal(timeline.plannedDurationSec, 19.2);
  assert.equal(timeline.blocks.length, 2);
  assert.equal(timeline.shots.length, 4);
  assert.deepEqual(
    timeline.shots.map((s) => s.slotId),
    ["N001-S1", "N001-S2", "N002-S1", "N002-S2"],
  );
  assert.deepEqual(
    timeline.blocks[0].shots.map((s) => s.mediaType),
    ["video", "photo"],
  );
  // block 2 cap: N002-S2 video (9s) shares the 8.6s window -> 4.3s each.
  assert.ok(Math.abs(timeline.blocks[1].shots[0].renderDurationSec - 4.3) < 0.01);
  // shots tile the block exactly
  const covered = timeline.blocks[1].shots.reduce(
    (sum, shot) => sum + shot.renderDurationSec,
    0,
  );
  assert.ok(Math.abs(covered - 8.6) < 0.001);
});

test("buildAssemblyTimeline rejects duplicate slots", () => {
  const input = structuredClone(TIMELINE_INPUT);
  input.slotsByBlock.get("sentence-001").push({
    slotId: "N001-S1",
    mediaType: "video",
    sourcePath: "/a.mp4",
    sourceDurationSec: 12,
  });
  assert.throws(
    () => buildAssemblyTimeline(input),
    /Duplicate slot assignment/,
  );
});

test("buildAssemblyTimeline rejects INSUFFICIENT_SOURCE", () => {
  const input = structuredClone(TIMELINE_INPUT);
  input.slotsByBlock.set("sentence-002", [
    {
      slotId: "N002-S1",
      mediaType: "video",
      sourcePath: "/d.mp4",
      sourceDurationSec: 2,
    },
  ]);
  assert.throws(() => buildAssemblyTimeline(input), /INSUFFICIENT_SOURCE/);
});

test("buildAssemblyTimeline rejects a reused source asset", () => {
  const input = structuredClone(TIMELINE_INPUT);
  input.slotsByBlock.set("sentence-002", [
    {
      slotId: "N002-S1",
      mediaType: "video",
      sourcePath: "/a.mp4",
      sourceDurationSec: 12,
    },
  ]);
  assert.throws(() => buildAssemblyTimeline(input), /reused across slots/);
});

test("buildAssemblyTimeline rejects a reused photo source asset", () => {
  const input = structuredClone(TIMELINE_INPUT);
  input.slotsByBlock.set("sentence-002", [
    {
      slotId: "N002-S1",
      mediaType: "photo",
      sourcePath: "/b.jpg",
      sourceDurationSec: null,
    },
  ]);
  assert.throws(() => buildAssemblyTimeline(input), /reused across slots/);
});

test("validateAssemblyTimeline accepts a valid artifact", () => {
  const timeline = buildAssemblyTimeline(TIMELINE_INPUT);
  assert.equal(validateAssemblyTimeline(timeline), timeline);
});

test("filterTimeline keeps only the requested blocks with correct totals", () => {
  const timeline = buildAssemblyTimeline(TIMELINE_INPUT);
  const filtered = filterTimeline(timeline, ["sentence-001"]);
  assert.equal(filtered.blocks.length, 1);
  assert.equal(filtered.shots.length, 2);
  assert.equal(filtered.plannedDurationSec, 10.6);
});
