// Master-draft dependency fingerprint and freshness gate.
//
// The 540p review render does NOT re-render shots: it re-scales and burns
// subtitles onto the already-rendered full-draft master
// (output/<EPISODE>/<EPISODE>-full-draft*.mp4). That makes the master a CACHE
// whose inputs are the assembly timeline and the shot source files.
//
// Without a recorded fingerprint the cache is invisible: after an approved
// asset swap (approved-slot-asset-map.json -> new download -> rebuilt
// assembly-timeline.json) the review render still consumes the previous master
// and silently ships the old picture. This module makes the dependency
// explicit and checkable:
//
//   computeMasterDraftFingerprint()  sha256 of the assembly timeline plus the
//                                    sha256/bytes/duration of every shot source
//   writeMasterDraftProvenance()    stores that fingerprint next to the master
//   assertMasterDraftFresh()         recomputes and compares; returns a verdict
//                                    with the exact list of changed slots
//
// The comparison is content-based (hashes), never mtime-based, so touching a
// file cannot fake freshness and editing content can never fake staleness.

import {createHash} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import path from "node:path";
import {measureMediaContent} from "./media-content-validation.mjs";

export const PROVENANCE_SUFFIX = ".provenance.json";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export function masterDraftProvenancePath(masterPath) {
  return `${masterPath}${PROVENANCE_SUFFIX}`;
}

/**
 * Content fingerprint of everything the master draft depends on.
 * @returns {Promise<{schemaVersion:string,episode:string,assemblyTimelineSha256:string,
 *   shots:Array<object>,fingerprintSha256:string}>}
 */
export async function computeMasterDraftFingerprint({root, episode}) {
  const timelinePath = path.join(root, "projects", episode, "assembly-timeline.json");
  const timelineBytes = await readFile(timelinePath);
  const timeline = JSON.parse(timelineBytes.toString("utf8"));

  const shots = [];
  for (const block of timeline.blocks ?? []) {
    for (const shot of block.shots ?? []) {
      const bytes = await readFile(shot.sourcePath);
      shots.push({
        slotId: shot.slotId,
        sentenceId: block.sentenceId,
        mediaType: shot.mediaType ?? "video",
        sourcePath: path.relative(root, shot.sourcePath).replaceAll("\\", "/"),
        sourceSha256: sha256(bytes),
        sourceBytes: bytes.length,
        sourceDurationSec: shot.sourceDurationSec ?? null,
        inPointSec: shot.inPointSec ?? 0,
        renderDurationSec: shot.renderDurationSec ?? null,
        startSec: shot.absoluteStartSec ?? null,
        endSec: shot.absoluteEndSec ?? null,
      });
    }
  }

  const payload = {
    schemaVersion: "1.0",
    episode,
    assemblyTimelinePath: path.relative(root, timelinePath).replaceAll("\\", "/"),
    assemblyTimelineSha256: sha256(timelineBytes),
    shots,
  };
  return {...payload, fingerprintSha256: sha256(JSON.stringify(payload))};
}

export async function writeMasterDraftProvenance({root, masterPath, fingerprint, extra = {}}) {
  const target = masterDraftProvenancePath(masterPath);
  await writeFile(
    target,
    `${JSON.stringify({
      ...fingerprint,
      masterPath: path.relative(root, masterPath).replaceAll("\\", "/"),
      masterBytes: (await readFile(masterPath)).length,
      writtenAt: new Date().toISOString(),
      ...extra,
    }, null, 2)}\n`,
    "utf8",
  );
  return target;
}

export async function readMasterDraftProvenance(masterPath) {
  const target = masterDraftProvenancePath(masterPath);
  if (!existsSync(target)) return null;
  return JSON.parse(await readFile(target, "utf8"));
}

/**
 * Compare the recorded fingerprint with the current inputs.
 * @returns {Promise<{fresh:boolean,reason:string|null,changedSlots:string[],
 *   recordedFingerprintSha256:string|null,currentFingerprintSha256:string}>}
 */
export async function assertMasterDraftFresh({root, episode, masterPath}) {
  const recorded = await readMasterDraftProvenance(masterPath);
  const current = await computeMasterDraftFingerprint({root, episode});

  if (!recorded) {
    return {
      fresh: false,
      reason:
        `No dependency fingerprint recorded for ${path.basename(masterPath)}. ` +
        `It was rendered by a build that predates the freshness gate, so an approved asset ` +
        `change cannot be proven to have reached it.`,
      changedSlots: current.shots.map((s) => s.slotId),
      recordedFingerprintSha256: null,
      currentFingerprintSha256: current.fingerprintSha256,
      current,
    };
  }

  if (recorded.fingerprintSha256 === current.fingerprintSha256) {
    return {
      fresh: true,
      reason: null,
      changedSlots: [],
      recordedFingerprintSha256: recorded.fingerprintSha256,
      currentFingerprintSha256: current.fingerprintSha256,
      current,
    };
  }

  const recordedBySlot = new Map((recorded.shots ?? []).map((s) => [s.slotId, s]));
  const changedSlots = [];
  for (const shot of current.shots) {
    const before = recordedBySlot.get(shot.slotId);
    if (!before || before.sourceSha256 !== shot.sourceSha256) changedSlots.push(shot.slotId);
  }
  const removedSlots = (recorded.shots ?? [])
    .filter((s) => !current.shots.some((c) => c.slotId === s.slotId))
    .map((s) => s.slotId);

  const timelineChanged = recorded.assemblyTimelineSha256 !== current.assemblyTimelineSha256;
  const detail = [
    changedSlots.length ? `source changed: ${changedSlots.join(", ")}` : null,
    removedSlots.length ? `slot removed: ${removedSlots.join(", ")}` : null,
    timelineChanged ? "assembly-timeline.json content changed" : null,
  ].filter(Boolean).join("; ");

  return {
    fresh: false,
    reason:
      `${path.basename(masterPath)} is STALE with respect to its declared inputs (${detail}). ` +
      `Re-render the full draft before producing a review proxy.`,
    changedSlots: [...changedSlots, ...removedSlots],
    recordedFingerprintSha256: recorded.fingerprintSha256 ?? null,
    currentFingerprintSha256: current.fingerprintSha256,
    current,
  };
}

/**
 * Editorial guard: two slots inside one narration block that resolve to the same
 * source bytes are only acceptable when the approved-slot-asset-map gives them
 * DISJOINT source ranges (the same licensed take cut twice). If their rendered
 * source ranges overlap, the delivered picture repeats the same frames back to
 * back — the visual-repetition defect human QA reports as "the same shot appears
 * twice".
 *
 * Detection is content-based (sha256) and range-based, because this repo names
 * every download per slot (N004-S1-*.mp4 / N004-S2-*.mp4 can be two copies of
 * one file), so a path-identity check cannot see the duplication.
 */
export function findDuplicateSourceShots(fingerprint) {
  const byBlock = new Map();
  for (const shot of fingerprint.shots) {
    const list = byBlock.get(shot.sentenceId) ?? [];
    list.push(shot);
    byBlock.set(shot.sentenceId, list);
  }
  const duplicates = [];
  for (const [sentenceId, shots] of byBlock) {
    const byHash = new Map();
    for (const shot of shots) {
      const list = byHash.get(shot.sourceSha256) ?? [];
      list.push(shot);
      byHash.set(shot.sourceSha256, list);
    }
    for (const [sourceSha256, group] of byHash) {
      if (group.length < 2) continue;
      // Source range each slot actually plays, from its approved in-point.
      const ranges = group.map((g) => {
        const inPoint = Number(g.inPointSec ?? 0);
        const render = Number(g.renderDurationSec ?? 0);
        return {slotId: g.slotId, start: inPoint, end: inPoint + render, inPoint, render};
      });
      const overlapping = [];
      for (let a = 0; a < ranges.length; a++) {
        for (let b = a + 1; b < ranges.length; b++) {
          const overlap = Math.min(ranges[a].end, ranges[b].end) - Math.max(ranges[a].start, ranges[b].start);
          if (overlap > 0.001) {
            overlapping.push({
              slotIds: [ranges[a].slotId, ranges[b].slotId],
              overlapSec: Number(overlap.toFixed(3)),
            });
          }
        }
      }
      duplicates.push({
        sentenceId,
        slotIds: group.map((g) => g.slotId),
        sourcePath: group[0].sourcePath,
        sourceSha256,
        sourceRanges: ranges,
        overlapping,
        // Same take, disjoint cuts: an approved editorial decision, not a defect.
        isRepetition: overlapping.length > 0,
      });
    }
  }
  return duplicates;
}

/**
 * Hard gate used by the full-draft renderer: every shot source must carry real
 * picture content. Catches flat/stub downloads that passed container checks.
 */
export async function assertShotSourcesRenderable(fingerprint) {
  const degenerate = [];
  for (const shot of fingerprint.shots) {
    const absolute = path.isAbsolute(shot.sourcePath)
      ? shot.sourcePath
      : path.join(process.cwd(), shot.sourcePath);
    const stats = await measureMediaContent(absolute, {stillImage: shot.mediaType === "photo"});
    if (stats.degenerate) {
      degenerate.push({slotId: shot.slotId, sourcePath: shot.sourcePath, reasons: stats.reasons, stats});
    }
  }
  if (degenerate.length) {
    const lines = degenerate
      .map((d) => `  ${d.slotId} (${d.sourcePath}): ${d.reasons.join("; ")}`)
      .join("\n");
    throw new Error(
      `Shot source(s) carry no usable picture content and cannot be rendered:\n${lines}\n` +
        `Re-download the approved asset; a degenerate file must never reach a render.`,
    );
  }
  return true;
}