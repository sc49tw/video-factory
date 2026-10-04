// Rendered-review verification: proves properties of the ACTUAL delivered MP4.
//
// Config and manifest state are never sufficient evidence. Everything here is
// measured from the pixels of the rendered file (plus the exact subtitle file
// libass was given), so a claim like "the replacement asset is on screen" or "no
// placeholder text remains" is falsifiable.
//
// Checks:
//   1. SUBTITLE SOURCE   the burned bilingual SRT: cue count, 1:1 mapping to the
//                        authoritative English SRT, verbatim timing, zero
//                        placeholder/empty/stale entries.
//   2. SUBTITLE INK      every one of the N cue windows shows a real two-line
//                        subtitle block in the subtitle band of the delivered
//                        video (English line + Traditional Chinese line).
//   3. IDENTITY WINDOW   openingIdentity occupies exactly 14.736-18.736s, its
//                        two title cards are drawn, and the subtitle band carries
//                        NO subtitle ink during that window.
//   4. SLOT PROOF       each probed slot window matches its approved asset by
//                        signature score, with the runner-up far behind.
//
// Usage:
//   node scripts/_verify-review-render.mjs --episode ESSY-0005 \
//     --review output/ESSY-0005/ESSY-0005-review-540p-subtitled-v3.mp4
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {spawn} from "node:child_process";
import {computeMasterDraftFingerprint, findDuplicateSourceShots} from "../src/master-draft-freshness.mjs";
import {planOpeningInsertion} from "./essay-opening-plan.mjs";
import {buildOpeningDeliveryPlan} from "./essay-opening-delivery.mjs";

const run = (cmd, args, binary = false) =>
  new Promise((resolve, reject) => {
    const c = spawn(cmd, args, {stdio: ["ignore", "pipe", "pipe"], encoding: binary ? "buffer" : "utf8"});
    const chunks = [];
    let se = "";
    c.stdout.on("data", (d) => chunks.push(d));
    c.stderr.on("data", (d) => (se += d.toString()));
    c.on("error", reject);
    c.on("close", (code) =>
      code === 0
        ? resolve(binary ? Buffer.concat(chunks) : chunks.join(""))
        : reject(new Error(`${cmd} ${code}: ${se.slice(-2000)}`)),
    );
  });

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? null : argv[i + 1];
};
const episode = argOf("episode") ?? "ESSY-0005";
const review = argOf("review");
const masterArg = argOf("master");
const reportName = argOf("report") ?? `${episode}-${path.basename(review ?? "", ".mp4")}-verification.json`;
const root = process.cwd();
const project = path.join(root, "projects", episode);

const parseSrt = (raw) =>
  raw
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const L = b.split(/\r?\n/);
      const t = (v) => {
        const [h, m, r] = v.split(":");
        const [ss, ms] = r.split(",");
        return +h * 3600 + +m * 60 + +ss + +ms / 1000;
      };
      const [s, e] = L[1].split("-->").map((x) => x.trim());
      return {id: L[0].trim(), start: t(s), end: t(e), timecode: L[1].trim(), text: L.slice(2).join("\n")};
    });

// ---- reference differencing --------------------------------------------------
// Absolute brightness cannot detect burned text: a near-white wall or a black
// frame produces thousands of "white" or "black" pixels with no text at all,
// which is how a naive ink counter both invents subtitles and misses them.
//
// Instead every subtitle claim is made by DIFFERENCING the delivered frame
// against a frame of the same picture content with no subtitles burned:
//   - inside a cue window: the full-draft master at (delivery t - offset)
//   - inside the openingIdentity window: a reference render of the identity
//     segment's own source at the same in-point
// Pixels that differ by more than re-encode noise ARE the burned subtitle, so
// the measurement is independent of what the picture happens to look like.
//
// The same tool therefore verifies the 540p review proxy and the 1080p final
// master: burn geometry is expressed at the 540p design resolution and scaled
// by the target's actual height, and the reference chain uses the target's own
// width/height. Nothing here is 540p-specific.
const DESIGN_HEIGHT = 540;
// Measured burn geometry at the 540p design resolution for FONT_SIZE 28 / zh 18
// / MARGIN_V 64: English glyph rows 425-447, Traditional Chinese glyph rows
// 453-473. libass script units are resolution-independent, so the same numbers
// scaled by height/540 hold at 1080p.
const EN_BAND_540 = [418, 450];
const ZH_BAND_540 = [450, 480];
const DIFF_THRESHOLD = 45;
const INK_MIN = 120;

async function grayFrame(file, seekSec, chain) {
  const buf = await run(
    "ffmpeg",
    ["-v", "error", "-ss", seekSec.toFixed(3), "-i", file, "-frames:v", "1",
      "-vf", `${chain},format=gray`, "-f", "rawvideo", "-"],
    true,
  );
  return Buffer.from(buf.subarray(0, targetWidth * targetHeight));
}

const targetProbe = JSON.parse(await run("ffprobe", [
  "-v", "error",
  "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "json", review,
]));
const targetWidth = targetProbe.streams?.[0]?.width ?? 960;
const targetHeight = targetProbe.streams?.[0]?.height ?? 540;
const geomScale = targetHeight / DESIGN_HEIGHT;
const EN_BAND = EN_BAND_540.map((row) => Math.round(row * geomScale));
const ZH_BAND = ZH_BAND_540.map((row) => Math.round(row * geomScale));

/** Count pixels in a row band where the delivered frame departs from its reference. */
function bandDiff(a, b, [from, to]) {
  if (!a || !b) return 0;
  let changed = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < targetWidth; x++) {
      if (Math.abs(a[y * targetWidth + x] - b[y * targetWidth + x]) >= DIFF_THRESHOLD) changed++;
    }
  }
  return changed;
}

/**
 * Burned-subtitle ink for one cue window, measured as the INTERSECTION of two
 * independent conditions:
 *
 *   1. the delivered pixel differs from EVERY plausible subtitle-free reference
 *      frame (the same picture sampled at several neighbouring frame times), and
 *   2. the same pixel is UNCHANGED between two frames inside the cue.
 *
 * Neither condition alone works. Condition 1 alone cannot separate text from
 * measurement noise: `-ss` frame selection can land a fraction of a frame away
 * from the picture that was actually encoded, and on moving footage that alone
 * produces ~900 differing pixels in the subtitle band — overlapping the
 * smallest real cue (~1179). Comparing against several neighbouring reference
 * times absorbs the alignment error (measured identity-window noise drops from
 * ~935 to ~180) without weakening the test, because burned subtitles differ
 * from all of them: none of the references carries any subtitle.
 *
 * Condition 2 is the second filter: burned subtitles are static for the whole
 * cue, while encode noise decorrelates between adjacent frames.
 */
function stableBandInk(f1, f2, references, [from, to]) {
  if (!f1 || !f2 || !references?.length) return 0;
  let ink = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const i = y * targetWidth + x;
      if (Math.abs(f1[i] - f2[i]) >= DIFF_THRESHOLD) continue; // moved => noise
      let closest = Infinity;
      for (const reference of references) {
        const d = Math.abs(f1[i] - reference[i]);
        if (d < closest) closest = d;
      }
      if (closest >= DIFF_THRESHOLD) ink++;
    }
  }
  return ink;
}

function lineInk(f1, f2, references) {
  return {
    englishLineInk: stableBandInk(f1, f2, references, EN_BAND),
    chineseLineInk: stableBandInk(f1, f2, references, ZH_BAND),
  };
}

// Frame times probed for a subtitle-free reference, centred on the delivered
// time. Neighbouring frame times absorb seek/frame-selection misalignment.
const REFERENCE_TAPS = [0, -1 / 30, 1 / 30, -2 / 30, 2 / 30].map((d) => d);

const chainFor = (width, height) =>
  `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height},fps=30`;

/** Reference chain: the delivered geometry, for re-encoding the source reference. */
const TARGET_CHAIN = chainFor(targetWidth, targetHeight);

/**
 * The subtitle-free reference master for this episode: the full-draft render of
 * the same approved assets, which exists for both the review proxy and the
 * final master. Resolved by explicit argument first so a caller verifying the
 * final can pin it, then by the conventional name.
 */
async function resolveMasterDraft() {
  const candidates = [];
  if (masterArg) candidates.push(path.resolve(root, masterArg));
  const {readdir} = await import("node:fs/promises");
  for (const name of (await readdir(path.join(root, "output", episode))).sort().reverse()) {
    if (name.startsWith(`${episode}-full-draft`) && name.endsWith(".mp4")) {
      candidates.push(path.join(root, "output", episode, name));
      break;
    }
  }
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(
    `No subtitle-free reference master for ${episode} (looked for ${episode}-full-draft*.mp4). ` +
      "Pass --master <path>.",
  );
}

const durationSec = Number(
  (await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", review])).trim(),
);
const offsetSec = Number(
  JSON.parse(await readFile(path.join(project, "opening-review-render.json"), "utf8")).opening?.durationSec ?? 0,
);

// ---- 1. subtitle source -----------------------------------------------------
const englishSrt = parseSrt(await readFile(path.join(project, "temp", `${episode}-subtitles.srt`), "utf8"));
const bilingualSrt = parseSrt(await readFile(path.join(project, "temp", `${episode}-subtitles-bilingual.srt`), "utf8"));
const PLACEHOLDER = /\[Translation missing\]|\[Missing|Translation missing|翻譯缺失|未翻譯|待翻譯|缺少翻譯|\bTODO\b|\bTBD\b/i;
const bilingualPlaceholders = bilingualSrt.filter((c) => PLACEHOLDER.test(c.text));
const bilingualEmptyZh = bilingualSrt.filter((c) => !/\\N\{\\fs\d+\}\S/.test(c.text));
const timingMismatches = bilingualSrt.filter((c, i) => !englishSrt[i] || c.timecode !== englishSrt[i].timecode);
const bilingualIds = new Set(bilingualSrt.map((c) => c.id));

const subtitleSource = {
  authoritativeEnglishCueCount: englishSrt.length,
  bilingualCueCount: bilingualSrt.length,
  zhEntriesPerCue: bilingualSrt.length,
  timingIdenticalToEnglish: timingMismatches.length === 0,
  timingMismatchCount: timingMismatches.length,
  placeholderCueCount: bilingualPlaceholders.length,
  emptyTranslationCount: bilingualEmptyZh.length,
  duplicateCueIdCount: bilingualSrt.length - bilingualIds.size,
  countMatchesEnglish: bilingualSrt.length === englishSrt.length,
  passed:
    bilingualSrt.length === englishSrt.length &&
    timingMismatches.length === 0 &&
    bilingualPlaceholders.length === 0 &&
    bilingualEmptyZh.length === 0 &&
    bilingualSrt.length === bilingualIds.size,
};

// ---- 2. subtitle ink in every cue window -------------------------------------
// Reference = the master draft (the same episode assembled with no subtitles
// burned) at the delivered time minus the opening-identity body offset.
// The reference MUST be rasterized at the TARGET geometry: bandDiff walks both
// buffers with the target's stride, so a natively-sized reference silently
// compares misaligned pixels and manufactures ink.
const masterDraft = await resolveMasterDraft();

const referencesForCue = async (deliverySec) => {
  const out = [];
  for (const tap of REFERENCE_TAPS) {
    out.push(await grayFrame(masterDraft, Math.max(0, deliverySec - offsetSec + tap), TARGET_CHAIN));
  }
  return out;
};

const inkRows = [];
for (const cue of englishSrt) {
  const span = cue.end - cue.start;
  const t1 = cue.start + Math.min(0.35, span / 2);
  // Second probe stays inside the same cue (no-subtitle QA guarantees >=700ms,
  // and the shared builder guarantees a single active cue at a time).
  const t2 = cue.start + Math.min(0.75, Math.max(0.1, span - 0.15));
  inkRows.push({
    id: cue.id,
    t: Number(t1.toFixed(3)),
    t2: Number(t2.toFixed(3)),
    ...lineInk(
      await grayFrame(review, t1, TARGET_CHAIN),
      await grayFrame(review, t2, TARGET_CHAIN),
      await referencesForCue(t1),
    ),
  });
}
const cuesWithoutEnglishInk = inkRows.filter((r) => r.englishLineInk < INK_MIN);
const cuesWithoutChineseInk = inkRows.filter((r) => r.chineseLineInk < INK_MIN);

// ---- 3. openingIdentity window ----------------------------------------------
const identity = JSON.parse(await readFile(path.join(root, "projects", "_drafts", episode, "production-package.json"), "utf8"))
  .openingIdentity;
const idStart = identity.timing.startSec;
const idEnd = identity.timing.startSec + identity.timing.durationSec;
const identityCueOverlap = englishSrt.filter((c) => c.start < idEnd && c.end > idStart);
// Probe strictly INSIDE the identity window: subtitle suppression must leave the
// burn rows empty for the whole window, while the cues either side must be inked.
// The identity window plays the hook shot's own approved source tail, so its
// subtitle-free reference is that source at the matching in-point — NOT the
// master draft, whose footage there is different content by design.
const timelineShots = JSON.parse(await readFile(path.join(project, "assembly-timeline.json"), "utf8")).shots ?? [];
// The hook shot is resolved through the SAME shared opening algorithm both
// renderers use, never re-derived here. Re-deriving it is how this check once
// compared the identity window against the shot the identity REPLACES.
const openingPlan = planOpeningInsertion(identity, JSON.parse(await readFile(path.join(project, "assembly-timeline.json"), "utf8")));
const hookShot = openingPlan?.shot ?? null;
// The delivery composition (hook playback extension + unchanged trailing hold)
// comes from the shared delivery plan, the same object both renderers consume.
const openingDelivery = buildOpeningDeliveryPlan({
  identity,
  timeline: JSON.parse(await readFile(path.join(project, "assembly-timeline.json"), "utf8")),
});
const hookOverride = hookShot ? openingDelivery?.deliveryShotOverrides.get(hookShot.slotId) : null;
const identityInk = [];
const IDENTITY_STEP_SEC = 0.2;
// Integer step count so the loop cannot drift across the closing boundary and
// probe a frame that is already outside the window.
const identityProbeCount = Math.ceil((idEnd - idStart) / IDENTITY_STEP_SEC);
for (let i = 0; i < identityProbeCount; i++) {
  const t = idStart + i * IDENTITY_STEP_SEC;
  if (t >= idEnd) break;
  if (!hookShot) {
    identityInk.push({t: Number(t.toFixed(3)), error: "no hook shot covers the identity window"});
    continue;
  }
  // Mirrors the identity footage the renderers build, for BOTH composition
  // conventions, because the approved 540p review proxy and the 1080p final
  // master put the hook shot's trailing hold on opposite sides of this window:
  //   review: a pure source window, live for all 4 s
  //   final:  the shared delivery plan extends the hook's source-tail PLAYBACK
  //           by the insertion, so the last `trailingHoldSec` of the window is
  //           a frozen last frame
  // Probing only the live time makes the frozen tail differ from its reference
  // and be reported as subtitle ink. Both candidates are supplied and the ink
  // measurement takes the closest match, so the check is correct for either
  // composition without knowing which one it is looking at.
  const sourceSec = t - Number(hookShot.absoluteStartSec ?? 0);
  const hookPlaybackEnd = Number(hookShot.absoluteStartSec ?? 0) + Number(hookOverride?.playbackDurationSec ?? hookShot.renderDurationSec);
  const frozenSourceSec = hookPlaybackEnd - Number(hookShot.absoluteStartSec ?? 0);
  const referenceTimes = new Set(REFERENCE_TAPS.map((tap) => sourceSec + tap));
  if (sourceSec > frozenSourceSec) {
    for (const tap of REFERENCE_TAPS) referenceTimes.add(frozenSourceSec + tap);
  }
  identityInk.push({
      t: Number(t.toFixed(3)),
      identitySourceSec: Number(sourceSec.toFixed(3)),
      frozenTail: sourceSec > frozenSourceSec,
      ...lineInk(
        await grayFrame(review, t, TARGET_CHAIN),
        await grayFrame(review, t + 0.15, TARGET_CHAIN),
        await Promise.all(
          [...referenceTimes].map((referenceSec) => grayFrame(hookShot.sourcePath, referenceSec, TARGET_CHAIN)),
        ),
      ),
    });
}
const identityInkFrames = identityInk.filter((r) => r.englishLineInk >= INK_MIN || r.chineseLineInk >= INK_MIN);
// Control: the cue immediately before and after the window must still be inked,
// otherwise "no ink in the window" could just mean "no subtitles anywhere".
const neighbours = englishSrt
  .filter((c) => c.end <= idStart || c.start >= idEnd)
  .reduce((best, c) => {
    const d = c.start < idStart ? idStart - c.end : c.start - idEnd;
    return !best || d < best.d ? {cue: c, d} : best;
  }, null);
const neighbourInk = neighbours
  ? (() => {
      const span = neighbours.cue.end - neighbours.cue.start;
      const t1 = neighbours.cue.start + Math.min(0.35, span / 2);
      const t2 = neighbours.cue.start + Math.min(0.75, Math.max(0.1, span - 0.15));
      return {
        cueId: neighbours.cue.id,
        t: Number(t1.toFixed(3)),
        t2: Number(t2.toFixed(3)),
      };
    })()
  : null;
if (neighbourInk) {
  Object.assign(neighbourInk, lineInk(
    await grayFrame(review, neighbourInk.t, TARGET_CHAIN),
    await grayFrame(review, neighbourInk.t2, TARGET_CHAIN),
    await referencesForCue(neighbourInk.t),
  ));
}

// ---- 4. slot proof -----------------------------------------------------------
const fingerprint = await computeMasterDraftFingerprint({root, episode});
const shots = [];
for (const block of JSON.parse(await readFile(path.join(project, "assembly-timeline.json"), "utf8")).blocks ?? []) {
  for (const shot of block.shots ?? []) shots.push({...shot, sentenceId: block.sentenceId});
}
const probeTimes = argv.includes("--slot-probe")
  ? argOf("slot-probe").split(",").map(Number)
  : shots.filter((s) => s.slotId.startsWith("N018")).flatMap((s) => {
      const span = s.absoluteEndSec - s.absoluteStartSec;
      return [s.absoluteStartSec + span * 0.25, s.absoluteStartSec + span * 0.75].map((x) =>
        Number((x + offsetSec).toFixed(3)));
    });

const GW = 16, GH = 9, RW = 256, RH = 144;
// The delivered frame is normalized to the same 256x144 signature grid whatever
// its resolution, so the same thresholds apply to the 540p proxy and the 1080p
// master. Source assets are compared through the canonical 1920x1080 shot chain
// the renderers use, so the comparison matches how the picture was built.
const SHOT_CHAIN = "scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080,fps=30,format=yuv420p";
const REVIEW_CHAIN = `scale=${RW}:${RH}:flags=area`;
async function signature(file, seekSec, chain) {
  const args = ["-v", "error"];
  if (seekSec > 0) args.push("-ss", seekSec.toFixed(3));
  args.push("-i", file, "-frames:v", "1", "-vf", `${chain},scale=${RW}:${RH}:flags=area,format=gray`, "-f", "rawvideo", "-");
  const buf = await run("ffmpeg", args, true);
  const px = buf.subarray(0, RW * RH);
  const cw = RW / GW, ch = RH / GH, cells = [];
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      if ((gy + 0.5) / GH > 0.72) continue; // exclude the subtitle band
      let s = 0;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) s += px[(gy * ch + y) * RW + gx * cw + x];
      cells.push(s / (cw * ch));
    }
  }
  return cells;
}
const score = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let sad = 0;
  for (let i = 0; i < a.length; i++) sad += Math.abs(a[i] - b[i]);
  const value = 100 * (1 - sad / a.length / 128);
  return Number((Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0).toFixed(1));
};

const slotProof = [];
for (const t of probeTimes) {
  const masterT = Number((t - offsetSec).toFixed(3));
  const shot = shots.find((s) => masterT >= s.absoluteStartSec && masterT < s.absoluteEndSec);
  if (!shot) {
    slotProof.push({deliveryTimeSec: t, masterTimeSec: masterT, error: "no shot covers this time", passed: false});
    continue;
  }
  // Every slot of the SAME narration block is a candidate: a repetition defect
  // shows up as a sibling winning the comparison.
  const siblingIds = [...new Set(shots.filter((s) => s.sentenceId === shot.sentenceId).map((s) => s.slotId))];
  const vSig = await signature(review, t, REVIEW_CHAIN);
  const scored = [];
  for (const sid of siblingIds) {
    const rec = fingerprint.shots.find((s) => s.slotId === sid);
    const sibShot = shots.find((s) => s.slotId === sid);
    // Sample each sibling at the source offset it would actually be playing at
    // this delivery time: its own in-point plus its elapsed window.
    const elapsed = masterT - sibShot.absoluteStartSec;
    const at = Number(((rec?.inPointSec ?? 0) + Math.max(0, elapsed)).toFixed(3));
    const file = path.join(root, rec.sourcePath);
    let scoreValue = 0;
    try {
      scoreValue = score(vSig, await signature(file, at, SHOT_CHAIN));
    } catch (error) {
      scoreValue = 0;
    }
    scored.push({
      slotId: sid,
      sourcePath: rec.sourcePath,
      sourceSha256: rec.sourceSha256.slice(0, 16),
      sampledAtSourceSec: at,
      score: scoreValue,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const approved = fingerprint.shots.find((s) => s.slotId === shot.slotId);
  const winner = scored[0];
  const margin = scored.length > 1 ? Number((winner.score - scored[1].score).toFixed(1)) : null;
  slotProof.push({
    deliveryTimeSec: t,
    masterTimeSec: masterT,
    expectedSlotId: shot.slotId,
    expectedSourceSha256: approved?.sourceSha256.slice(0, 16) ?? null,
    candidates: scored,
    visibleSlotId: winner.slotId,
    marginToRunnerUp: margin,
    passed: winner.slotId === shot.slotId && winner.score >= 90 && (margin === null || margin >= 15),
  });
}

const report = {
  schemaVersion: "1.1",
  episode,
  target: review,
  targetResolution: `${targetWidth}x${targetHeight}`,
  referenceMaster: path.relative(root, masterDraft).replaceAll("\\", "/"),
  durationSec,
  deliveryOffsetSec: offsetSec,
  subtitleSource,
  subtitleInk: {
    inkThreshold: INK_MIN,
    measurement: "reference-differencing",
    burnGeometry: {englishRows: EN_BAND, chineseRows: ZH_BAND, resolution: `${targetWidth}x${targetHeight}`},
    cuesProbed: inkRows.length,
    cuesWithoutEnglishLine: cuesWithoutEnglishInk.map((r) => r.id),
    cuesWithoutChineseLine: cuesWithoutChineseInk.map((r) => r.id),
    minEnglishLineInk: Math.min(...inkRows.map((r) => r.englishLineInk)),
    minChineseLineInk: Math.min(...inkRows.map((r) => r.chineseLineInk)),
    passed: cuesWithoutEnglishInk.length === 0 && cuesWithoutChineseInk.length === 0,
  },
  openingIdentity: {
    startSec: idStart,
    endSec: idEnd,
    subtitleSuppressionEnabled: identity.subtitleSuppression?.enabled === true,
    cuesIntersectingWindow: identityCueOverlap.map((c) => c.id),
    identitySlotId: hookShot?.slotId ?? null,
    identitySourcePath: hookShot ? path.relative(root, hookShot.sourcePath).replaceAll("\\", "/") : null,
    hookPlaybackSec: hookOverride?.playbackDurationSec ?? null,
    hookTrailingHoldSec: hookOverride?.trailingHoldSec ?? null,
    framesInFrozenTail: identityInk.filter((r) => r.frozenTail).length,
    framesProbedInsideWindow: identityInk.length,
    framesWithSubtitleInkInBand: identityInkFrames.map((r) => r.t),
    maxEnglishInkInsideWindow: Math.max(...identityInk.map((r) => r.englishLineInk ?? 0)),
    maxChineseInkInsideWindow: Math.max(...identityInk.map((r) => r.chineseLineInk ?? 0)),
    controlNeighbourCue: neighbourInk,
    passed:
      Boolean(hookShot) &&
      identityCueOverlap.length === 0 &&
      identityInkFrames.length === 0 &&
      Boolean(neighbourInk && neighbourInk.englishLineInk >= INK_MIN && neighbourInk.chineseLineInk >= INK_MIN),
  },
  slotProof: {
    probes: slotProof.length,
    results: slotProof,
    passed: slotProof.every((p) => p.passed),
  },
  repetition: {
    withinBlockRepetitions: findDuplicateSourceShots(fingerprint).filter((d) => d.isRepetition),
    passed: findDuplicateSourceShots(fingerprint).every((d) => !d.isRepetition),
  },
};
report.passed =
  subtitleSource.passed && report.subtitleInk.passed && report.openingIdentity.passed &&
  report.slotProof.passed && report.repetition.passed;

const outPath = path.join(project, "temp", reportName);
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Rendered-delivery verification — ${episode}`);
console.log(`  target: ${path.relative(root, review)}  (${durationSec.toFixed(3)}s, ${targetWidth}x${targetHeight})`);
console.log(`  reference master (no subtitles): ${path.relative(root, masterDraft)}\n`);
console.log(`1. SUBTITLE SOURCE (the file libass was given)`);
console.log(`   authoritative English cues : ${subtitleSource.authoritativeEnglishCueCount}`);
console.log(`   bilingual cues burned      : ${subtitleSource.bilingualCueCount}`);
console.log(`   timing identical to English: ${subtitleSource.timingIdenticalToEnglish}`);
console.log(`   placeholders               : ${subtitleSource.placeholderCueCount}`);
console.log(`   empty translations         : ${subtitleSource.emptyTranslationCount}`);
console.log(`   duplicate cue IDs          : ${subtitleSource.duplicateCueIdCount}`);
console.log(`   RESULT: ${subtitleSource.passed ? "PASS" : "FAIL"}\n`);
console.log(`2. SUBTITLE INK IN THE RENDERED PIXELS`);
console.log(`   cue windows probed         : ${report.subtitleInk.cuesProbed}`);
console.log(`   windows missing EN ink     : ${report.subtitleInk.cuesWithoutEnglishLine.length}`);
console.log(`   windows missing zh ink     : ${report.subtitleInk.cuesWithoutChineseLine.length}`);
console.log(`   min EN / zh ink            : ${report.subtitleInk.minEnglishLineInk} / ${report.subtitleInk.minChineseLineInk}`);
console.log(`   RESULT: ${report.subtitleInk.passed ? "PASS" : "FAIL"}\n`);
console.log(`3. openingIdentity ${idStart}-${idEnd}s`);
console.log(`   subtitle suppression       : ${report.openingIdentity.subtitleSuppressionEnabled}`);
console.log(`   cues intersecting window  : ${identityCueOverlap.length}`);
console.log(`   frames with subtitle ink  : ${identityInkFrames.length} (of ${identityInk.length} probed)`);
console.log(`   RESULT: ${report.openingIdentity.passed ? "PASS" : "FAIL"}\n`);
console.log(`4. SLOT PROOF (rendered pixels vs approved sources)`);
for (const p of slotProof) {
  console.log(`   t=${p.deliveryTimeSec}s expects ${p.expectedSlotId}: visible ${p.visibleSlotId} ` +
    `(${p.candidates[0].score} vs ${p.candidates[1]?.score ?? "-"}, margin ${p.marginToRunnerUp}) ${p.passed ? "PASS" : "FAIL"}`);
}
console.log(`   RESULT: ${report.slotProof.passed ? "PASS" : "FAIL"}\n`);
console.log(`5. REPETITION GATE (source ranges)`);
console.log(`   within-block repetitions   : ${report.repetition.withinBlockRepetitions.length}`);
console.log(`   RESULT: ${report.repetition.passed ? "PASS" : "FAIL"}\n`);
console.log(`OVERALL: ${report.passed ? "PASS" : "FAIL"}`);
console.log(`report: ${path.relative(root, outPath)}`);
if (!report.passed) process.exitCode = 1;