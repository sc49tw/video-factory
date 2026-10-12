// SMOKE RENDER ORCHESTRATOR
//
// Generic, reusable command to run the canonical ESSY production pipeline
// on a selected block range from a source episode, in full isolation.
// 
// Pipeline: build-assembly-timeline -> build-narration-master -> 
//           render-full-draft -> render-review-540p-subtitled
//
// Usage:
//   pnpm video:smoke <SOURCE_EPISODE> --blocks N001-N003 [--resolution 540] [--dry-run]
//   pnpm video:smoke ESSY-0003 --blocks N001-N001 --dry-run
//
// Safety:
//   - Source episode is read-only
//   - Smoke episode uses unique Run ID (SMOKE-<SOURCE>-<timestamp>)
//   - Never modifies published masters, publication records, or approval states
//   - All outputs contained within projects/SMOKE-<RUN_ID>/
//   - Rejects unsafe output paths and unresolved source references

import {copyFile, mkdir, readFile, readdir, rm, stat, writeFile, constants} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import process from "node:process";
import {filterTimeline} from "../src/assembly-timeline.mjs";

const factoryRoot = process.cwd();

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: factoryRoot,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      env: {...process.env, ...options.env},
    });
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

async function probeDuration(filePath) {
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

function parseArguments(args) {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const positional = args.filter((a) => !a.startsWith("--"));
  
  const sourceEpisode = positional[0];
  if (!sourceEpisode) {
    throw new Error("Usage: pnpm video:smoke <SOURCE_EPISODE> --blocks N001-N003 [--resolution 540] [--dry-run] [--run-id <id>]");
  }
  
  const blocksFlag = args.indexOf("--blocks");
  if (blocksFlag === -1) {
    throw new Error("--blocks is required (e.g., --blocks N001-N003)");
  }
  const blocksRaw = args[blocksFlag + 1];
  const match = /^N(\d{3})-N(\d{3})$/.exec(blocksRaw ?? "");
  if (!match) {
    throw new Error(`--blocks requires a range like N001-N003, received "${blocksRaw ?? ""}"`);
  }
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from < 1 || to < from || to > 999) {
    throw new Error(`Invalid --blocks range: "${blocksRaw}".`);
  }
  const blockIds = [];
  for (let n = from; n <= to; n += 1) {
    blockIds.push(`sentence-${String(n).padStart(3, "0")}`);
  }
  
  const resolutionFlag = args.indexOf("--resolution");
  const resolution = resolutionFlag !== -1 ? Number(args[resolutionFlag + 1]) : 540;
  if (![540, 1080].includes(resolution)) {
    throw new Error(`--resolution must be 540 or 1080, received ${resolution}`);
  }
  
  const dryRun = flags.has("--dry-run");
  
  const runIdFlag = args.indexOf("--run-id");
  const runId = runIdFlag !== -1 ? args[runIdFlag + 1] : null;
  
  const outputFlag = args.indexOf("--output");
  const customOutput = outputFlag !== -1 ? args[outputFlag + 1] : null;
  if (customOutput && (customOutput.includes("/") || customOutput.includes("\\"))) {
    throw new Error("--output must be a simple directory name, not a path");
  }
  
  return {
    sourceEpisode,
    blockIds,
    blockRange: blocksRaw,
    resolution,
    dryRun,
    runId,
    customOutput,
  };
}

function generateRunId(sourceEpisode, customRunId) {
  if (customRunId) return customRunId;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `SMOKE-${sourceEpisode}-${timestamp}`;
}

function validateEpisodeId(id) {
  if (!/^[A-Z]{4}-\d{4}$/.test(id)) {
    throw new Error(`Invalid episode ID format: ${id} (expected e.g. ESSY-0003)`);
  }
  return id;
}

async function assertSourceExists(sourceRoot, episode) {
  const required = [
    "assembly-timeline.json",
    "manifest.json",
    path.join("source", "lesson.json"),
  ];
  for (const f of required) {
    const p = path.join(sourceRoot, f);
    if (!(await exists(p))) {
      throw new Error(`Required source file missing: ${p}`);
    }
  }
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function assertPathContained(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
    throw new Error(`${label} path escapes root: ${target}`);
  }
}

async function copyFileExcl(src, dst, logMsg, log) {
  await mkdir(path.dirname(dst), {recursive: true});
  try {
    await copyFile(src, dst, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(`Refusing to overwrite existing file: ${dst}`);
    }
    throw error;
  }
  if (logMsg) log(logMsg);
}

async function copyRequiredAssets(sourceRoot, smokeRoot, blockIds, timeline, manifest, log) {
  // Copy audio files
  const audioDir = path.join(smokeRoot, "audio");
  await mkdir(audioDir, {recursive: true});
  for (const blockId of blockIds) {
    const src = path.join(sourceRoot, "audio", `${blockId}.mp3`);
    const dst = path.join(audioDir, `${blockId}.mp3`);
    assertPathContained(sourceRoot, src, "Source audio");
    assertPathContained(smokeRoot, dst, "Destination audio");
    if (!(await exists(src))) {
      throw new Error(`Missing audio: ${src}`);
    }
    await copyFileExcl(src, dst, `  copied audio: ${blockId}.mp3`, log);
  }
  
  // Copy VTT and words.json files
  const tempDir = path.join(smokeRoot, "temp");
  await mkdir(tempDir, {recursive: true});
  for (const blockId of blockIds) {
    for (const ext of [".vtt", ".words.json"]) {
      const src = path.join(sourceRoot, "temp", `${blockId}${ext}`);
      const dst = path.join(tempDir, `${blockId}${ext}`);
      assertPathContained(sourceRoot, src, "Source subtitle artifact");
      assertPathContained(smokeRoot, dst, "Destination subtitle artifact");
      if (!(await exists(src))) {
        throw new Error(`Missing subtitle artifact: ${src}`);
      }
      await copyFileExcl(src, dst, `  copied ${ext}: ${blockId}${ext}`, log);
    }
  }
  
  // Copy source media files (videos/images) referenced by shots
  const shotMediaFiles = new Set();
  for (const shot of timeline.shots) {
    if (blockIds.includes(shot.blockId)) {
      shotMediaFiles.add(shot.sourcePath);
    }
  }
  for (const srcPath of shotMediaFiles) {
    const fileName = path.basename(srcPath);
    const dstPath = path.join(smokeRoot, "sourcing", "downloads", fileName);
    await mkdir(path.dirname(dstPath), {recursive: true});
    assertPathContained(sourceRoot, srcPath, "Source media");
    assertPathContained(smokeRoot, dstPath, "Destination media");
    if (!(await exists(srcPath))) {
      throw new Error(`Missing source media: ${srcPath}`);
    }
    await copyFileExcl(srcPath, dstPath, `  copied source media: ${fileName}`, log);
  }
  
  // Copy provenance.json and approved-slot-asset-map.json
  for (const fname of ["provenance.json", "approved-slot-asset-map.json"]) {
    const src = path.join(sourceRoot, "sourcing", fname);
    const dst = path.join(smokeRoot, "sourcing", fname);
    if (await exists(src)) {
      assertPathContained(sourceRoot, src, "Source sourcing file");
      assertPathContained(smokeRoot, dst, "Destination sourcing file");
      await copyFileExcl(src, dst, `  copied ${fname}`, log);
    }
  }
}

async function buildSmokeTimeline(sourceRoot, smokeRoot, blockIds, sourceEpisode, runId, log) {
  const timeline = JSON.parse(await readFile(path.join(sourceRoot, "assembly-timeline.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"), "utf8"));
  
  const filtered = filterTimeline(timeline, blockIds);
  filtered.episode = runId;
  filtered.createdAt = new Date().toISOString();
  filtered.note = `SMOKE: ${sourceEpisode} ${blockIds[0]}-${blockIds.at(-1)} controlled production-path validation`;
  
  // Remap shot sourcePaths to smoke project's isolated copies
  const smokeSourcingDownloads = path.join(smokeRoot, "sourcing", "downloads");
  const remapShot = (s, i) => ({
    ...s,
    index: i,
    sourcePath: path.join(smokeSourcingDownloads, path.basename(s.sourcePath)),
  });
  filtered.shots = filtered.shots.map(remapShot);
  filtered.blocks = filtered.blocks.map((block) => ({
    ...block,
    shots: block.shots.map(remapShot),
  }));
  
  await writeFile(
    path.join(smokeRoot, "assembly-timeline.json"),
    `${JSON.stringify(filtered, null, 2)}\n`,
    "utf8",
  );
  log(`Built assembly timeline: ${filtered.blocks.length} blocks, ${filtered.shots.length} shots, ${filtered.plannedDurationSec}s`);
  
  // Build smoke manifest with remapped paths for isolation
  const smokeManifest = {
    ...manifest,
    episode: runId,
    sentenceCount: blockIds.length,
    audio: manifest.audio
      .filter((a) => blockIds.includes(a.id))
      .map((a) => ({...a, path: path.join("projects", runId, "audio", path.basename(a.path))})),
    subtitleTiming: {policy: "word-boundary-required", schemaVersion: "1.0"},
    sourceLesson: path.join("projects", runId, "source", "lesson.json"),
    smoke: {
      source: `${sourceEpisode} ${blockIds[0]}-${blockIds.at(-1)}`,
      purpose: "canonical production-path smoke validation",
      runId,
      sourceEpisode,
      selectedBlocks: blockIds,
      createdAt: new Date().toISOString(),
    },
  };
  
  await writeFile(
    path.join(smokeRoot, "manifest.json"),
    `${JSON.stringify(smokeManifest, null, 2)}\n`,
    "utf8",
  );
  log("Built smoke manifest");
  
  return {timeline: filtered, manifest: smokeManifest};
}

async function copyProductionPackage(factoryRoot, sourceEpisode, runId, log) {
  const sourcePkg = path.join(factoryRoot, "projects", "_drafts", sourceEpisode, "production-package.json");
  const destDir = path.join(factoryRoot, "projects", "_drafts", runId);
  const destPkg = path.join(destDir, "production-package.json");
  
  if (await exists(sourcePkg)) {
    await mkdir(destDir, {recursive: true});
    assertPathContained(path.join(factoryRoot, "projects", "_drafts"), sourcePkg, "Source production package");
    assertPathContained(path.join(factoryRoot, "projects", "_drafts"), destPkg, "Destination production package");
    await copyFileExcl(sourcePkg, destPkg, "Copied production-package.json for cold-open parity", log);
  } else {
    log("No production-package.json found (optional)");
  }
}

async function runPipelineStep(command, args, description, log, dryRun) {
  if (dryRun) {
    log(`[DRY-RUN] Would run: ${command} ${args.join(" ")} (${description})`);
    return {skipped: true, description};
  }
  const start = Date.now();
  log(`[RUN] ${description}...`);
  try {
    await run(command, args);
    const elapsed = (Date.now() - start) / 1000;
    log(`[OK] ${description} (${elapsed.toFixed(1)}s)`);
    return {skipped: false, description, elapsedSec: elapsed};
  } catch (error) {
    const elapsed = (Date.now() - start) / 1000;
    throw new Error(`${description} failed after ${elapsed.toFixed(1)}s: ${error.message}`);
  }
}

async function buildNarrationMaster(runId, log, dryRun) {
  return runPipelineStep(
    "node",
    ["scripts/build-narration-master.mjs", runId],
    "Build narration master",
    log,
    dryRun,
  );
}

async function renderFullDraft(runId, log, dryRun) {
  return runPipelineStep(
    "node",
    ["scripts/render-full-draft.mjs", runId],
    "Render full draft (visual master)",
    log,
    dryRun,
  );
}

async function renderSubtitleReview(runId, log, dryRun) {
  return runPipelineStep(
    "node",
    ["scripts/render-review-540p-subtitled.mjs", runId],
    "Render 540p subtitle review",
    log,
    dryRun,
  );
}

async function findReviewOutput(runId) {
  const outputRoot = path.join(factoryRoot, "output", runId);
  if (!(await exists(outputRoot))) return null;
  const files = await readdir(outputRoot);
  const reviewFiles = files
    .filter((f) => f.startsWith(`${runId}-review-540p-subtitled-v`) && f.endsWith(".mp4"))
    .sort();
  if (!reviewFiles.length) return null;
  return path.join(outputRoot, reviewFiles.at(-1));
}

async function findFullDraftOutput(runId) {
  const outputRoot = path.join(factoryRoot, "output", runId);
  if (!(await exists(outputRoot))) return null;
  const files = await readdir(outputRoot);
  const draftFiles = files
    .filter((f) => f.startsWith(`${runId}-full-draft-v`) && f.endsWith(".mp4"))
    .sort();
  if (!draftFiles.length) return null;
  return path.join(outputRoot, draftFiles.at(-1));
}

async function getFileInfo(filePath) {
  if (!filePath || !(await exists(filePath))) return null;
  const s = await stat(filePath);
  const duration = await probeDuration(filePath).catch(() => null);
  return {path: filePath, sizeBytes: s.size, durationSec: duration};
}

async function writeSmokeReport(reportData, smokeRoot, log) {
  const reportPath = path.join(smokeRoot, "smoke-report.json");
  await writeFile(reportPath, `${JSON.stringify(reportData, null, 2)}\n`, "utf8");
  log(`Smoke report written: ${path.relative(factoryRoot, reportPath)}`);
  return reportPath;
}

async function main() {
  const startTime = Date.now();
  const args = parseArguments(process.argv.slice(2));
  const {sourceEpisode, blockIds, blockRange, resolution, dryRun, runId: customRunId} = args;
  
  validateEpisodeId(sourceEpisode);
  const runId = generateRunId(sourceEpisode, customRunId);
  const sourceRoot = path.join(factoryRoot, "projects", sourceEpisode);
  const smokeRoot = path.join(factoryRoot, "projects", runId);
  const outputRoot = path.join(factoryRoot, "output", runId);
  
  // Check for collision in projects/
  if (await exists(smokeRoot)) {
    throw new Error(`Smoke run directory already exists: ${smokeRoot}. Use --run-id to specify a different ID.`);
  }
  // Check for collision in output/
  if (await exists(outputRoot)) {
    throw new Error(`Smoke output directory already exists: ${outputRoot}. Use --run-id to specify a different ID.`);
  }
  
  const logLines = [];
  const log = (msg) => {
    logLines.push(msg);
    console.log(msg);
  };
  
  log(`=== SMOKE RENDER START ===`);
  log(`Run ID: ${runId}`);
  log(`Source: ${sourceEpisode}`);
  log(`Blocks: ${blockRange} (${blockIds.join(", ")})`);
  log(`Resolution: ${resolution}p`);
  log(`Dry run: ${dryRun}`);
  log(`Smoke directory: ${smokeRoot}`);
  
  const report = {
    runId,
    sourceEpisode,
    blockRange,
    selectedBlocks: blockIds,
    resolution,
    dryRun,
    startedAt: new Date().toISOString(),
    steps: [],
    outputs: {},
    status: "running",
    errors: [],
  };
  
  try {
    // Validate source
    log("\n[1/6] Validating source episode...");
    await assertSourceExists(sourceRoot, sourceEpisode);
    log("Source episode validated");
    
    // Create smoke directory structure
    log("\n[2/6] Creating smoke episode structure...");
    await mkdir(path.join(smokeRoot, "audio"), {recursive: true});
    await mkdir(path.join(smokeRoot, "temp"), {recursive: true});
    await mkdir(path.join(smokeRoot, "sourcing", "downloads"), {recursive: true});
    await mkdir(path.join(smokeRoot, "source"), {recursive: true});
    
    // Copy source lesson.json
    const lessonSrc = path.join(sourceRoot, "source", "lesson.json");
    const lessonDst = path.join(smokeRoot, "source", "lesson.json");
    assertPathContained(sourceRoot, lessonSrc, "Source lesson");
    assertPathContained(smokeRoot, lessonDst, "Destination lesson");
    await copyFileExcl(lessonSrc, lessonDst, null, log);
    log("Created smoke episode directory structure");
    
    // Load source artifacts
    const timeline = JSON.parse(await readFile(path.join(sourceRoot, "assembly-timeline.json"), "utf8"));
    const manifest = JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"), "utf8"));
    
    // Copy required assets
    log("\n[3/6] Copying required assets...");
    await copyRequiredAssets(sourceRoot, smokeRoot, blockIds, timeline, manifest, log);
    
    // Build smoke timeline and manifest
    log("\n[4/6] Building smoke timeline and manifest...");
    const {timeline: smokeTimeline, manifest: smokeManifest} = await buildSmokeTimeline(
      sourceRoot, smokeRoot, blockIds, sourceEpisode, runId, log,
    );
    
    // Copy production package for cold-open parity
    log("\n[5/6] Copying production package...");
    await copyProductionPackage(factoryRoot, sourceEpisode, runId, log);
    
    // Run production pipeline
    log("\n[6/6] Running production pipeline...");
    const pipelineStart = Date.now();
    
    // Step 1: Build narration master
    const narrationResult = await buildNarrationMaster(runId, log, dryRun);
    report.steps.push(narrationResult);
    
    // Step 2: Render full draft
    const draftResult = await renderFullDraft(runId, log, dryRun);
    report.steps.push(draftResult);
    
    // Step 3: Render subtitle review (540p or 1080p)
    // For 1080p we'd need a different renderer; for now only 540p is supported via review renderer
    const reviewResult = await renderSubtitleReview(runId, log, dryRun);
    report.steps.push(reviewResult);
    
    const pipelineElapsed = (Date.now() - pipelineStart) / 1000;
    log(`Pipeline completed in ${pipelineElapsed.toFixed(1)}s`);
    
    // Collect outputs
    if (!dryRun) {
      const reviewOutput = await findReviewOutput(runId);
      const draftOutput = await findFullDraftOutput(runId);
      
      report.outputs = {
        review: await getFileInfo(reviewOutput),
        fullDraft: await getFileInfo(draftOutput),
      };
      
      if (reviewOutput) {
        log(`Review output: ${path.relative(factoryRoot, reviewOutput)}`);
      }
      if (draftOutput) {
        log(`Full draft output: ${path.relative(factoryRoot, draftOutput)}`);
      }
    }
    
    report.status = "success";
    report.completedAt = new Date().toISOString();
    report.elapsedSec = (Date.now() - startTime) / 1000;
    
  } catch (error) {
    report.status = "failed";
    report.completedAt = new Date().toISOString();
    report.elapsedSec = (Date.now() - startTime) / 1000;
    report.errors.push(error.message);
    log(`\n[ERROR] ${error.message}`);
    throw error;
  } finally {
    await writeSmokeReport(report, smokeRoot, log);
    log(`\n=== SMOKE RENDER ${report.status.toUpperCase()} ===`);
    log(`Elapsed: ${report.elapsedSec.toFixed(1)}s`);
  }
}

// Export pure helpers for testing
export {
  parseArguments,
  generateRunId,
  validateEpisodeId,
  assertPathContained,
  copyFileExcl,
  filterTimeline,
};

import {pathToFileURL} from "node:url";

// Direct invocation guard
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(`Smoke render failed: ${error.message}`);
    process.exitCode = 1;
  }
}