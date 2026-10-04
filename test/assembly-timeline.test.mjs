import {test} from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NARRATION_TRIM_SEC,
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

test("buildBlockWindows carries narration playback separately from the block window", () => {
  const windows = buildBlockWindows([
    {sentenceId: "sentence-001", audioDurationSec: 10, pauseAfterSec: 0.6},
    {sentenceId: "sentence-002", audioDurationSec: 8, pauseAfterSec: 0.6},
  ]);
  // The window spans narration playback PLUS the inter-block pause, and the two
  // are reported separately: visual fit is charged to narrationDurationSec only,
  // while the pause becomes a deterministic last-frame hold (never looped, never
  // charged to a source).
  assert.deepEqual(windows, [
    {
      sentenceId: "sentence-001",
      startSec: 0,
      endSec: 10.6,
      narrationDurationSec: 10,
      durationSec: 10.6,
    },
    {
      sentenceId: "sentence-002",
      startSec: 10.6,
      endSec: 19.2,
      narrationDurationSec: 8,
      durationSec: 8.6,
    },
  ]);
  // narrationDurationSec is the audio itself; durationSec adds the pause.
  assert.equal(windows[1].narrationDurationSec, 8);
  assert.ok(Math.abs(windows[1].durationSec - windows[1].narrationDurationSec - 0.6) < 1e-9);
  // Windows stay contiguous and cumulative.
  assert.equal(windows[0].endSec, windows[1].startSec);
  assert.equal(windows[1].endSec, 19.2);
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
  // The planned duration spans the full block windows INCLUDING the inter-block
  // pauses, because the timeline is the narration master.
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

  // Source fit is against NARRATION PLAYBACK (block 2 audio is 8.0s), NOT the
  // 8.6s block window. The 0.6s pause is a last-frame hold, never source time.
  const [photo, video] = timeline.blocks[1].shots;
  assert.equal(photo.renderDurationSec, 4);
  assert.equal(video.renderDurationSec, 4);
  const block2 = timeline.blocks[1];
  assert.equal(block2.audioDurationSec, 8);
  assert.equal(block2.pauseAfterSec, 0.6);
  assert.equal(block2.trimmedSec, 0);
  assert.equal(block2.trailingHoldSec, 0.6);
  assert.equal(block2.durationSec, 8.6);

  // Shots tile the NARRATION window exactly.
  const coveredNarration = block2.shots.reduce((sum, s) => sum + s.renderDurationSec, 0);
  assert.ok(Math.abs(coveredNarration - block2.audioDurationSec) < 0.001);
  // ...and only the pause sits beyond it.
  const coveredWindow = block2.shots.reduce((sum, s) => sum + s.endSec - s.startSec, 0);
  assert.ok(Math.abs(coveredWindow - block2.durationSec) < 0.001);

  // The pause is a deterministic last-frame hold on the FINAL shot only.
  assert.equal(photo.trailingHoldSec, 0);
  assert.equal(video.trailingHoldSec, 0.6);
  // speechEndSec (narration playback end) precedes the held tail.
  assert.equal(video.speechEndSec, 8);
  assert.equal(video.endSec, 8.6);
  // Shots are contiguous in absolute time across the whole timeline.
  let cursor = 0;
  for (const shot of timeline.shots) {
    assert.ok(Math.abs(shot.absoluteStartSec - cursor) < 0.001);
    cursor += shot.renderDurationSec + shot.trailingHoldSec;
  }
  assert.ok(Math.abs(cursor - timeline.plannedDurationSec) < 0.001);
});

test("a narration-fit deficit becomes trailing hold and stays inside the trim tolerance", () => {
  // A video source falls 0.08s short of the narration window: inside
  // MAX_NARRATION_TRIM_SEC, so the deficit is NOT charged to the shot and never
  // looped — it re-emerges as extra deterministic last-frame hold.
  const timeline = buildAssemblyTimeline({
    blocks: [{sentenceId: "sentence-001", audioDurationSec: 5, pauseAfterSec: 0.5}],
    slotsByBlock: new Map([
      [
        "sentence-001",
        [
          {
            slotId: "N001-S1",
            mediaType: "video",
            sourcePath: "/a.mp4",
            sourceDurationSec: 4.92,
          },
        ],
      ],
    ]),
    cuesByBlock: new Map(),
  });
  const block = timeline.blocks[0];
  assert.equal(block.trimmedSec, 0.08);
  assert.ok(block.trimmedSec <= MAX_NARRATION_TRIM_SEC);
  // The shot is never over-charged past the footage it has.
  assert.equal(block.shots[0].renderDurationSec, 4.92);
  assert.equal(block.shots[0].trailingHoldSec, 0.58);
  // pause 0.5 + deficit 0.08
  assert.equal(block.trailingHoldSec, 0.58);
  assert.equal(block.durationSec, 5.5);
  // narration - trim + hold == window
  assert.ok(
    Math.abs(block.audioDurationSec - block.trimmedSec + block.trailingHoldSec - block.durationSec) < 0.001,
  );
  assert.equal(validateAssemblyTimeline(timeline), timeline);

  // Beyond the tolerance it is a hard INSUFFICIENT_SOURCE, not silent trimming.
  assert.throws(
    () =>
      buildAssemblyTimeline({
        blocks: [{sentenceId: "sentence-001", audioDurationSec: 5, pauseAfterSec: 0.5}],
        slotsByBlock: new Map([
          [
            "sentence-001",
            [{slotId: "N001-S1", mediaType: "video", sourcePath: "/a.mp4", sourceDurationSec: 4.5}],
          ],
        ]),
        cuesByBlock: new Map(),
      }),
    /INSUFFICIENT_SOURCE/,
  );
});

test("a slot's approved in-point shortens the footage available to it", () => {
  // A 12s licensed take entered at 8s leaves 4s, so a 4s narration window fits
  // exactly — and the timeline records the in-point so the renderer seeks there.
  const timeline = buildAssemblyTimeline({
    blocks: [{sentenceId: "sentence-001", audioDurationSec: 4, pauseAfterSec: 0.5}],
    slotsByBlock: new Map([
      [
        "sentence-001",
        [
          {
            slotId: "N001-S1",
            mediaType: "video",
            sourcePath: "/a.mp4",
            sourceDurationSec: 12,
            inPointSec: 8,
          },
        ],
      ],
    ]),
    cuesByBlock: new Map(),
  });
  const shot = timeline.shots[0];
  assert.equal(shot.inPointSec, 8);
  assert.equal(shot.sourceDurationSec, 12);
  assert.equal(shot.renderDurationSec, 4);
  assert.equal(shot.trailingHoldSec, 0.5);

  // The cap really is (source - inPoint): 9s in-point on the same 12s take
  // leaves 3s and cannot cover a 4s narration window.
  assert.throws(
    () =>
      buildAssemblyTimeline({
        blocks: [{sentenceId: "sentence-001", audioDurationSec: 4, pauseAfterSec: 0.5}],
        slotsByBlock: new Map([
          [
            "sentence-001",
            [
              {
                slotId: "N001-S1",
                mediaType: "video",
                sourcePath: "/a.mp4",
                sourceDurationSec: 12,
                inPointSec: 9,
              },
            ],
          ],
        ]),
        cuesByBlock: new Map(),
      }),
    /INSUFFICIENT_SOURCE/,
  );
});

test("each video slot carries its own in-point; photos stay at zero", () => {
  const timeline = buildAssemblyTimeline({
    blocks: [{sentenceId: "sentence-001", audioDurationSec: 8, pauseAfterSec: 0.6}],
    slotsByBlock: new Map([
      [
        "sentence-001",
        [
          {
            slotId: "N001-S1",
            mediaType: "video",
            sourcePath: "/a.mp4",
            sourceDurationSec: 20,
            inPointSec: 0,
          },
          {
            slotId: "N001-S2",
            mediaType: "video",
            sourcePath: "/b.mp4",
            sourceDurationSec: 20,
            inPointSec: 13.92,
          },
          {slotId: "N001-S3", mediaType: "photo", sourcePath: "/c.jpg", sourceDurationSec: null},
        ],
      ],
    ]),
    cuesByBlock: new Map(),
  });
  assert.deepEqual(
    timeline.shots.map((s) => s.inPointSec),
    [0, 13.92, 0],
  );
  // 8s narration across three slots: video caps are 20s and 6.08s, the photo is
  // unbounded, so all three share the narration evenly.
  assert.deepEqual(
    timeline.shots.map((s) => s.renderDurationSec),
    [2.667, 2.667, 2.667],
  );
  // The late-in-point slot never exceeds the footage that remains after it.
  const second = timeline.shots[1];
  assert.ok(
    second.renderDurationSec <= second.sourceDurationSec - second.inPointSec + 1e-6,
  );
});

test("validateAssemblyTimeline rejects a shot that overruns its post-in-point footage", () => {
  const timeline = buildAssemblyTimeline({
    blocks: [{sentenceId: "sentence-001", audioDurationSec: 4, pauseAfterSec: 0.5}],
    slotsByBlock: new Map([
      [
        "sentence-001",
        [
          {
            slotId: "N001-S1",
            mediaType: "video",
            sourcePath: "/a.mp4",
            sourceDurationSec: 12,
            inPointSec: 8,
          },
        ],
      ],
    ]),
    cuesByBlock: new Map(),
  });
  // Simulate a downstream mutation that moves the in-point without re-fitting:
  // coverage still ties to narration, but only 3s of footage now remains.
  const tampered = structuredClone(timeline);
  tampered.shots[0].inPointSec = 9;
  tampered.blocks[0].shots[0].inPointSec = 9;
  assert.throws(() => validateAssemblyTimeline(tampered), /INSUFFICIENT_SOURCE/);
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
