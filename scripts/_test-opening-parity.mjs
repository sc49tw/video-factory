// REVIEW/FINAL OPENING-IDENTITY PARITY TESTS
// Run: pnpm test:opening
//
// The approved ESSY-0004 v13 review opening is an INSERTION. These tests prove
// the FINAL path consumes the SAME shared plan (essay-opening-plan.mjs via
// essay-opening-delivery.mjs) instead of re-deriving an opening algorithm, and
// that both paths produce the same editorial semantics:
//
//   - no standalone pre-roll
//   - insertion start/end (13.368-17.368 s on the approved episode)
//   - title card timing/order/text (series then episode, sequential halves)
//   - visual continuation (same approved shot's unused tail, no freeze)
//   - narration silence window = identity window
//   - body (N002...) delivery offset/resume
//   - subtitle insertion/suppression via the shared builder
//   - ending behavior unchanged
//   - 1080p title scaling derived from the 540p review style
//   - legacy (no openingIdentity) episodes completely unaffected
//
// Tests assert a shared render plan / semantic result — never source strings.
import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  buildOpeningDeliveryPlan,
  deliveryEventWindow,
  deliveryShotWindow,
  finalTitleFontSize,
  openingBodyOffsetSec,
  toDeliveryTime,
} from "./essay-opening-delivery.mjs";
import {planOpeningInsertion} from "./essay-opening-plan.mjs";
import {resolveEndingCardSpec, resolveEpisodePreRollTitleCard} from "./essay-identity-config.mjs";
import {buildSubtitleTimeline} from "./_build-subtitle-timeline.mjs";

const factoryRoot = process.cwd();

/** Round to the approved 3-decimal timeline precision. */
function r(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Synthetic fixture mirroring the approved ESSY-0004 shape:
// hook = 2 shots (N001-S1/S2), identity follows the complete hook,
// body = N002-S1/S2. N001-S2 is the hook's FINAL shot and carries the unused
// source tail the insertion plays into.
// ---------------------------------------------------------------------------
const IDENTITY = {
  seriesTitle: "A SECOND LOOK AT LIFE",
  episodeTitle: "Who Am I Beyond My Roles?",
  timing: {startSec: 13.368, durationSec: 4},
  presentation: {mode: "sequential", seriesTitleFirst: true},
  narrationSuppression: {enabled: true},
  subtitleSuppression: {enabled: true},
};

function fixtureTimeline() {
  return {
    schemaVersion: "1.0",
    episode: "PARITY-FIXTURE",
    plannedDurationSec: 33.816,
    blocks: [
      {
        sentenceId: "sentence-001",
        startSec: 0,
        endSec: 13.368,
        durationSec: 13.368,
        shots: [
          {
            index: 0, blockId: "sentence-001", slotId: "N001-S1", mediaType: "video",
            sourcePath: "fixture/N001-S1.mp4", sourceDurationSec: 9, stillMotion: null,
            renderDurationSec: 6.384, trailingHoldSec: 0,
            absoluteStartSec: 0, absoluteEndSec: 6.384,
          },
          {
            index: 1, blockId: "sentence-001", slotId: "N001-S2", mediaType: "video",
            sourcePath: "fixture/N001-S2.mp4", sourceDurationSec: 12.756667, stillMotion: null,
            renderDurationSec: 6.384, trailingHoldSec: 0.6,
            absoluteStartSec: 6.384, absoluteEndSec: 13.368,
          },
        ],
      },
      {
        sentenceId: "sentence-002",
        startSec: 13.368,
        endSec: 33.816,
        durationSec: 20.448,
        shots: [
          {
            index: 2, blockId: "sentence-002", slotId: "N002-S1", mediaType: "video",
            sourcePath: "fixture/N002-S1.mp4", sourceDurationSec: 8.8, stillMotion: null,
            renderDurationSec: 8.8, trailingHoldSec: 0,
            absoluteStartSec: 13.368, absoluteEndSec: 22.168,
          },
          {
            index: 3, blockId: "sentence-002", slotId: "N002-S2", mediaType: "video",
            sourcePath: "fixture/N002-S2.mp4", sourceDurationSec: 11.5, stillMotion: null,
            renderDurationSec: 11.048, trailingHoldSec: 0.6,
            absoluteStartSec: 22.168, absoluteEndSec: 33.816,
          },
        ],
      },
    ],
    shots: [],
  };
}

function finalizeFixture(timeline) {
  timeline.shots = timeline.blocks.flatMap((block) => block.shots);
  return timeline;
}

/** Total approved assembly shot duration (playback + hold) for a timeline. */
function assemblyShotTotalSec(timeline) {
  return timeline.shots.reduce(
    (sum, shot) => sum + Number(shot.renderDurationSec) + Number(shot.trailingHoldSec ?? 0),
    0,
  );
}

/** Total delivery video duration implied by the shared plan. */
function deliveryDurationSec(timeline, plan) {
  return timeline.shots.reduce((sum, shot) => {
    const override = plan.deliveryShotOverrides.get(shot.slotId);
    return sum + Number(override?.playbackDurationSec ?? shot.renderDurationSec)
      + Number(override?.trailingHoldSec ?? shot.trailingHoldSec ?? 0);
  }, 0);
}


// ---------------------------------------------------------------------------
// 1+2. No standalone pre-roll; insertion start/end.
// ---------------------------------------------------------------------------
test("1+2: no pre-roll and insertion window = identity timing", () => {
  const timeline = finalizeFixture(fixtureTimeline());
  const plan = buildOpeningDeliveryPlan({identity: IDENTITY, timeline});
  // A pre-roll would offset the delivered program; the shared delivery offset
  // is the INSERTION duration, applied after the complete hook.
  assert.equal(openingBodyOffsetSec(plan), 4);
  assert.equal(plan.startSec, 13.368);
  assert.equal(r(plan.endSec), 17.368);
  assert.equal(openingBodyOffsetSec(null), 0, "legacy delivery has no offset");
  // Content starts at t=0: the first shot's delivery window is unchanged and
  // the insertion begins only after the complete hook block ends.
  assert.deepEqual(deliveryShotWindow(timeline.shots[0], plan), {startSec: 0, endSec: 6.384});
  assert.equal(plan.startSec, timeline.blocks[0].endSec, "identity follows the complete hook");
  assert.equal(
    r(deliveryDurationSec(timeline, plan) - assemblyShotTotalSec(timeline, null)),
    4,
    "the insertion adds exactly its own duration to the approved visual timeline",
  );
  assert.ok(
    Math.abs(deliveryDurationSec(timeline, plan) - (timeline.plannedDurationSec + 4)) <= 0.002,
    "delivery duration matches the approved program + insertion within timeline rounding",
  );
});

// ---------------------------------------------------------------------------
// 3. Card timing / order / text.
// ---------------------------------------------------------------------------
test("3: title cards are the series title then the episode title, half each", () => {
  const timeline = finalizeFixture(fixtureTimeline());
  const plan = buildOpeningDeliveryPlan({identity: IDENTITY, timeline});
  assert.equal(plan.cards.length, 2);
  const [channel, episode] = plan.cards;
  assert.equal(channel.kind, "channel");
  assert.equal(channel.text, IDENTITY.seriesTitle);
  assert.equal(channel.startSec, 13.368);
  assert.equal(channel.endSec, 15.368);
  assert.equal(episode.kind, "episode");
  assert.equal(episode.text, IDENTITY.episodeTitle);
  assert.equal(episode.startSec, 15.368);
  assert.equal(r(episode.endSec), 17.368);
  for (const card of plan.cards) {
    assert.ok(card.startSec >= plan.startSec - 1e-9);
    assert.ok(card.endSec <= plan.endSec + 1e-9);
  }
});

test("3b: seriesTitleFirst=false reverses the card order only", () => {
  const timeline = finalizeFixture(fixtureTimeline());
  const plan = buildOpeningDeliveryPlan({
    identity: {...IDENTITY, presentation: {mode: "sequential", seriesTitleFirst: false}},
    timeline,
  });
  assert.deepEqual(plan.cards.map((c) => c.text), [IDENTITY.episodeTitle, IDENTITY.seriesTitle]);
  assert.equal(plan.cards[0].startSec, 13.368);
  assert.equal(r(plan.cards[1].endSec), 17.368);
});

// ---------------------------------------------------------------------------
// 4. Visual continuation.
// ---------------------------------------------------------------------------
test("4: identity continues the hook shot's own approved unused tail", () => {
  const timeline = finalizeFixture(fixtureTimeline());
  const plan = buildOpeningDeliveryPlan({identity: IDENTITY, timeline});
  const hook = timeline.blocks[0].shots.at(-1);
  const override = plan.deliveryShotOverrides.get(hook.slotId);
  assert.equal(plan.hookSlotId, "N001-S2");
  assert.equal(override.mode, "extend-source-tail");
  assert.equal(override.sourceOffsetSec, 0, "plays from the source's own t=0 - no freeze, no re-seek");
  assert.equal(override.playbackDurationSec, hook.renderDurationSec + 4);
  assert.equal(override.trailingHoldSec, hook.trailingHoldSec, "N001 trailing hold unchanged");
  assert.equal(override.playbackDurationSec + override.trailingHoldSec, 10.984);
  assert.ok(override.playbackDurationSec + override.trailingHoldSec <= hook.sourceDurationSec + 1e-9,
    "insertion must fit inside the approved source's unused tail");
  assert.notEqual(override.mode, "freeze", "continuing footage, never a frozen frame");
  // No later shot changes playback; only its window shifts.
  const bodyShot = timeline.shots[2];
  const bodyOverride = plan.deliveryShotOverrides.get(bodyShot.slotId);
  assert.equal(bodyOverride.mode, "shift-body");
  assert.equal(bodyOverride.playbackDurationSec, bodyShot.renderDurationSec);
  assert.equal(bodyOverride.trailingHoldSec, bodyShot.trailingHoldSec);
  // Insufficient tail must fail loudly, never silently freeze or loop.
  const tight = finalizeFixture(fixtureTimeline());
  tight.shots[tight.shots.findIndex((s) => s.slotId === "N001-S2")].sourceDurationSec = 9;
  assert.throws(
    () => buildOpeningDeliveryPlan({identity: IDENTITY, timeline: tight}),
    /Insufficient approved moving footage|source tail/,
  );
});


// ---------------------------------------------------------------------------
// 5. Narration suppression window.
// ---------------------------------------------------------------------------
test("5: narration is silent exactly across the identity window", () => {
  const timeline = finalizeFixture(fixtureTimeline());
  const plan = buildOpeningDeliveryPlan({identity: IDENTITY, timeline});
  assert.deepEqual(
    {startSec: r(plan.narrationSilenceWindow.startSec), endSec: r(plan.narrationSilenceWindow.endSec)},
    {startSec: 13.368, endSec: 17.368},
  );
  assert.equal(plan.narrationSilenceWindow.startSec, plan.startSec);
  assert.equal(r(plan.narrationSilenceWindow.endSec), r(plan.endSec));
  assert.equal(plan.bodyOffsetSec, 4, "the body resumes 4.000 s later, unchanged in content");
});

// ---------------------------------------------------------------------------
// 6. N002 delivery offset / resume.
// ---------------------------------------------------------------------------
test("6: N002 resumes at +4 s with its approved duration and hold intact", () => {
  const timeline = finalizeFixture(fixtureTimeline());
  const plan = buildOpeningDeliveryPlan({identity: IDENTITY, timeline});
  const first = timeline.shots[2]; // N002-S1 starts exactly where the insertion begins
  const second = timeline.shots[3];
  assert.deepEqual(
    {startSec: r(deliveryShotWindow(first, plan).startSec), endSec: r(deliveryShotWindow(first, plan).endSec)},
    {startSec: 17.368, endSec: 26.168},
  );
  assert.deepEqual(
    {startSec: r(deliveryShotWindow(second, plan).startSec), endSec: r(deliveryShotWindow(second, plan).endSec)},
    {startSec: 26.168, endSec: 37.816},
  );
  const override = plan.deliveryShotOverrides.get(second.slotId);
  assert.equal(second.trailingHoldSec, override.trailingHoldSec,
    "N002 trailing hold unchanged (no re-timing)");
  // Delivery time mapping is a pure offset after the insertion boundary.
  assert.equal(r(toDeliveryTime(13.368, plan)), 17.368);
  assert.equal(toDeliveryTime(13.367, plan), 13.367);
  assert.equal(toDeliveryTime(13.368, null), 13.368);
});

// ---------------------------------------------------------------------------
// 7. Subtitle insertion / suppression (shared builder).
// ---------------------------------------------------------------------------
test("7: subtitles shift with the body, never intersect the identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opening-parity-"));
  try {
    const project = path.join(root, "projects", "PARITY-FIXTURE");
    await mkdir(path.join(project, "temp"), {recursive: true});
    const timeline = finalizeFixture(fixtureTimeline());
    await writeFile(path.join(project, "assembly-timeline.json"), JSON.stringify(timeline), "utf8");
    for (const block of timeline.blocks) {
      await writeFile(
        path.join(project, "temp", `${block.sentenceId}.vtt`),
        "WEBVTT\n\n00:00:00.100 --> 00:00:06.000\nEvery approved word stays here.\n",
        "utf8",
      );
    }
    const before = await buildSubtitleTimeline({root, episode: "PARITY-FIXTURE"});
    const insertion = {startSec: 13.368, durationSec: 4};
    const after = await buildSubtitleTimeline({root, episode: "PARITY-FIXTURE", insertion});
    assert.equal(after.report.passed, true, "shared subtitle QA gate passes");
    assert.deepEqual(after.cues.map((c) => c.text), before.cues.map((c) => c.text),
      "no word is dropped or re-split by the insertion");
    assert.equal(after.cues[0].startSec, before.cues[0].startSec, "hook subtitles unmoved");
    assert.equal(r(after.cues.at(-1).startSec), r(before.cues.at(-1).startSec + 4));
    assert.equal(r(after.cues.at(-1).endSec), r(before.cues.at(-1).endSec + 4));
    // N002's first cue: 13.468 assembly -> 17.468 delivery (approved v13 value).
    const bodyCue = after.cues.find((c) => c.startSec > 13.368 + 1e-9);
    assert.equal(r(bodyCue.startSec), 17.468);
    const insideIdentity = after.cues.filter(
      (c) => c.startSec < 13.368 + 4 - 1e-9 && c.endSec > 13.368 + 1e-9,
    );
    assert.equal(insideIdentity.length, 0, "identity window is subtitle-free");
    // The plan's insertion handoff is exactly what the renderers pass along.
    const plan = buildOpeningDeliveryPlan({identity: IDENTITY, timeline});
    assert.deepEqual(plan.subtitleInsertion, insertion);
    const viaPlan = await buildSubtitleTimeline({
      root, episode: "PARITY-FIXTURE", insertion: plan.subtitleInsertion,
    });
    assert.deepEqual(viaPlan.cues, after.cues, "final passes the same insertion plan as review");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

// ---------------------------------------------------------------------------
// 8. Ending behavior unchanged.
// ---------------------------------------------------------------------------
test("8: ending semantics unchanged (4 s hold, series-title card)", () => {
  const legacy = resolveEndingCardSpec({finalAssembly: null});
  assert.equal(legacy.endingHoldSec, 4.0);
  assert.equal(legacy.text, IDENTITY.seriesTitle);
  const withAssembly = resolveEndingCardSpec({
    finalAssembly: {
      title: {episodeTitle: IDENTITY.episodeTitle},
      endCard: {source: "seriesTitle"},
      endingHoldSec: 4.0,
    },
  });
  assert.deepEqual(withAssembly, legacy);
  const timeline = finalizeFixture(fixtureTimeline());
  const plan = buildOpeningDeliveryPlan({identity: IDENTITY, timeline});
  assert.equal(r(deliveryDurationSec(timeline, plan) + legacy.endingHoldSec), r(timeline.plannedDurationSec + 4 + 4));
});


// ---------------------------------------------------------------------------
// 9. 1080p title scaling.
// ---------------------------------------------------------------------------
test("9: 1080p card typography is the approved 540p review style scaled by ratio", () => {
  assert.equal(finalTitleFontSize({kind: "channel", height: 1080}), 72);
  assert.equal(finalTitleFontSize({kind: "episode", height: 1080}), 48);
  assert.equal(finalTitleFontSize({kind: "channel", height: 540}), 36);
  assert.equal(finalTitleFontSize({kind: "episode", height: 540}), 24);
  for (const kind of ["channel", "episode"]) {
    assert.equal(
      finalTitleFontSize({kind, height: 1080}),
      finalTitleFontSize({kind, height: 540}) * 2,
      `${kind}: final typography is a pure scale of the review style`,
    );
  }
});

// ---------------------------------------------------------------------------
// 10. Legacy episode compatibility.
// ---------------------------------------------------------------------------
test("10: episodes without openingIdentity are completely unaffected", () => {
  const timeline = finalizeFixture(fixtureTimeline());
  assert.equal(buildOpeningDeliveryPlan({identity: null, timeline}), null);
  assert.equal(buildOpeningDeliveryPlan({identity: undefined, timeline}), null);
  assert.equal(toDeliveryTime(123.456, null), 123.456);
  assert.equal(openingBodyOffsetSec(null), 0);
  assert.deepEqual(deliveryEventWindow({startSec: 1, endSec: 2}, null), {startSec: 1, endSec: 2});
  const legacyShot = timeline.shots[3];
  assert.deepEqual(deliveryShotWindow(legacyShot, null), {startSec: 22.168, endSec: 33.816});
});

// ---------------------------------------------------------------------------
// Shared-plan provenance: one algorithm for review and final.
// ---------------------------------------------------------------------------
test("11: delivery module builds on the single shared opening plan", () => {
  const viaDelivery = buildOpeningDeliveryPlan({identity: IDENTITY, timeline: finalizeFixture(fixtureTimeline())});
  const viaShared = planOpeningInsertion(IDENTITY, finalizeFixture(fixtureTimeline()));
  assert.equal(viaDelivery.startSec, viaShared.startSec);
  assert.equal(viaDelivery.durationSec, viaShared.durationSec);
  assert.equal(viaDelivery.plan.sourceDuration, viaShared.sourceDuration);
  assert.deepEqual(viaDelivery.cards, viaShared.cards);
  assert.equal(viaDelivery.bodyOffsetSec, viaShared.durationSec);
});

// ---------------------------------------------------------------------------
// Approved-episode regression: the REAL ESSY-0004 metadata must reproduce the
// exact approved v13 values (frozen editorial timing is never re-derived).
// ---------------------------------------------------------------------------
const REAL_PROJECT = path.join(factoryRoot, "projects", "ESSY-0004");
const hasRealProject = existsSync(path.join(REAL_PROJECT, "assembly-timeline.json"))
  && existsSync(path.join(factoryRoot, "projects", "_drafts", "ESSY-0004", "production-package.json"));

test("12: approved ESSY-0004 v13 opening values reproduce exactly", {skip: !hasRealProject}, async () => {
  const timeline = JSON.parse(await readFile(path.join(REAL_PROJECT, "assembly-timeline.json"), "utf8"));
  const pkg = JSON.parse(
    await readFile(path.join(factoryRoot, "projects", "_drafts", "ESSY-0004", "production-package.json"), "utf8"),
  );
  const plan = buildOpeningDeliveryPlan({identity: pkg.openingIdentity, timeline});
  assert.equal(plan.startSec, 13.368);
  assert.equal(r(plan.endSec), 17.368);
  assert.equal(r(plan.plan.sourceDuration), 10.984);
  assert.deepEqual(
    plan.cards.map((c) => [c.kind, c.text, r(c.startSec), r(c.endSec)]),
    [
      ["channel", "A SECOND LOOK AT LIFE", 13.368, 15.368],
      ["episode", "Who Am I Beyond My Roles?", 15.368, 17.368],
    ],
  );
  assert.equal(plan.hookSlotId, "N001-S2");
  const override = plan.deliveryShotOverrides.get("N001-S2");
  assert.equal(override.playbackDurationSec, 10.384);
  assert.equal(override.trailingHoldSec, 0.6);
  assert.equal(Number((override.playbackDurationSec + override.trailingHoldSec).toFixed(3)), 10.984);
  // 35 approved shots, all present, none added or removed.
  assert.equal(timeline.shots.length, 35);
  assert.equal(plan.deliveryShotOverrides.size, 35);
  // N002 resumes at 17.368 s with unchanged durations and hold.
  assert.deepEqual(
    {
      startSec: r(deliveryShotWindow(timeline.shots[2], plan).startSec),
      endSec: r(deliveryShotWindow(timeline.shots[2], plan).endSec),
    },
    {startSec: 17.368, endSec: 26.168},
  );
  assert.equal(plan.deliveryShotOverrides.get("N002-S2").trailingHoldSec, 0.6);
  // N008 trim/hold semantics untouched.
  const n008 = timeline.blocks.find((b) => b.sentenceId === "sentence-008");
  assert.equal(n008.trimmedSec, 0.106);
  assert.equal(n008.shots.at(-1).trailingHoldSec, 0.706);
  assert.equal(plan.deliveryShotOverrides.get("N008-S2").playbackDurationSec, 12.202);
  assert.equal(plan.deliveryShotOverrides.get("N008-S2").trailingHoldSec, 0.706);
  assert.equal(
    r(deliveryDurationSec(timeline, plan) - assemblyShotTotalSec(timeline, null)),
    4,
    "the approved 35-shot program is extended by exactly the insertion",
  );
  assert.ok(
    Math.abs(deliveryDurationSec(timeline, plan) - 390.976) <= 0.002,
    "delivery = 386.976 s approved program + 4.000 s insertion",
  );
});

test("13: an openingIdentity episode cannot also declare a pre-roll card", async () => {
  // Pre-roll and insertion are mutually exclusive; the shared resolver refuses
  // to silently produce two competing openings.
  const root = await mkdtemp(path.join(os.tmpdir(), "opening-conflict-"));
  try {
    const dir = path.join(root, "projects", "_drafts", "CONFLICT");
    await mkdir(dir, {recursive: true});
    await writeFile(
      path.join(dir, "production-package.json"),
      JSON.stringify({
        openingIdentity: IDENTITY,
        packaging: {preRollTitleCard: {text: "A Second Look at Life", durationSec: 4}},
      }),
      "utf8",
    );
    await assert.rejects(
      resolveEpisodePreRollTitleCard({root, episode: "CONFLICT"}),
      /Conflicting opening mechanisms/,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
