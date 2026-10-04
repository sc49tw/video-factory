// Regression tests for the master-draft freshness + shot-source gates.
//
// Defect class these pin: the 540p review render burns onto the full-draft
// master, which is a CACHE of the assembly timeline and the shot source files.
// An approved asset swap updated the asset map, the download and the timeline,
// but the master was never re-rendered, so the delivered review silently shipped
// the previous picture (N018-S2 replayed N018-S1's footage). Content-based
// fingerprinting plus an auto-rebuild is what makes an asset change propagate.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {promisify} from "node:util";
import {
  assertMasterDraftFresh,
  computeMasterDraftFingerprint,
  findDuplicateSourceShots,
  masterDraftProvenancePath,
  writeMasterDraftProvenance,
} from "../src/master-draft-freshness.mjs";
import {measureMediaContent, MEDIA_VALIDATION_DEFAULTS} from "../src/media-content-validation.mjs";

const exec = promisify(execFile);
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const hasFfmpeg = await (async () => {
  try {
    await exec("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
})();

async function scaffoldEpisode() {
  const root = await mkdtemp(path.join(os.tmpdir(), "master-draft-"));
  const episode = "TEST-0002";
  const project = path.join(root, "projects", episode);
  await mkdir(project, {recursive: true});
  return {root, episode, project};
}

// Build a fake episode whose "source" files are real bytes so sha256 is meaningful.
async function writeSources(project, entries) {
  for (const [name, content] of Object.entries(entries)) {
    await writeFile(path.join(project, name), content, "utf8");
  }
}

const timelineDoc = (shots) => ({
  schemaVersion: "1.0",
  episode: "TEST-0002",
  plannedDurationSec: 30,
  blocks: [
    {
      sentenceId: "sentence-001",
      startSec: 0,
      endSec: 30,
      durationSec: 30,
      shots: shots.map((shot, index) => ({
        index,
        blockId: "sentence-001",
        slotId: shot.slotId,
        mediaType: "video",
        sourcePath: shot.sourcePath,
        sourceDurationSec: 60,
        inPointSec: shot.inPointSec ?? 0,
        renderDurationSec: shot.renderDurationSec ?? 10,
        startSec: index * 10,
        endSec: (index + 1) * 10,
        trailingHoldSec: 0,
        absoluteStartSec: index * 10,
        absoluteEndSec: (index + 1) * 10,
      })),
    },
  ],
});

test("fingerprint changes when a shot source's bytes change", async () => {
  const {root, episode, project} = await scaffoldEpisode();
  const sources = {
    "a.mp4": "AAAA-source-a",
    "b.mp4": "BBBB-source-b",
  };
  await writeSources(project, sources);
  const timelinePath = path.join(project, "assembly-timeline.json");
  await writeFile(
    timelinePath,
    JSON.stringify(
      timelineDoc([
        {slotId: "N001-S1", sourcePath: path.join(project, "a.mp4")},
        {slotId: "N001-S2", sourcePath: path.join(project, "b.mp4")},
      ]),
    ),
    "utf8",
  );

  const before = await computeMasterDraftFingerprint({root, episode});
  assert.equal(before.shots.length, 2);
  assert.equal(before.shots.find((s) => s.slotId === "N001-S1").sourceSha256, sha256(Buffer.from("AAAA-source-a")));

  // Swap the asset behind N001-S2: same slot, different bytes. The fingerprint
  // must notice, because the review render would otherwise keep the old picture.
  await writeSources(project, {"b.mp4": "CCCC-replacement-for-b"});
  const after = await computeMasterDraftFingerprint({root, episode});
  assert.notEqual(before.fingerprintSha256, after.fingerprintSha256);
});

test("a master with no recorded fingerprint is stale, not trusted", async () => {
  const {root, episode, project} = await scaffoldEpisode();
  await writeSources(project, {"a.mp4": "AAAA", "b.mp4": "BBBB"});
  await writeFile(
    path.join(project, "assembly-timeline.json"),
    JSON.stringify(
      timelineDoc([
        {slotId: "N001-S1", sourcePath: path.join(project, "a.mp4")},
        {slotId: "N001-S2", sourcePath: path.join(project, "b.mp4")},
      ]),
    ),
    "utf8",
  );
  const masterPath = path.join(root, "output", episode, `${episode}-full-draft-v1.mp4`);
  await mkdir(path.dirname(masterPath), {recursive: true});
  await writeFile(masterPath, "fake-master-bytes", "utf8");

  const verdict = await assertMasterDraftFresh({root, episode, masterPath});
  assert.equal(verdict.fresh, false);
  assert.match(verdict.reason, /No dependency fingerprint recorded/);
  assert.equal(verdict.recordedFingerprintSha256, null);
});

test("recorded fingerprint reports fresh, then stale after an asset swap, naming the slot", async () => {
  const {root, episode, project} = await scaffoldEpisode();
  await writeSources(project, {"a.mp4": "AAAA", "b.mp4": "BBBB"});
  await writeFile(
    path.join(project, "assembly-timeline.json"),
    JSON.stringify(
      timelineDoc([
        {slotId: "N001-S1", sourcePath: path.join(project, "a.mp4")},
        {slotId: "N001-S2", sourcePath: path.join(project, "b.mp4")},
      ]),
    ),
    "utf8",
  );
  const masterPath = path.join(root, "output", episode, `${episode}-full-draft-v1.mp4`);
  await mkdir(path.dirname(masterPath), {recursive: true});
  await writeFile(masterPath, "master", "utf8");

  const fingerprint = await computeMasterDraftFingerprint({root, episode});
  await writeMasterDraftProvenance({root, masterPath, fingerprint});

  assert.ok((await assertMasterDraftFresh({root, episode, masterPath})).fresh);

  await writeSources(project, {"b.mp4": "ZZZZ-approved-replacement"});
  const stale = await assertMasterDraftFresh({root, episode, masterPath});
  assert.equal(stale.fresh, false);
  assert.deepEqual(stale.changedSlots, ["N001-S2"]);
  assert.match(stale.reason, /source changed: N001-S2/);
});

test("provenance lives beside the master draft", () => {
  assert.equal(
    masterDraftProvenancePath("output/E/E-full-draft-v1.mp4"),
    "output/E/E-full-draft-v1.mp4.provenance.json",
  );
});

test("repetition gate flags overlapping plays of one take and allows disjoint cuts", () => {
  const shot = (slotId, inPointSec, renderDurationSec, sha) => ({
    slotId,
    sentenceId: "sentence-001",
    sourceSha256: sha,
    sourcePath: `downloads/${slotId}.mp4`,
    inPointSec,
    renderDurationSec,
  });
  // This is the N018-S2 failure: same asset, both rendered from t=0.
  const overlap = findDuplicateSourceShots({
    shots: [shot("N018-S1", 0, 8.568, "same"), shot("N018-S2", 0, 8.568, "same")],
  });
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].isRepetition, true);
  assert.deepEqual(overlap[0].overlapping[0].slotIds, ["N018-S1", "N018-S2"]);

  // The N004 shape: one licensed take cut twice at disjoint in-points.
  const disjoint = findDuplicateSourceShots({
    shots: [shot("N004-S1", 0, 13.92, "same"), shot("N004-S2", 18, 13.92, "same")],
  });
  assert.equal(disjoint.length, 1);
  assert.equal(disjoint[0].isRepetition, false);
  assert.deepEqual(disjoint[0].overlapping, []);

  // Different blocks never count as a back-to-back repetition.
  const crossBlock = findDuplicateSourceShots({
    shots: [
      {...shot("N001-S1", 0, 10, "same"), sentenceId: "sentence-001"},
      {...shot("N002-S1", 0, 10, "same"), sentenceId: "sentence-002"},
    ],
  });
  assert.deepEqual(crossBlock, []);
});

test("distinct assets never register as a repetition", () => {
  const groups = findDuplicateSourceShots({
    shots: [
      {slotId: "N018-S1", sentenceId: "sentence-018", sourceSha256: "a", sourcePath: "a.mp4", inPointSec: 0, renderDurationSec: 8},
      {slotId: "N018-S2", sentenceId: "sentence-018", sourceSha256: "b", sourcePath: "b.mp4", inPointSec: 0, renderDurationSec: 8},
      {slotId: "N018-S3", sentenceId: "sentence-018", sourceSha256: "c", sourcePath: "c.mp4", inPointSec: 0, renderDurationSec: 8},
    ],
  });
  assert.deepEqual(groups, []);
});

test("degenerate-media thresholds are explicit", () => {
  assert.equal(MEDIA_VALIDATION_DEFAULTS.minSpatialDetail, 3);
  assert.equal(MEDIA_VALIDATION_DEFAULTS.minMotion, 0.5);
});

test("a flat generated clip is detected as degenerate; real footage is not", {skip: !hasFfmpeg && "ffmpeg unavailable"}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "media-content-"));
  // This is the shape of the stub that shipped as N018-S2: a valid MP4 whose
  // every frame is the same gray value.
  const flat = path.join(dir, "flat.mp4");
  await exec("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=1920x1080:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", flat,
  ]);
  const flatStats = await measureMediaContent(flat);
  assert.equal(flatStats.degenerate, true);
  assert.ok(flatStats.reasons.some((r) => r.includes("flat picture")));

  const motion = path.join(dir, "motion.mp4");
  await exec("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", motion,
  ]);
  const motionStats = await measureMediaContent(motion);
  assert.equal(motionStats.degenerate, false);
  assert.ok(motionStats.spatialDetail > MEDIA_VALIDATION_DEFAULTS.minSpatialDetail);
});

test("measured metadata is reported truthfully for a generated clip", {skip: !hasFfmpeg && "ffmpeg unavailable"}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "media-meta-"));
  const file = path.join(dir, "clip.mp4");
  await exec("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=2:r=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file,
  ]);
  const stats = await measureMediaContent(file);
  assert.equal(stats.width, 320);
  assert.equal(stats.height, 240);
  assert.ok(Math.abs(stats.durationSec - 2) < 0.2);
  assert.ok(stats.bytes > 0);
  assert.ok(stats.samples >= 3);
  const bytes = await readFile(file);
  assert.equal(stats.bytes, bytes.length);
});