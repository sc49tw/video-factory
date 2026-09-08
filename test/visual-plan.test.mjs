import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPlanInvariants,
  planVisualShots,
  validateVisualPlan,
} from "../src/visual-plan.mjs";

const EPSILON = 1e-6;

/** Builds a narration block whose sentence cues tile its duration evenly. */
function makeBlock({
  sentenceId,
  sectionId = "section",
  image = "scene01.png",
  sentences,
  pauseAfterSec = 0,
  durationSec,
}) {
  const span = durationSec ?? sentences * 2;
  const cues = [];
  for (let i = 0; i < sentences; i += 1) {
    cues.push({
      startSec: Number(((i * span) / sentences).toFixed(3)),
      endSec: Number((((i + 1) * span) / sentences).toFixed(3)),
      text: `Sentence ${i + 1} of ${sentenceId}.`,
    });
  }
  return {
    sentenceId,
    sectionId,
    image,
    durationSec: span,
    pauseAfterSec,
    cues,
  };
}

function fullPlan(plan) {
  return {...plan, episode: "ESSY-0001", series: "ESSY"};
}

test("allocates exactly the target number of shots across blocks", () => {
  const blocks = [
    makeBlock({sentenceId: "sentence-001", sentences: 30, durationSec: 24}),
    makeBlock({sentenceId: "sentence-002", sentences: 18, durationSec: 14}),
    makeBlock({sentenceId: "sentence-003", sentences: 24, durationSec: 19}),
  ];
  const plan = planVisualShots({blocks, targetShots: 12});
  assert.equal(plan.shots.length, 12);
  assert.equal(plan.planning.targetShots, 12);

  // Capacity here is 72 sentence cues, comfortably above the budget.
  const big = planVisualShots({blocks, targetShots: 59});
  assert.equal(big.shots.length, 59);

  // Capacity-limited budgets still produce the maximum feasible count.
  const tight = planVisualShots({
    blocks: [
      makeBlock({sentenceId: "s1", sentences: 2, durationSec: 5}),
      makeBlock({sentenceId: "s2", sentences: 3, durationSec: 7}),
    ],
    targetShots: 50,
  });
  assert.equal(tight.shots.length, 5);
});

test("distributes each block's actual ffprobe duration across its shots", () => {
  const blocks = [
    makeBlock({sentenceId: "sentence-001", sentences: 10, durationSec: 24.664}),
    makeBlock({sentenceId: "sentence-002", sentences: 6, durationSec: 13.5}),
  ];
  const plan = planVisualShots({blocks, targetShots: 9});
  for (const block of blocks) {
    const shots = plan.shots.filter(
      (shot) => shot.sentenceId === block.sentenceId,
    );
    assert.ok(shots.length >= 1);
    // Shots tile the ffprobe timeline exactly: no gaps, no overlaps.
    assert.equal(shots[0].startSec, 0);
    assert.ok(
      Math.abs(shots[shots.length - 1].speechEndSec - block.durationSec) <
        EPSILON,
      "block speech must end at its ffprobe duration",
    );
    for (let k = 1; k < shots.length; k += 1) {
      assert.ok(
        Math.abs(shots[k].startSec - shots[k - 1].endSec) < EPSILON,
        "shots must be contiguous",
      );
    }
  }
});

test("every cut lands on a scaled sentence-cue boundary", () => {
  const block = makeBlock({
    sentenceId: "sentence-001",
    sentences: 12,
    durationSec: 30,
  });
  const plan = planVisualShots({blocks: [block], targetShots: 4});
  const shots = plan.shots;
  assert.equal(shots.length, 4);
  const scale = 30 / block.cues[block.cues.length - 1].endSec;
  const boundaryTimes = new Set(block.cues.map((c) => c.endSec * scale));
  for (const shot of shots.slice(0, -1)) {
    assert.ok(
      [...boundaryTimes].some(
        (time) => Math.abs(time - shot.speechEndSec) < EPSILON,
      ),
      `cut at ${shot.speechEndSec}s is not on a sentence boundary`,
    );
  }
});

test("pauseAfterSec extends only the final visual shot of a block", () => {
  const blocks = [
    makeBlock({
      sentenceId: "sentence-001",
      sentences: 8,
      durationSec: 20,
      pauseAfterSec: 1.5,
    }),
    makeBlock({sentenceId: "sentence-002", sentences: 4, durationSec: 10}),
  ];
  const plan = planVisualShots({blocks, targetShots: 7});
  for (const sentenceId of ["sentence-001", "sentence-002"]) {
    const shots = plan.shots.filter((s) => s.sentenceId === sentenceId);
    const last = shots[shots.length - 1];
    for (const shot of shots.slice(0, -1)) {
      assert.equal(shot.endSec, shot.speechEndSec);
      assert.equal(shot.pauseAfterSec, undefined);
    }
    if (sentenceId === "sentence-001") {
      assert.ok(Math.abs(last.endSec - (last.speechEndSec + 1.5)) < EPSILON);
      assert.equal(last.pauseAfterSec, 1.5);
    } else {
      assert.equal(last.endSec, last.speechEndSec);
    }
  }
});

test("subtitles end with spoken narration and never cover the trailing pause", () => {
  const block = makeBlock({
    sentenceId: "sentence-001",
    sentences: 6,
    durationSec: 15,
    pauseAfterSec: 2.5,
  });
  const plan = planVisualShots({blocks: [block], targetShots: 2});
  assert.equal(plan.shots.length, 2);
  const finalShot = plan.shots[plan.shots.length - 1];

  // The trailing pause exists visually...
  assert.ok(
    finalShot.endSec - finalShot.speechEndSec >= 2.5 - EPSILON,
    "final shot must extend beyond spoken narration",
  );
  for (const shot of plan.shots) {
    const speechWindow = shot.speechEndSec - shot.startSec;
    for (const cue of shot.cues) {
      // Cue-local times must stay inside the shot and inside the SPOKEN window.
      assert.ok(cue.startSec >= 0);
      assert.ok(cue.endSec > cue.startSec);
      assert.ok(cue.endSec <= speechWindow + EPSILON);
    }
  }
  // No subtitle may still be visible once the pause begins.
  const lastCueEnd = Math.max(...finalShot.cues.map((c) => c.endSec));
  assert.ok(lastCueEnd <= finalShot.speechEndSec - finalShot.startSec + EPSILON);

  // The invariant checker rejects any plan that leaks subtitles into a pause.
  const leaked = JSON.parse(JSON.stringify(fullPlan(plan)));
  leaked.shots[leaked.shots.length - 1].cues.push({
    startSec: finalShot.speechEndSec - finalShot.startSec + 0.5,
    endSec: finalShot.endSec - finalShot.startSec,
    text: "Late subtitle.",
  });
  assert.throws(() => assertPlanInvariants(leaked), /trailing pause/);
  assert.throws(() => validateVisualPlan(leaked), /trailing pause/);
});

test("cue times are rebased relative to each shot start", () => {
  const block = makeBlock({
    sentenceId: "sentence-001",
    sentences: 10,
    durationSec: 25,
  });
  const plan = planVisualShots({blocks: [block], targetShots: 5});
  for (const shot of plan.shots) {
    if (shot.index === 0) continue;
    assert.ok(shot.startSec > 0);
    assert.ok(shot.cues.length >= 1);
    assert.ok(Math.min(...shot.cues.map((c) => c.startSec)) < 2.5);
  }
});

test("blocks without usable cues fall back to one whole-block shot", () => {
  const plan = planVisualShots({
    blocks: [
      {
        sentenceId: "sentence-001",
        sectionId: "s",
        image: "scene01.png",
        durationSec: 12,
        pauseAfterSec: 0.6,
        cues: [],
      },
    ],
    targetShots: 5,
  });
  assert.equal(plan.shots.length, 1);
  assert.equal(plan.shots[0].startSec, 0);
  assert.equal(plan.shots[0].speechEndSec, 12);
  assert.equal(plan.shots[0].endSec, 12.6);
});

test("plans validate against the contract; optional durationSec stays accepted", () => {
  const plan = planVisualShots({
    blocks: [
      makeBlock({sentenceId: "sentence-001", sentences: 6, durationSec: 15}),
    ],
    targetShots: 3,
  });

  // Generated plans never carry manual durations.
  for (const shot of plan.shots) {
    assert.equal(shot.durationSec, undefined);
  }

  assert.doesNotThrow(() => validateVisualPlan(fullPlan(plan)));

  // Future extension: a hand-added manual override remains schema-valid.
  const manual = fullPlan(JSON.parse(JSON.stringify(plan)));
  manual.shots[0].durationSec = 4.2;
  assert.doesNotThrow(() => validateVisualPlan(manual));

  const broken = fullPlan(JSON.parse(JSON.stringify(plan)));
  delete broken.shots[1].sentenceId;
  assert.throws(() => validateVisualPlan(broken), /schema validation failed/);

  assert.throws(() => planVisualShots({blocks: [], targetShots: 0}));
});
