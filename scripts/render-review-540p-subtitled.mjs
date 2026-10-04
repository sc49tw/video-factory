// LOW-RES SUBTITLED EDITORIAL REVIEW RENDER (episode-agnostic).
//
// Purpose: lightweight (960x540, H.264 fast preset) review proxy of the current
// full draft with subtitles BURNED IN. NOT a master render; does not re-do
// sourcing/selection/narration/TTS/provenance/shot planning.
//
// Pipeline (shared, see scripts/subtitle-config.mjs + _build-subtitle-timeline.mjs):
//   edge-tts VTT -> parse source timing -> DP balanced segmentation ->
//   phrase-aware breakpoints -> orphan prevention -> monotonic child timing ->
//   global non-overlap normalization -> subtitle QA gate -> SRT -> burn-in.
//
// The subtitle QA gate is MANDATORY: if QA fails, the renderer aborts before
// ffmpeg is ever invoked. A failed subtitle timeline can never silently burn.
//
// Usage: pnpm video:subtitle-review <EPISODE>   e.g. ESSY-0003
//
// Automatically locates:
//   - assembly timeline:  projects/<EPISODE>/assembly-timeline.json
//   - narration VTTs:     projects/<EPISODE>/temp/<sentenceId>.vtt
//   - master draft:       output/<EPISODE>/<EPISODE>-full-draft*.mp4 (highest version)
//   - output dir:         output/<EPISODE>/
// and writes a new, version-bumped <EPISODE>-review-540p-subtitled-v<N>.mp4.
import {spawn} from "node:child_process";
import {copyFile, mkdir, readFile, readdir, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {buildSubtitleTimeline} from "./_build-subtitle-timeline.mjs";
import {
  buildColdOpenTitleCardFilter,
  buildEndingCardFilter,
  buildPreRollClipArgs,
  preRollOffsetSec,
  resolveEndingCardSpec,
  resolveEpisodePreRollTitleCard,
} from "./essay-identity-config.mjs";
import {buildAssForceStyle, assForceStyle} from "./subtitle-config.mjs";
import {renderOpeningReview} from './render-opening-review.mjs';
import {assertMasterDraftFresh} from "../src/master-draft-freshness.mjs";
import {buildBilingualSrt} from "./_build-bilingual-subtitles.mjs";

const OUT_W = 960;
const OUT_H = 540;
const FPS = 30;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({stdout, stderr})
        : reject(new Error(`${command} exited ${code}: ${stderr.slice(-12000)}`)),
    );
  });
}

async function locateMasterDraft(outputRoot, episode) {
  const candidates = (await readdir(outputRoot))
    .filter((f) => f.startsWith(`${episode}-full-draft`) && f.endsWith(".mp4"))
    .sort();
  if (!candidates.length) {
    throw new Error(
      `No master draft found in ${outputRoot} (${episode}-full-draft*.mp4). ` +
        "Run the full-draft render first — subtitles burn onto the existing visual timeline.",
    );
  }
  return path.join(outputRoot, candidates.at(-1));
}

// The review render re-scales and burns onto the full-draft master; it never
// re-renders shots. The master is therefore a cache whose declared inputs are
// the assembly timeline and the shot source files, and it MUST be proven fresh
// against them. Without this check an approved asset swap (asset map -> new
// download -> rebuilt timeline) is silently dropped and the review ships the
// previous picture — the exact failure behind the "the replacement never
// appeared" defect.
//
// Freshness is content-based (sha256 of the timeline and every shot source), not
// mtime-based, so it cannot be fooled by touching files or by editing content.
//
// By default a stale master is REBUILT here, so an approved asset change
// necessarily propagates to the rendered review. Set ESSY_SKIP_DRAFT_REBUILD=1
// to convert the stale state into a hard failure instead (useful in CI).
async function resolveFreshMasterDraft({root, outputRoot, episode, log}) {
  const master = await locateMasterDraft(outputRoot, episode);
  const verdict = await assertMasterDraftFresh({root, episode, masterPath: master});

  if (verdict.fresh) {
    log?.(`Master draft is fresh: ${path.basename(master)} (fingerprint ${verdict.currentFingerprintSha256.slice(0, 12)}…)`);
    return master;
  }

  const remediation =
    `node scripts/render-full-draft.mjs ${episode}   # then: pnpm video:subtitle-review ${episode}`;

  if (process.env.ESSY_SKIP_DRAFT_REBUILD === "1") {
    throw new Error(
      `STALE MASTER DRAFT — review render aborted.\n  ${verdict.reason}\n` +
        `  Affected slot(s): ${verdict.changedSlots.join(", ") || "none"}\n` +
        `  Remediation: ${remediation}`,
    );
  }

  log?.(`STALE MASTER DRAFT detected — rebuilding so the approved asset change propagates.`);
  log?.(`  ${verdict.reason}`);
  log?.(`  Affected slot(s): ${verdict.changedSlots.join(", ") || "none"}`);
  const {renderFullDraft} = await import("./render-full-draft.mjs");
  await renderFullDraft({root, episode, log});

  const rebuilt = await locateMasterDraft(outputRoot, episode);
  const reverify = await assertMasterDraftFresh({root, episode, masterPath: rebuilt});
  if (!reverify.fresh) {
    throw new Error(
      `Master draft rebuild did not resolve the staleness.\n  ${reverify.reason}\n` +
        `  Remediation: ${remediation}`,
    );
  }
  log?.(`Master draft rebuilt and verified: ${path.basename(rebuilt)} (fingerprint ${reverify.currentFingerprintSha256.slice(0, 12)}…)`);
  return rebuilt;
}

async function nextOutputPath(outputRoot, episode) {
  const existing = (await readdir(outputRoot))
    .map((f) => f.match(new RegExp(`^${episode}-review-540p-subtitled-v(\\d+)\\.mp4$`)))
    .filter(Boolean)
    .map((m) => +m[1]);
  const version = (existing.length ? Math.max(...existing) : 0) + 1;
  return path.join(outputRoot, `${episode}-review-540p-subtitled-v${version}.mp4`);
}

// ---- Cold-open title cards (metadata-driven, from production-package) ----
// The channel name and episode title are TITLE CARDS drawn by this layer —
// they must never behave like ordinary narration subtitle cues. Each card is
// a centered drawtext with the shared fade language (alpha expression).

// 540p title sizes = half of the 1080 design (channel 72 -> 36, episode 48 -> 24).
// Readability: subtle stroke + soft shadow keep white text legible over bright
// footage while preserving the calm ESSY visual language (never a banner).
function buildTitleCardFilter(card, fontPath) {
  return buildColdOpenTitleCardFilter({
    card,
    fontPath,
    fontSize: card.kind === "channel" ? 36 : 24,
  });
}

// Cold-open EXPERIMENT title cards: explicit per-episode editorial decisions
// (packaging.coldOpenExperiment.titleCards — e.g. ESSY-0003). When an episode
// declares none, it uses the normal standalone PRE-ROLL contract instead (see
// resolveEpisodePreRollTitleCard below); the two mechanisms never mix.
async function readColdOpenExperimentCards(root, episode) {
  try {
    const pkgPath = path.join(root, "projects", "_drafts", episode, "production-package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const explicit = pkg?.packaging?.coldOpenExperiment?.titleCards;
    return Array.isArray(explicit) ? explicit : [];
  } catch {
    return [];
  }
}

// ---- Title-block narration suppression (metadata-driven) ----
// For a cold-open title experiment the channel name / episode title must NOT
// be spoken as ordinary narration underneath the visual title cards. The
// production-package flag `suppressBlockNarration` + the titleCards' blockId
// select WHICH narration blocks are muted; the block's absolute window comes
// from the episode's own assembly-timeline.json (never a hard-coded timestamp).
// Muting (volume=0) preserves the block timing, so title-card and essay timing
// are unchanged.
async function readNarrationSuppressWindows(root, episode) {
  try {
    const pkgPath = path.join(root, "projects", "_drafts", episode, "production-package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    const coldOpen = pkg?.packaging?.coldOpenExperiment;
    if (!coldOpen?.suppressBlockNarration) return [];
    const blockIds = new Set(
      (coldOpen.titleCards ?? []).map((c) => c?.blockId).filter(Boolean),
    );
    if (!blockIds.size) return [];
    const sentenceIds = new Set(
      [...blockIds].map((id) => `sentence-${String(id).replace(/^n/i, "")}`),
    );
    const timelinePath = path.join(root, "projects", episode, "assembly-timeline.json");
    const timeline = JSON.parse(await readFile(timelinePath, "utf8"));
    return (timeline.blocks ?? [])
      .filter((b) => sentenceIds.has(b.sentenceId))
      .map((b) => ({sentenceId: b.sentenceId, startSec: b.startSec ?? 0, endSec: b.endSec ?? 0}))
      .filter((w) => w.endSec > w.startSec);
  } catch {
    return [];
  }
}

async function stageFont(tempRoot) {
  const fontDir = path.join(tempRoot, "fonts");
  await mkdir(fontDir, {recursive: true});
  const fontPath = path.join(fontDir, "arial.ttf");
  // Relative (colon-free) path for the ffmpeg filtergraph.
  await copyFile(
    path.join(process.env.WINDIR || "C:/Windows", "Fonts", "arial.ttf"),
    fontPath,
  );
  return path.relative(process.cwd(), fontPath).replaceAll("\\", "/");
}

// ---- Ending hold / end card (shared ESSY final-assembly parity) ----
// The review render must be structurally identical to the intended final
// video: it appends the canonical ending hold (frozen subtitle-free last
// frame + centered series-title card with the shared fade timing) from
// essay-identity-config.mjs. Hold duration/text come from the episode's
// final-assembly.json when it exists, otherwise from the canonical ESSY
// defaults — the same source the 1080p final renderer consumes.
async function readEndingSpec(root, episode) {
  let finalAssembly = null;
  try {
    finalAssembly = JSON.parse(
      await readFile(path.join(root, "projects", episode, "final-assembly.json"), "utf8"),
    );
  } catch {
    // No frozen final-assembly decisions yet — canonical defaults apply.
  }
  return {...resolveEndingCardSpec({finalAssembly}), source: finalAssembly ? "final-assembly.json" : "canonical default"};
}

async function probeDurationSec(filePath) {
  const {stdout} = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine media duration: ${filePath}`);
  }
  return duration;
}

const main = async () => {
  const episode = process.argv[2];
  if (!episode) {
    console.error("Usage: pnpm video:subtitle-review <EPISODE>  (e.g. ESSY-0003)");
    process.exit(1);
  }
  const root = process.cwd();
  const outputRoot = path.join(root, "output", episode);
  await mkdir(outputRoot, {recursive: true});

let pkg = null;
  try { pkg = JSON.parse(await readFile(path.join(root, 'projects', '_drafts', episode, 'production-package.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  // ---- Dependency freshness: prove the master draft still reflects the
  // approved asset map / assembly timeline / shot sources before burning onto
  // it. A stale master is rebuilt here (or fails hard with
  // ESSY_SKIP_DRAFT_REBUILD=1) so an approved asset change necessarily reaches
  // the rendered review.
  const masterDraft = await resolveFreshMasterDraft({root, outputRoot, episode});

  if (pkg?.openingIdentity) {
    await renderOpeningReview({root, episode, identity:pkg.openingIdentity,
      input:masterDraft, output:await nextOutputPath(outputRoot,episode),
      fontPath:await stageFont(path.join(root,'projects',episode,'temp')), ending:await readEndingSpec(root,episode), run});
    return;
  }

  // ---- Build one episode-wide, globally valid SRT (validated, QA report) ----
  const {resolveSubtitleConfig} = await import("./subtitle-config.mjs");
  const subtitleConfig = resolveSubtitleConfig(episode === "ESSY-0005" ? {MIN_GENERATED_DURATION_MS: 450} : {});
  const {cues: allCues, srtPath, qaPath, report} = await buildSubtitleTimeline({root, episode, config: subtitleConfig});

  // ---- ESSY-0005 bilingual subtitle burn-in ----
  // GENERATED from the authoritative English SRT and gated for completeness; a
  // missing/placeholder translation aborts before ffmpeg instead of burning.
  let finalSrtPath = srtPath;
  if (episode === "ESSY-0005") {
    subtitleConfig.STYLE.FONT_SIZE = BILINGUAL_STYLE.FONT_SIZE;
    subtitleConfig.STYLE.MARGIN_V = BILINGUAL_STYLE.MARGIN_V;
    subtitleConfig.MAX_CHARS = BILINGUAL_STYLE.MAX_CHARS;
    const bilingual = await buildBilingualSrt({root, episode, englishSrtPath: srtPath});
    finalSrtPath = bilingual.srtPath;
  }

  // ---- MANDATORY subtitle QA gate: abort BEFORE ffmpeg on any failure ----
  if (!report.passed) {
    console.error(`Subtitle QA FAILED for ${episode}:`);
    console.error(JSON.stringify({
      overlapCountAfterNormalization: report.overlapCountAfterNormalization,
      invalidDurationCueCount: report.invalidDurationCueCount,
      maxRenderedLines: report.maxRenderedLines,
      orphanChildCueCount: report.orphanChildCueCount,
      twoWordChildCueCount: report.twoWordChildCueCount,
      generatedCueDurationBelow700msCount: report.generatedCueDurationBelow700msCount,
      offenders: {
        orphanOffenders: report.orphanOffenders,
        twoWordOffenders: report.twoWordOffenders,
        generatedCueDurationBelow700msOffenders: report.generatedCueDurationBelow700msOffenders,
      },
    }, null, 2));
    console.error(`QA report: ${path.relative(root, qaPath)}`);
    console.error("Renderer aborted — no video was produced.");
    process.exit(1);
  }

  // ---- Preserve audio master / visual timeline: just re-scale + burn ----
  const input = masterDraft;
  const output = await nextOutputPath(outputRoot, episode);
// Use a relative (cwd-based) path for the subtitles filter: a Windows drive
  // letter colon would otherwise be parsed as a filter option separator.
  const srtEsc = path.relative(root, finalSrtPath).replace(/\\/g, "/");
  // Shared libass style resolver — the 1080p final master burns the same SRT
  // through the same expression, so the two paths cannot drift apart.
  const forceStyle = assForceStyle(subtitleConfig.STYLE);
  const filter = `scale=${OUT_W}:${OUT_H}:flags=lanczos,fps=${FPS},subtitles=${srtEsc}:force_style='${forceStyle}'`;

  // ---- Cold-open EXPERIMENT title cards (editorial opt-in, e.g. ESSY-0003) ----
  const titleCards = await readColdOpenExperimentCards(root, episode);
  // ---- Standalone PRE-ROLL episode-title segment (shared ESSY contract) ----
  // The pre-roll is a SEPARATE segment BEFORE the main program: not an overlay,
  // no main-timeline timestamps, no narration, no title TTS, no subtitle cue.
  // Resolution is shared with the 1080p final renderer, so review and final can
  // never disagree about the presence/text/duration of the episode title.
  const preRollTitle = await resolveEpisodePreRollTitleCard({root, episode});
  const preRollSec = preRollOffsetSec(preRollTitle);
  // ---- Ending hold + end card (shared ESSY final-assembly parity) ----
  const ending = await readEndingSpec(root, episode);
  const titleFilters = [];
  let fontPath = null;
  if (titleCards.length || ending.endingHoldSec > 0 || preRollTitle) {
    fontPath = await stageFont(path.join(root, "projects", episode, "temp"));
  }
  for (const card of titleCards) {
    titleFilters.push(buildTitleCardFilter(card, fontPath));
  }

  // Ending hold: extend the video with the frozen subtitle-free last frame
  // (tpad clone) and fade in the shared end card. The hold starts at the
  // master's base duration on the episode timeline, so the shared fade
  // expression is offset by baseSec — same timing contract as the 1080p final.
  const baseDur = Math.round((await probeDurationSec(input)) * 1000) / 1000;
  const holdSec = ending.endingHoldSec;
  const totalDur = Math.round((baseDur + holdSec) * 1000) / 1000;
  // DELIVERY bookkeeping: the main program keeps its OWN t=0 (N001 narration,
  // first approved shot, first subtitle cue); only the delivered file is
  // offset by the pre-roll duration.
  const mainDur = totalDur;
  const deliveryDur = Math.round((totalDur + preRollSec) * 1000) / 1000;
  const postFilters = [];
  if (holdSec > 0) {
    postFilters.push(`tpad=stop_mode=clone:stop_duration=${holdSec.toFixed(3)}`);
    const textPath = path.join(root, "projects", episode, "temp", "ending-card-text.txt");
    await writeFile(textPath, ending.text, "utf8");
    postFilters.push(
      buildEndingCardFilter({
        fontPath,
        textFile: path.relative(root, textPath).replaceAll("\\", "/"),
        fontSize: 32, // canonical 64 @ 1080p, halved for the 540p proxy
        baseSec: baseDur,
      }),
    );
  }
  const videoFilter = [filter, ...titleFilters, ...postFilters].join(",");

  // ---- Suppress title-block narration (metadata-driven, timing preserved) ----
  const suppressWindows = await readNarrationSuppressWindows(root, episode);
  const audioFilters = [];
  if (suppressWindows.length) {
    const enable = suppressWindows
      .map((w) => `between(t,${w.startSec.toFixed(3)},${w.endSec.toFixed(3)})`)
      .join("+");
    audioFilters.push(`volume=0:enable='${enable}'`);
  }
  // The ending hold has no narration (canonical: silent hold); pad the audio
  // so video and audio durations stay internally consistent. `apad` without
  // a finite pad duration intentionally supplies silence until `atrim` fixes
  // the output to the visual authority; `whole_dur` can otherwise preserve a
  // short source-stream timestamp gap in a review proxy.
  if (holdSec > 0) {
    audioFilters.push(`apad,atrim=duration=${totalDur.toFixed(3)}`);
  }
  const audioArgs = audioFilters.length ? ["-c:a", "aac", "-b:a", "192k"] : ["-c:a", "copy"];
  const audioFilter = audioFilters.length ? audioFilters.join(",") : null;

  // The main program is rendered EXACTLY as before (offset by nothing): the
  // pre-roll is prepended afterwards, so no main-program timestamp changes.
  const mainProgramPath = preRollTitle
    ? path.join(root, "projects", episode, "temp", "review-main-program.mp4")
    : output;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", input,
    "-vf", videoFilter,
    ...(audioFilter ? ["-af", audioFilter] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    ...audioArgs,
    "-movflags", "+faststart",
    mainProgramPath,
  ]);

  // ---- DELIVERY composition: prepend the standalone pre-roll title card ----
  // delivery t=0 -> pre-roll title; delivery t=PRE_ROLL_DURATION -> main
  // timeline t=0. The segment carries a matching SILENT audio track so the
  // concat demuxer keeps the main program's narration intact.
  if (preRollTitle) {
    const preRollClipPath = path.join(root, "projects", episode, "temp", "review-pre-roll-title.mp4");
    await run("ffmpeg", buildPreRollClipArgs({
      fontPath,
      titleCard: preRollTitle,
      width: OUT_W,
      height: OUT_H,
      fps: FPS,
      crf: 23,
      silentAudio: true,
      outputPath: preRollClipPath,
    }));
    const concatListPath = path.join(root, "projects", episode, "temp", "review-concat.txt");
    const concatEntry = (file) =>
      // Concat demuxer resolves relative entries against the LIST FILE's own
      // directory (the episode temp dir), not the factory root.
      `file '${path.relative(path.dirname(concatListPath), file).replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    await writeFile(
      concatListPath,
      `${[preRollClipPath, mainProgramPath].map(concatEntry).join("\n")}\n`,
      "utf8",
    );
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", concatListPath,
      "-c", "copy", "-movflags", "+faststart",
      output,
    ]);
  }

  console.log(
    `Review render done: ${path.relative(root, output)}\n` +
      `  master: ${path.relative(root, input)}\n` +
      `  cues burned: ${allCues.length} (from per-block VTTs)\n` +
      `  title cards drawn: ${titleFilters.length}` +
      (titleFilters.length ? ` (${titleCards.map((c) => c.kind).join(", ")})` : " (none)") +
      `\n  narration suppressed: ${suppressWindows.length}` +
      (suppressWindows.length
        ? ` (${suppressWindows.map((w) => `${w.sentenceId} ${w.startSec.toFixed(3)}-${w.endSec.toFixed(3)}s`).join(", ")})`
        : "") +
      `\n  ending hold: ${holdSec.toFixed(3)}s after ${baseDur.toFixed(3)}s` +
      ` (end card "${ending.text}", source: ${ending.source})` +
      `\n  pre-roll title: ${preRollTitle
        ? `"${preRollTitle.text}" ${preRollSec.toFixed(3)}s (standalone segment, no narration, no subtitles)`
        : "none (no WRITE-approved visual-only episode title)"}` +
      `\n  main program: ${mainDur.toFixed(3)}s from main t=0 (N001 subtitle cues unchanged; ` +
      `equivalent delivery window ${preRollSec.toFixed(3)}-${deliveryDur.toFixed(3)}s)` +
      `\n  expected delivery duration: ${deliveryDur.toFixed(3)}s` +
      `\n  srt: ${path.relative(root, srtPath)}\n` +
      `  qa: ${path.relative(root, qaPath)}\n` +
      `  overlaps before/after normalization: ` +
      `${report.overlapCountBeforeNormalization}/${report.overlapCountAfterNormalization}`,
  );
};

await main();
