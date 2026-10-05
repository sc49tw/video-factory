// ---------------------------------------------------------------------------
// Video Factory publication package CLI.
//
//   pnpm video:publication import ESSY-0005 thumbnail
//   pnpm video:publication check  ESSY-0005
//
// The canonical publication directory and metadata document are the ones
// already defined in brand/ESSY/README.md (Asset Ownership):
// projects/<EPISODE>/publication/{thumbnail.png,youtube.json,publication-record.json}
//
// An archived episode is read from its canonical archive
// (archive/episodes/<EPISODE>/project/publication/... + .../output/), so a
// published episode can still be checked. Nothing is ever copied back into
// projects/ or output/.
//
// This CLI is read-only with respect to production state: it never re-renders,
// never edits narration/subtitles/artifacts, never marks an episode published,
// and never archives. Publication and archival stay explicit human actions.
//
// argv + I/O live here; the rules live in src/publication.mjs.
// ---------------------------------------------------------------------------

import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  PUBLICATION_DEFAULTS,
  buildPublicationCheckReport,
  importThumbnailAsset,
  isDirectory,
  listImageCandidates,
  readPublicationMetadata,
  resolveApprovedEpisodeTitle,
  resolveCliRepoRoot,
  resolveDownloadsDir,
  resolveEpisodeLifecycle,
  resolveEpisodeLocation,
  resolveFinalMaster,
  resolvePublicationPaths,
  validatePublicationMetadata,
  validateThumbnailFile,
} from "../src/publication.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const factoryRoot = await resolveCliRepoRoot(SCRIPT_DIR);
if (!factoryRoot) {
  throw new Error(
    "Video Factory repository root not found (no package.json + projects/ + scripts/ above " +
      `${SCRIPT_DIR} or ${process.cwd()}). Run this command from a Video Factory checkout.`,
  );
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "import") await importAsset(parseArgs(args));
  else if (command === "check") await check(args);
  else if (command === undefined || command === "--help" || command === "help") usage();
  else throw new Error(`Unknown publication command "${command}".`);
} catch (error) {
  console.error(`Publication error: ${error.message}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

function parseArgs(values) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    if (value === "--replace" || value === "--list" || value === "--json") {
      flags[value.slice(2)] = true;
      continue;
    }
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Option ${value} requires a value.`);
    }
    flags[value.slice(2)] = next;
    index += 1;
  }
  return {positional, flags};
}

function usage() {
  console.log(`Usage:
  pnpm video:publication import <EPISODE> thumbnail [--from <path>] [--list] [--replace] [--within-days <n>]
  pnpm video:publication check  <EPISODE> [--json]

Publication package layout (brand/ESSY/README.md, Asset Ownership):
  projects/<EPISODE>/publication/thumbnail.png
  projects/<EPISODE>/publication/youtube.json
  projects/<EPISODE>/publication/publication-record.json

An archived episode resolves inside archive/episodes/<EPISODE>/ instead, and is
never moved back.

Publication metadata (title/description) is human-authored in youtube.json; only
the thumbnail is imported from the browser Downloads folder. This CLI never
marks an episode published and never archives it.`);
}

function relative(target) {
  return path.relative(factoryRoot, target).replaceAll(path.sep, "/");
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

async function importAsset({positional, flags}) {
  const [episode, assetType] = positional;
  if (!episode) throw new Error("An episode ID is required: import <EPISODE> thumbnail");
  if (!assetType) throw new Error("An asset type is required: import <EPISODE> thumbnail");
  if (assetType !== "thumbnail") {
    throw new Error(
      `Unsupported asset type "${assetType}". Supported: thumbnail. ` +
        `Publication metadata (title/description) is human-authored in ` +
        `projects/${episode}/publication/${PUBLICATION_DEFAULTS.metadataFileName}; validate it with ` +
        `pnpm video:publication check ${episode}.`,
    );
  }

  // One episode location drives every path below: an archived episode is
  // imported into (and checked in) its canonical archive.
  const location = await resolveEpisodeLocation(factoryRoot, episode);
  const paths = resolvePublicationPaths(factoryRoot, episode, {}, location);
  const replace = flags.replace === true;
  const withinDays = flags["within-days"]
    ? Number(flags["within-days"])
    : PUBLICATION_DEFAULTS.newestCandidateWithinDays;
  if (!Number.isFinite(withinDays)) {
    throw new Error(`--within-days requires a number, got "${flags["within-days"]}".`);
  }

  const downloadsDir = resolveDownloadsDir();
  const downloadsAvailable = await isDirectory(downloadsDir);
  const candidates = downloadsAvailable ? await listImageCandidates(downloadsDir) : [];

  if (flags.list) {
    printCandidateList({downloadsDir, downloadsAvailable, candidates, paths, replace});
    return;
  }

  if (!flags.from && !downloadsAvailable) {
    throw new Error(
      `Downloads folder not found: ${downloadsDir ?? "(unresolved)"}. ` +
        `Download the selected thumbnail in the browser and retry, or pass --from <path>.`,
    );
  }

  // planThumbnailImport refuses unsupported files, a missing source, a stale
  // candidate set, and an existing canonical thumbnail without --replace.
  // importThumbnailAsset then copies (never moves) the download, normalizes it
  // to PNG, validates the result, and writes the publication record.
  const result = await importThumbnailAsset({
    factoryRoot,
    episode,
    sourcePath: flags.from ?? null,
    candidates,
    withinDays,
    replace,
    location,
  });

  printImportReport({episode, ...result, paths});

  if (!result.thumbnail.passed) {
    console.error(
      `\n  Validation FAILED: ${result.thumbnail.reasons.join("; ")}\n` +
        `  The canonical thumbnail was written but is not publishable. Replace it with a ` +
        `compliant image: pnpm video:publication import ${episode} thumbnail --replace`,
    );
    process.exitCode = 1;
  }
}

function printCandidateList({downloadsDir, downloadsAvailable, candidates, paths, replace}) {
  console.log(`\nDownloads: ${downloadsDir ?? "(unresolved)"}`);
  if (!downloadsAvailable) {
    console.log("  (folder does not exist — create it or pass --from <path>)");
  } else if (candidates.length === 0) {
    console.log("  (no supported image files found)");
  } else {
    for (const candidate of candidates) {
      console.log(
        `  ${candidate.modifiedAt}  ${String(candidate.bytes).padStart(9)} bytes  ${candidate.name}`,
      );
    }
  }
  console.log(`\nTarget: ${path.relative(factoryRoot, paths.thumbnail)}${replace ? "   (--replace)" : ""}`);
  console.log("");
}

function printImportReport({episode, plan, thumbnail, sourceAssessment, recordPath, paths}) {
  const approx169 =
    thumbnail.aspectDrift !== null &&
    thumbnail.aspectDrift !== undefined &&
    thumbnail.aspectDrift <= PUBLICATION_DEFAULTS.thumbnailAspectTolerance;
  const aspect = approx169 ? "16:9" : thumbnail.width ? `${thumbnail.width}:${thumbnail.height}` : "unknown";

  console.log(`\n  Publication asset imported\n`);
  console.log(`  Episode:     ${episode}`);
  console.log(`  Type:        thumbnail`);
  console.log(`  Source:      ${plan.source.path}`);
  console.log(`  Target:      ${path.relative(factoryRoot, paths.thumbnail)}`);
  console.log("");
  console.log(`  Resolution:  ${thumbnail.width ?? "?"}x${thumbnail.height ?? "?"}`);
  console.log(`  Aspect:      ${aspect}`);
  console.log(`  Size:        ${thumbnail.bytes ?? "?"} bytes`);
  console.log(`  Converted:   ${plan.needsConversion ? "yes (ffmpeg)" : "no (copied byte-for-byte)"}`);
  console.log(`  Record:      ${relative(recordPath)}`);
  console.log(`  Status:      ${thumbnail.passed ? "PASS" : "FAIL"}`);
  if (plan.replaced) {
    console.log("");
    console.log("  Note:        an existing canonical thumbnail was replaced (--replace).");
  }
  if (!sourceAssessment.passed) {
    console.log("");
    console.log(`  Source check FAILED: ${(sourceAssessment.reasons ?? []).join("; ")}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function check(values) {
  const {positional, flags} = parseArgs(values);
  const [episode] = positional;
  if (!episode) throw new Error("An episode ID is required: check <EPISODE>");

  const location = await resolveEpisodeLocation(factoryRoot, episode);
  const paths = resolvePublicationPaths(factoryRoot, episode, {}, location);
  const metadataDocument = await readPublicationMetadata(paths.metadata);
  const metadataValidation = validatePublicationMetadata(metadataDocument, {episode});
  const thumbnail = await validateThumbnailFile(paths.thumbnail);
  const video = await resolveFinalMaster(factoryRoot, episode, {location});
  const lifecycle = await resolveEpisodeLifecycle(factoryRoot, episode);
  const approvedTitle = await resolveApprovedEpisodeTitle(factoryRoot, episode, {location});

  const report = buildPublicationCheckReport({
    episode,
    metadata: metadataValidation,
    thumbnail,
    video,
    lifecycle,
    approvedTitle,
  });

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          episode,
          ready: report.ready,
          rows: report.rows,
          lifecycle: {
            state: lifecycle.state,
            completed: lifecycle.completed,
            archived: lifecycle.archived,
            recordedStatus: lifecycle.recordedStatus,
            source: lifecycle.source,
            detail: lifecycle.detail,
          },
          metadata: {
            file: relative(paths.metadata),
            present: metadataDocument !== null,
            passed: metadataValidation.passed,
            reasons: metadataValidation.reasons,
          },
          thumbnail: {file: relative(paths.thumbnail), ...thumbnail},
          video,
          notes: report.notes,
        },
        null,
        2,
      ),
    );
  } else {
    printCheckReport(report, {
      paths,
      lifecycle,
      metadata: metadataDocument,
      metadataValidation,
      thumbnail,
      video,
    });
  }

  if (!report.ready) process.exitCode = 1;
}

function printCheckReport(report, {paths, lifecycle, metadata, metadataValidation, thumbnail, video}) {
  console.log(`\n${report.episode} Publication`);
  console.log("-".repeat(32));
  for (const row of report.rows) {
    const status = row.passed ? "PASS" : "FAIL";
    console.log(`${row.label.padEnd(12)} ${status}${row.passed ? "" : `  (${row.detail})`}`);
  }
  console.log("-".repeat(32));
  console.log(report.ready ? "READY TO PUBLISH" : "NOT READY");
  console.log(`\nWorkflow:   ${lifecycle.state}${lifecycle.recordedStatus ? ` (recorded: ${lifecycle.recordedStatus})` : ""}`);
  if (lifecycle.source) console.log(`State:      ${lifecycle.source}`);

  const details = [
    ["Title", metadata?.title ?? null],
    ["Description", metadata?.description ? `${metadata.description.length} chars` : null],
    [
      "Thumbnail",
      thumbnail.width
        ? `${relative(paths.thumbnail)} ${thumbnail.width}x${thumbnail.height} (${thumbnail.bytes} bytes)`
        : null,
    ],
    ["Video", video.passed ? relative(video.path) : null],
  ];
  console.log("\nPackage:");
  for (const [label, value] of details) {
    console.log(`  ${`${label}:`.padEnd(13)} ${value ?? "(absent)"}`);
  }

  for (const reason of report.rows.filter((row) => !row.passed)) {
    console.log(`\nFAIL ${reason.label}: ${reason.detail}`);
  }
  if (!metadataValidation.passed) {
    for (const reason of metadataValidation.reasons) console.log(`FAIL Metadata: ${reason}`);
  }
  for (const reason of thumbnail.reasons ?? []) {
    console.log(`FAIL Thumbnail: ${reason}`);
  }
  // The row detail above already carries the resolved reason for these two.
  if (video.reason && report.rows.find((row) => row.id === "video")?.detail !== video.reason) {
    console.log(`FAIL Video: ${video.reason}`);
  }
  for (const note of report.notes) console.log(`\nNote: ${note}`);
  console.log("");
}