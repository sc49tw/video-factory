// ---------------------------------------------------------------------------
// Publication-package resolution, import planning, and validation.
//
// The canonical publication layout is NOT invented here: it is the layout
// already documented in brand/ESSY/README.md (Asset Ownership):
//
//   projects/<EPISODE>/publication/
//     thumbnail.png            canonical episode thumbnail
//     youtube.json             canonical publication metadata
//     publication-record.json  provenance record for imported assets
//
// Renderer deliverables stay under output/<EPISODE>/ and production artifacts
// stay under projects/<EPISODE>/. This module never moves production or render
// artifacts, and it never marks an episode published or archived — publication
// and archival remain explicit human actions
// (`video:workflow archive <EP> --published`).
//
// Pure logic lives here so it is unit-testable with temp fixtures; scripts/
// owns argv, console output, and exit codes.
// ---------------------------------------------------------------------------

import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {copyFile, mkdir, readFile, readdir, stat, writeFile} from "node:fs/promises";
import {readDraftState} from "./draft-workflow.mjs";
import {readWorkflow} from "./workflow.mjs";

const DAY_MS = 86_400_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const PUBLICATION_DEFAULTS = Object.freeze({
  metadataFileName: "youtube.json",
  recordFileName: "publication-record.json",
  thumbnailFileName: "thumbnail.png",
  // Image containers the browser download path can produce.
  sourceExtensions: Object.freeze([".png", ".jpg", ".jpeg", ".webp"]),
  // Canonical thumbnail rules. The repo has no destructive
  // crop/resize normalization rule, so an image that misses these is reported
  // FAIL and left untouched rather than silently re-encoded.
  thumbnailMinWidth: 1280,
  thumbnailMinHeight: 720,
  thumbnailAspectRatio: 16 / 9,
  // Relative tolerance: |w/h - 16/9| / (16/9) <= 0.02 accepts real 16:9
  // exports without accepting a visibly different framing.
  thumbnailAspectTolerance: 0.02,
  thumbnailMinBytes: 10_240,
  minDescriptionChars: 100,
  maxTitleChars: 100,
  maxTags: 30,
  // The browser download and the import happen in the same working session, so
  // the default candidate window is deliberately tight: an older image is
  // reported instead of being guessed at. Override with `--within-days <n>` or
  // import an explicit path with `--from <path>`.
  newestCandidateWithinDays: 7,
});

// ---------------------------------------------------------------------------
// Repository root
// ---------------------------------------------------------------------------

async function looksLikeRepoRoot(dir) {
  try {
    await stat(path.join(dir, "package.json"));
  } catch {
    return false;
  }
  for (const required of ["projects", "scripts"]) {
    try {
      const info = await stat(path.join(dir, required));
      if (!info.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Walk up from `startDir` until a directory that is a Video Factory repo is
 * found. Never hard-codes a checkout location.
 * @returns {Promise<string|null>}
 */
export async function resolveRepoRoot(startDir) {
  let current = path.resolve(startDir);
  for (;;) {
    if (await looksLikeRepoRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Repo root for a CLI entry point: start from the script's own directory so the
 * command works from any working directory, then fall back to the cwd.
 */
export async function resolveCliRepoRoot(scriptDir, cwd = process.cwd()) {
  return (await resolveRepoRoot(scriptDir)) ?? (await resolveRepoRoot(cwd));
}

// ---------------------------------------------------------------------------
// Publication paths
// ---------------------------------------------------------------------------

export function resolvePublicationDir(factoryRoot, episode) {
  return path.join(factoryRoot, "projects", episode, "publication");
}

export function resolvePublicationPaths(factoryRoot, episode, rules = {}) {
  const {
    thumbnailFileName = PUBLICATION_DEFAULTS.thumbnailFileName,
    metadataFileName = PUBLICATION_DEFAULTS.metadataFileName,
    recordFileName = PUBLICATION_DEFAULTS.recordFileName,
  } = rules;
  const dir = resolvePublicationDir(factoryRoot, episode);
  return {
    episode,
    dir,
    thumbnail: path.join(dir, thumbnailFileName),
    metadata: path.join(dir, metadataFileName),
    record: path.join(dir, recordFileName),
  };
}

// ---------------------------------------------------------------------------
// Downloads directory
// ---------------------------------------------------------------------------

/**
 * Resolve the user's Downloads directory from the environment. The username is
 * never hard-coded; `USERPROFILE` (Windows) / `HOME` (macOS, Linux) is used.
 * `VIDEO_FACTORY_DOWNLOADS` is an explicit override for tests and for users
 * whose downloads live elsewhere.
 */
export function resolveDownloadsDir({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  const override = String(env.VIDEO_FACTORY_DOWNLOADS ?? "").trim();
  if (override) return path.resolve(override);
  const base = String((platform === "win32" ? env.USERPROFILE : env.HOME) ?? "").trim();
  const root = base || homeDir;
  if (!root) return null;
  return path.join(root, "Downloads");
}

export function isSupportedSourceExtension(fileName, rules = {}) {
  const extensions = rules.sourceExtensions ?? PUBLICATION_DEFAULTS.sourceExtensions;
  const ext = path.extname(String(fileName)).toLowerCase();
  return extensions.includes(ext);
}

async function safeStat(target) {
  try {
    return await stat(target);
  } catch {
    return null;
  }
}

export async function isFile(target) {
  const info = await safeStat(target);
  return info?.isFile() === true;
}

export async function isDirectory(target) {
  const info = await safeStat(target);
  return info?.isDirectory() === true;
}

/**
 * Supported images in `directory`, newest first. Non-image files are never
 * candidates and are never touched.
 */
export async function listImageCandidates(directory, rules = {}) {
  let entries;
  try {
    entries = await readdir(directory, {withFileTypes: true});
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSupportedSourceExtension(entry.name, rules)) continue;
    const absolute = path.join(directory, entry.name);
    const info = await safeStat(absolute);
    if (!info) continue;
    candidates.push({
      path: absolute,
      name: entry.name,
      extension: path.extname(entry.name).toLowerCase(),
      bytes: info.size,
      modifiedMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  // Newest wins; name breaks same-timestamp ties deterministically.
  return candidates.sort(
    (a, b) => b.modifiedMs - a.modifiedMs || a.name.localeCompare(b.name),
  );
}

/**
 * Default selection policy: the newest plausible downloaded image. A candidate
 * older than `withinDays` is refused rather than guessed at.
 */
export function selectNewestCandidate(candidates, options = {}) {
  const {
    withinDays = PUBLICATION_DEFAULTS.newestCandidateWithinDays,
    now = Date.now(),
  } = options;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {selected: null, newest: null, ageDays: null, reason: "no-image"};
  }
  const [newest] = candidates;
  const ageDays = Math.max(0, (now - newest.modifiedMs) / DAY_MS);
  if (withinDays > 0 && ageDays > withinDays) {
    return {selected: null, newest, ageDays, reason: "stale"};
  }
  return {selected: newest, newest, ageDays, reason: null};
}

// ---------------------------------------------------------------------------
// Import planning
// ---------------------------------------------------------------------------

/**
 * Validate an explicit source path and normalize it to the canonical target.
 * Pure filesystem validation — no writes happen here.
 */
export async function planThumbnailImport(options) {
  const {
    factoryRoot,
    episode,
    sourcePath = null,
    candidates = null,
    withinDays = PUBLICATION_DEFAULTS.newestCandidateWithinDays,
    replace = false,
    now = Date.now(),
    rules = {},
  } = options;
  if (!episode) throw new Error("An episode ID is required.");
  if (!factoryRoot) throw new Error("A factory root is required.");

  const paths = resolvePublicationPaths(factoryRoot, episode, rules);
  let selected = null;
  let selection = null;

  if (sourcePath) {
    const absolute = path.resolve(sourcePath);
    if (!isSupportedSourceExtension(absolute, rules)) {
      throw new Error(
        `Unsupported thumbnail source: ${path.basename(absolute)} is not a supported image ` +
          `(${(rules.sourceExtensions ?? PUBLICATION_DEFAULTS.sourceExtensions).join(", ")}).`,
      );
    }
    if (!(await isFile(absolute))) {
      throw new Error(`Thumbnail source does not exist: ${absolute}`);
    }
    const info = await stat(absolute);
    selected = {
      path: absolute,
      name: path.basename(absolute),
      extension: path.extname(absolute).toLowerCase(),
      bytes: info.size,
      modifiedMs: info.mtimeMs,
      modifiedAt: info.mtime.toISOString(),
    };
  } else {
    if (!candidates) {
      throw new Error("No thumbnail source candidates were resolved.");
    }
    selection = selectNewestCandidate(candidates, {withinDays, now});
    if (selection.reason === "no-image") {
      throw new Error(
        `No supported image found in the Downloads folder. ` +
          `Supported: ${(rules.sourceExtensions ?? PUBLICATION_DEFAULTS.sourceExtensions).join(", ")}.`,
      );
    }
    if (selection.reason === "stale") {
      throw new Error(
        `No recent thumbnail download found: the newest candidate ${selection.newest.name} is ` +
          `${selection.ageDays.toFixed(1)} days old (default window ${withinDays} days). ` +
          `Import is waiting for the selected image to be downloaded. Download it again, ` +
          `or pass --from <path> for an explicit file / --within-days <n> to widen the window. ` +
          `Candidates: ${candidates.map((c) => c.name).join(", ")}`,
      );
    }
    selected = selection.selected;
  }

  const existing = await isFile(paths.thumbnail);
  if (existing && !replace) {
    const info = await stat(paths.thumbnail);
    throw new Error(
      `Canonical thumbnail already exists: ${paths.thumbnail} (${info.size} bytes). ` +
        `Refusing to overwrite it. Re-run with --replace to replace it deliberately.`,
    );
  }

  return {
    episode,
    paths,
    source: selected,
    // A PNG source is copied byte-for-byte so approved bytes are preserved;
    // any other container is converted with ffmpeg.
    needsConversion: selected.extension !== ".png",
    replaced: existing,
    ageDays: selection?.ageDays ?? null,
  };
}

// ---------------------------------------------------------------------------
// Image measurement and validation
// ---------------------------------------------------------------------------

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(chunks.join(""))
        : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1500)}`)),
    );
  });
}

/**
 * Read image dimensions/size with the repo's existing image tooling (ffprobe),
 * matching scripts/_verify-review-render.mjs. No image dependency is added.
 * Note: a still image carries no duration, so this reads only stream geometry.
 */
export async function measureImage(filePath) {
  const json = JSON.parse(
    await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,codec_name",
      "-show_entries", "format=format_name,size",
      "-of", "json",
      filePath,
    ]),
  );
  const stream = json.streams?.[0];
  if (!stream) throw new Error(`no image stream: ${filePath}`);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    codec: stream.codec_name ?? null,
    formatName: json.format?.format_name ?? null,
    bytes: Number(json.format?.size ?? 0),
  };
}

export async function readPngSignature(filePath) {
  const handle = await readFile(filePath);
  return handle.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function check(id, label, passed, detail) {
  return {id, label, passed, detail};
}

/**
 * Pure thumbnail rule evaluation over a measurement.
 * Rules: readable image, dimensions, ~16:9 aspect, minimum size, byte size.
 */
export function assessThumbnail(measurement, rules = {}) {
  const r = {...PUBLICATION_DEFAULTS, ...rules};
  const width = Number(measurement?.width);
  const height = Number(measurement?.height);
  const bytes = Number(measurement?.bytes ?? 0);
  const readable = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const aspectRatio = readable ? width / height : null;
  const aspectDrift =
    aspectRatio === null ? null : Math.abs(aspectRatio - r.thumbnailAspectRatio) / r.thumbnailAspectRatio;

  const checks = [
    check(
      "readable",
      "readable image",
      readable,
      readable ? `${width}x${height} (${measurement?.formatName ?? "unknown"})` : "unreadable image stream",
    ),
    check(
      "minimum-resolution",
      `at least ${r.thumbnailMinWidth}x${r.thumbnailMinHeight}`,
      readable && width >= r.thumbnailMinWidth && height >= r.thumbnailMinHeight,
      readable ? `${width}x${height}` : "unknown",
    ),
    check(
      "aspect-ratio",
      `aspect ratio ~16:9 (±${Math.round(r.thumbnailAspectTolerance * 100)}%)`,
      aspectDrift !== null && aspectDrift <= r.thumbnailAspectTolerance,
      aspectRatio === null ? "unknown" : aspectRatio.toFixed(4),
    ),
    check(
      "file-size",
      `file size >= ${r.thumbnailMinBytes} bytes`,
      bytes >= r.thumbnailMinBytes,
      `${bytes} bytes`,
    ),
  ];

  const failed = checks.filter((entry) => !entry.passed);
  return {
    passed: failed.length === 0,
    width: readable ? width : null,
    height: readable ? height : null,
    aspectRatio: aspectRatio === null ? null : Number(aspectRatio.toFixed(4)),
    aspectDrift: aspectDrift === null ? null : Number(aspectDrift.toFixed(5)),
    bytes,
    checks,
    reasons: failed.map((entry) => `${entry.label}: ${entry.detail}`),
  };
}

/**
 * Validate the canonical thumbnail file on disk.
 */
export async function validateThumbnailFile(filePath, rules = {}) {
  if (!(await isFile(filePath))) {
    return {
      passed: false,
      present: false,
      path: filePath,
      checks: [check("present", "file present", false, "missing")],
      reasons: [`missing canonical thumbnail: ${filePath}`],
    };
  }
  if (!(await readPngSignature(filePath))) {
    return {
      passed: false,
      present: true,
      path: filePath,
      checks: [check("readable", "readable PNG", false, "file is not a PNG")],
      reasons: ["file is not a PNG"],
    };
  }
  let measurement;
  try {
    measurement = await measureImage(filePath);
  } catch (error) {
    return {
      passed: false,
      present: true,
      path: filePath,
      checks: [check("readable", "readable image", false, error.message)],
      reasons: [error.message],
    };
  }
  const assessed = assessThumbnail(measurement, rules);
  return {...assessed, present: true, path: filePath, formatName: measurement.formatName};
}

/**
 * Convert a non-PNG download to PNG with the repo's existing image tooling
 * (ffmpeg). No image dependency is added for a one-off format change.
 */
export function convertImageToPng(sourcePath, targetPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-frames:v", "1", targetPath],
      {stdio: ["ignore", "ignore", "pipe"]},
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) =>
      reject(
        new Error(
          `ffmpeg is required to convert ${path.basename(sourcePath)} to PNG: ${error.message}`,
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg exited ${code} converting to PNG: ${stderr.slice(-1000)}`)),
    );
  });
}

async function assessSourceImage(sourcePath) {
  try {
    return assessThumbnail(await measureImage(sourcePath));
  } catch (error) {
    return {
      passed: false,
      width: null,
      height: null,
      aspectRatio: null,
      bytes: null,
      reasons: [error.message],
      checks: [],
    };
  }
}

/**
 * Execute a thumbnail import end to end: plan, measure the download, copy (or
 * convert) it to the canonical path, validate the result, and write the
 * publication record.
 *
 * The download is COPIED, never moved or deleted. An existing canonical
 * thumbnail is never overwritten without `replace`, and a download that fails
 * the thumbnail rules is never silently cropped or resized to force a PASS.
 */
export async function importThumbnailAsset(options) {
  const {factoryRoot, episode, convert = convertImageToPng} = options;
  const plan = await planThumbnailImport(options);
  // Measure the download BEFORE writing anything, so a rejected image can never
  // replace an approved canonical thumbnail.
  const sourceAssessment = await assessSourceImage(plan.source.path);

  await mkdir(plan.paths.dir, {recursive: true});
  if (plan.needsConversion) {
    await convert(plan.source.path, plan.paths.thumbnail);
  } else {
    await copyFile(plan.source.path, plan.paths.thumbnail);
  }

  const thumbnail = await validateThumbnailFile(plan.paths.thumbnail, options.rules ?? {});
  const record = await writePublicationRecord({
    paths: plan.paths,
    episode,
    plan,
    thumbnail,
    sourceAssessment,
  });

  return {plan, thumbnail, sourceAssessment, record, recordPath: plan.paths.record};
}

async function writePublicationRecord({paths, episode, plan, thumbnail, sourceAssessment}) {
  const metadata = await readPublicationMetadata(paths.metadata);
  const importedAt = new Date().toISOString();
  const record = {
    schemaVersion: "1.0",
    episode,
    channel: metadata?.channel ?? null,
    preparedAt: importedAt,
    assets: {
      thumbnail: {
        file: path.basename(paths.thumbnail),
        importedAt,
        source: plan.source.path,
        sourceBytes: plan.source.bytes,
        sourceModifiedAt: plan.source.modifiedAt,
        converted: plan.needsConversion,
        replacedExisting: Boolean(plan.replaced),
        sha256: await sha256File(paths.thumbnail),
        width: thumbnail.width,
        height: thumbnail.height,
        aspectRatio: thumbnail.aspectRatio,
        bytes: thumbnail.bytes,
        sourceValidation: {
          passed: sourceAssessment.passed === true,
          width: sourceAssessment.width ?? null,
          height: sourceAssessment.height ?? null,
          aspectRatio: sourceAssessment.aspectRatio ?? null,
          reasons: sourceAssessment.reasons ?? [],
        },
        validation: {
          passed: thumbnail.passed === true,
          checks: thumbnail.checks ?? [],
          reasons: thumbnail.reasons ?? [],
        },
      },
    },
    metadata: metadata
      ? {
          file: path.basename(paths.metadata),
          title: metadata.title ?? null,
          descriptionChars:
            typeof metadata.description === "string" ? metadata.description.length : 0,
          tagCount: Array.isArray(metadata.tags) ? metadata.tags.length : 0,
        }
      : null,
  };
  await writeFile(paths.record, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

// ---------------------------------------------------------------------------
// Publication metadata
// ---------------------------------------------------------------------------

export async function readPublicationMetadata(metadataPath) {
  try {
    return JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Pure validation of the canonical publication metadata document
 * (projects/<EP>/publication/youtube.json).
 */
export function validatePublicationMetadata(metadata, options = {}) {
  const {
    episode = null,
    rules = {},
    thumbnailFileName = PUBLICATION_DEFAULTS.thumbnailFileName,
  } = options;
  const r = {...PUBLICATION_DEFAULTS, ...rules};
  const checks = [];
  const add = (id, label, passed, detail) => checks.push(check(id, label, passed, detail));

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    add("document", "metadata document", false, "missing or not a JSON object");
    return {
      passed: false,
      checks,
      title: null,
      descriptionChars: 0,
      reasons: ["metadata document missing or malformed"],
    };
  }
  add("document", "metadata document", true, "readable JSON");

  const title = typeof metadata.title === "string" ? metadata.title.trim() : "";
  add(
    "title",
    `title (1-${r.maxTitleChars} chars)`,
    title.length > 0 && title.length <= r.maxTitleChars,
    title ? `${title.length} chars` : "empty",
  );

  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  add(
    "description",
    `description (>= ${r.minDescriptionChars} chars)`,
    description.length >= r.minDescriptionChars,
    description ? `${description.length} chars, ${description.split(/\n{2,}/).length} paragraphs` : "empty",
  );

  add(
    "thumbnail",
    "thumbnail reference",
    typeof metadata.thumbnail === "string" && metadata.thumbnail.trim() === thumbnailFileName,
    String(metadata.thumbnail ?? "(absent)"),
  );

  if (episode) {
    add("episode", "episode id", metadata.episode === episode, String(metadata.episode ?? "(absent)"));
  }

  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const tagStrings = tags.map((tag) => (typeof tag === "string" ? tag.trim() : ""));
  const tagFailures = [];
  if (!Array.isArray(metadata.tags)) tagFailures.push("tags is not an array");
  if (tags.length > r.maxTags) tagFailures.push(`more than ${r.maxTags} tags`);
  if (tagStrings.some((tag) => tag.length === 0)) tagFailures.push("empty tag");
  if (new Set(tagStrings).size !== tagStrings.length) tagFailures.push("duplicate tag");
  add("tags", `tags (0-${r.maxTags}, unique, non-empty)`, tagFailures.length === 0, tagFailures.length ? tagFailures.join("; ") : `${tags.length} tags`);

  add("channel", "channel", typeof metadata.channel === "string" && metadata.channel.trim().length > 0, String(metadata.channel ?? "(absent)"));
  add("platform", "platform", typeof metadata.platform === "string" && metadata.platform.trim().length > 0, String(metadata.platform ?? "(absent)"));
  add("language", "language", typeof metadata.language === "string" && metadata.language.trim().length > 0, String(metadata.language ?? "(absent)"));
  add("visibility", "visibility", typeof metadata.visibility === "string" && metadata.visibility.trim().length > 0, String(metadata.visibility ?? "(absent)"));

  if (metadata.thumbnailText !== undefined) {
    add(
      "thumbnail-text",
      "thumbnail text",
      typeof metadata.thumbnailText === "string" && metadata.thumbnailText.trim().length > 0,
      String(metadata.thumbnailText),
    );
  }
  if (metadata.series !== undefined) {
    add("series", "series", typeof metadata.series === "string" && metadata.series.trim().length > 0, String(metadata.series));
  }

  const failed = checks.filter((entry) => !entry.passed);
  return {
    passed: failed.length === 0,
    checks,
    title: title || null,
    descriptionChars: description.length,
    tagCount: tags.length,
    reasons: failed.map((entry) => `${entry.label}: ${entry.detail}`),
  };
}

/**
 * Renderer-approved episode title (projects/<EP>/final-assembly.json →
 * title.episodeTitle). Used as an advisory cross-check, never invented.
 */
export async function resolveApprovedEpisodeTitle(factoryRoot, episode) {
  try {
    const spec = JSON.parse(
      await readFile(path.join(factoryRoot, "projects", episode, "final-assembly.json"), "utf8"),
    );
    const title = spec?.title?.episodeTitle;
    return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Canonical final master and lifecycle
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical final master from the renderer's own QA record
 * (projects/<EP>/temp/final-assembly/final-assembly-qa.json → output), the same
 * resolver the workflow gates use in src/gates.mjs. The label is never
 * hard-coded: masters are <EP>-final-<label>.mp4 and the label varies.
 */
export async function resolveFinalMaster(factoryRoot, episode) {
  const qaPath = path.join(
    factoryRoot,
    "projects",
    episode,
    "temp",
    "final-assembly",
    "final-assembly-qa.json",
  );
  let qa;
  try {
    qa = JSON.parse(await readFile(qaPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        resolved: false,
        passed: false,
        path: null,
        relative: null,
        reason: `Final assembly has not been rendered (missing projects/${episode}/temp/final-assembly/final-assembly-qa.json).`,
      };
    }
    throw error;
  }
  const relative = typeof qa?.output === "string" && qa.output.trim().length > 0 ? qa.output : null;
  if (!relative) {
    return {
      resolved: false,
      passed: false,
      path: null,
      relative: null,
      reason: "final-assembly-qa.json does not record an output master.",
    };
  }
  const absolute = path.resolve(factoryRoot, relative);
  const present = await isFile(absolute);
  const subtitleQaPassed = qa.subtitleQa == null ? null : qa.subtitleQa.passed === true;
  const reasons = [];
  if (!present) reasons.push(`Final master is missing: ${relative}`);
  if (subtitleQaPassed === false) reasons.push("Final assembly subtitle QA has not passed.");
  return {
    resolved: true,
    passed: reasons.length === 0,
    path: absolute,
    relative,
    present,
    subtitleQaPassed,
    durationSec: Number(qa.durationSec ?? 0) || null,
    reason: reasons.length ? reasons.join("; ") : null,
  };
}

/**
 * Episode lifecycle state, resolved draft-first exactly like the workflow CLI
 * (src/draft-workflow.mjs state.yaml, then projects/<EP>/workflow.json).
 *
 * `completed` and `archived` are distinct states and are reported distinctly:
 * a completed episode with a valid publication package is READY TO PUBLISH,
 * which is not the same as published or archived.
 */
export async function resolveEpisodeLifecycle(factoryRoot, episode) {
  const archivePath = path.join(factoryRoot, "archive", "episodes", episode, "archive.json");
  if (await isFile(archivePath)) {
    return {
      state: "archived",
      archived: true,
      completed: true,
      ready: false,
      source: path.relative(factoryRoot, archivePath).replaceAll(path.sep, "/"),
      recordedStatus: "archived",
      detail: "Archived after publication confirmation.",
    };
  }

  const draft = await readDraftState(factoryRoot, episode);
  if (draft) {
    const completed = draft.status === "completed" && draft.approvals?.finalAssembly?.approved === true;
    return {
      state: completed ? "completed" : "not-ready",
      archived: false,
      completed,
      ready: false,
      source: `projects/_drafts/${episode}/state.yaml`,
      recordedStatus: String(draft.status ?? "unknown"),
      detail: draft.currentStage ? `currentStage ${draft.currentStage}` : null,
    };
  }

  const workflow = await readWorkflow(factoryRoot, episode);
  if (workflow) {
    const archived = workflow.status === "archived" || workflow.currentStage === "archived";
    const completed = workflow.status === "completed";
    return {
      state: archived ? "archived" : completed ? "completed" : "not-ready",
      archived,
      completed,
      ready: false,
      source: `projects/${episode}/workflow.json`,
      recordedStatus: String(workflow.status ?? "unknown"),
      detail: workflow.currentStage ? `currentStage ${workflow.currentStage}` : null,
    };
  }

  return {
    state: "not-ready",
    archived: false,
    completed: false,
    ready: false,
    source: null,
    recordedStatus: null,
    detail: `No draft state or episode workflow found for ${episode}.`,
  };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the publication-check report. Pure so PASS/FAIL composition is
 * unit-testable without the filesystem.
 */
export function buildPublicationCheckReport({episode, metadata, thumbnail, video, lifecycle, approvedTitle}) {
  const rows = [
    {id: "title", label: "Title", passed: titleCheckPassed(metadata), detail: metadataTitleDetail(metadata)},
    {id: "description", label: "Description", passed: metadataDescriptionPassed(metadata), detail: metadataDescriptionDetail(metadata)},
    {id: "thumbnail", label: "Thumbnail", passed: thumbnail.passed === true, detail: thumbnailSummary(thumbnail)},
    {id: "video", label: "Video", passed: video.passed === true, detail: videoSummary(video)},
  ];
  const ready = rows.every((row) => row.passed);
  const notes = [];
  if (metadata.title && approvedTitle && metadata.title !== approvedTitle) {
    notes.push(
      `Publication title differs from the renderer-approved episode title (${approvedTitle}).`,
    );
  }
  if (lifecycle?.state === "completed") {
    notes.push(
      "completed is NOT published: uploading stays a human action, and archival still requires " +
        "`pnpm video:workflow archive <EPISODE> --published`.",
    );
  }
  if (lifecycle?.state === "archived") {
    notes.push("Episode is archived; it was published earlier.");
  }
  return {episode, ready, rows, lifecycle, notes};
}

function findCheck(result, id) {
  return result?.checks?.find((entry) => entry.id === id) ?? null;
}
function titleCheckPassed(metadata) {
  return findCheck(metadata, "title")?.passed === true;
}
function metadataTitleDetail(metadata) {
  return findCheck(metadata, "title")?.detail ?? metadata?.reasons?.[0] ?? "not validated";
}
function metadataDescriptionPassed(metadata) {
  return findCheck(metadata, "description")?.passed === true;
}
function metadataDescriptionDetail(metadata) {
  return findCheck(metadata, "description")?.detail ?? metadata?.reasons?.[0] ?? "not validated";
}
function thumbnailSummary(thumbnail) {
  if (!thumbnail) return "not validated";
  if (thumbnail.present === false) return "missing";
  if (!thumbnail.width) return thumbnail.reasons?.[0] ?? "unreadable";
  return `${thumbnail.width}x${thumbnail.height}, ${thumbnail.aspectRatio}`;
}
function videoSummary(video) {
  if (!video) return "not validated";
  return video.passed === true ? video.relative : video.reason;
}

export {DAY_MS};