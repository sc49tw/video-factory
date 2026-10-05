// Publication-package rules. Temp fixtures only — the real Downloads folder is
// never read, and no repository artifact is written or modified.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {deflateSync} from "node:zlib";
import {
  PUBLICATION_DEFAULTS,
  assessThumbnail,
  buildPublicationCheckReport,
  importThumbnailAsset,
  isSupportedSourceExtension,
  isDirectory,
  isFile,
  listImageCandidates,
  measureImage,
  planThumbnailImport,
  readPublicationMetadata,
  resolveDownloadsDir,
  resolveApprovedEpisodeTitle,
  resolveEpisodeLifecycle,
  resolveEpisodeLocation,
  resolveEpisodeRelativePath,
  resolveFinalMaster,
  resolvePublicationDir,
  resolvePublicationPaths,
  resolveRepoRoot,
  selectNewestCandidate,
  validatePublicationMetadata,
  validateThumbnailFile,
} from "../src/publication.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, crc]);
}
// Real PNG bytes, no image dependency: enough for ffprobe to report geometry.
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      raw[pixel] = (x * 7) % 256;
      raw[pixel + 1] = (y * 11) % 256;
      raw[pixel + 2] = ((x + y) * 3) % 256;
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, {level: 9})),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function makeRoot(prefix = "vf-publication-") {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeRepo(root) {
  const factoryRoot = path.join(root, "repo");
  await mkdir(path.join(factoryRoot, "scripts", "nested"), {recursive: true});
  await mkdir(path.join(factoryRoot, "projects"), {recursive: true});
  await mkdir(path.join(factoryRoot, "output"), {recursive: true});
  await writeFile(path.join(factoryRoot, "package.json"), '{"name":"fixture"}\n', "utf8");
  return factoryRoot;
}

async function makeDownloads(root) {
  const downloads = path.join(root, "Downloads");
  await mkdir(downloads, {recursive: true});
  return downloads;
}

async function touch(filePath, content, ageDays = 0) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, content);
  if (ageDays > 0) {
    const when = new Date(Date.now() - ageDays * 86_400_000);
    await utimes(filePath, when, when);
  }
  return filePath;
}

function metadataFixture(episode = "ESSY-0005", overrides = {}) {
  return {
    schemaVersion: "1.0",
    platform: "youtube",
    episode,
    channel: "A Second Look at Life",
    title: "What Is Still There When I'm Eighty?",
    description: `${"A reflective paragraph about growing older. ".repeat(3)}\n\nSecond paragraph.`,
    thumbnail: "thumbnail.png",
    thumbnailText: "WHAT REMAINS?",
    tags: ["aging", "meaning of life"],
    language: "en",
    visibility: "private",
    ...overrides,
  };
}

async function withRoot(fn, prefix) {
  const root = await makeRoot(prefix);
  try {
    return await fn(root);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// repo root resolution
// ---------------------------------------------------------------------------

test("repo root is resolved by walking up, never hard-coded", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    assert.equal(await resolveRepoRoot(path.join(factoryRoot, "scripts", "nested")), factoryRoot);
    assert.equal(await resolveRepoRoot(factoryRoot), factoryRoot);
    // A directory that merely has a package.json is not a factory root.
    const decoy = path.join(factoryRoot, "node_modules", "some-package");
    await mkdir(decoy, {recursive: true});
    await writeFile(path.join(decoy, "package.json"), "{}\n", "utf8");
    assert.equal(await resolveRepoRoot(decoy), factoryRoot);
  }, "vf-publication-root-");
});

// ---------------------------------------------------------------------------
// publication path resolution
// ---------------------------------------------------------------------------

test("publication paths match the brand/ESSY/README.md asset-ownership layout", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const paths = resolvePublicationPaths(factoryRoot, "ESSY-0005");
    assert.equal(resolvePublicationDir(factoryRoot, "ESSY-0005"), path.join(factoryRoot, "projects", "ESSY-0005", "publication"));
    assert.equal(paths.thumbnail, path.join(factoryRoot, "projects", "ESSY-0005", "publication", "thumbnail.png"));
    assert.equal(paths.metadata, path.join(factoryRoot, "projects", "ESSY-0005", "publication", "youtube.json"));
    assert.equal(paths.record, path.join(factoryRoot, "projects", "ESSY-0005", "publication", "publication-record.json"));
    // Production and render artifacts stay where they are.
    assert.equal(path.relative(factoryRoot, paths.dir).startsWith(".."), false);
    assert.equal(paths.dir.includes("output"), false);
  });
});

// ---------------------------------------------------------------------------
// downloads path resolution
// ---------------------------------------------------------------------------

test("downloads directory resolves from the environment, not a hard-coded user", () => {
  assert.equal(
    resolveDownloadsDir({env: {USERPROFILE: "C:\\Users\\someone-else"}, platform: "win32"}),
    path.join("C:\\Users\\someone-else", "Downloads"),
  );
  assert.equal(
    resolveDownloadsDir({env: {HOME: "/home/other"}, platform: "linux"}),
    path.join("/home/other", "Downloads"),
  );
  // Fallback when the variable is absent, and an explicit override.
  assert.equal(
    resolveDownloadsDir({env: {}, platform: "linux", homeDir: "/fallback/home"}),
    path.join("/fallback/home", "Downloads"),
  );
  assert.equal(
    resolveDownloadsDir({env: {VIDEO_FACTORY_DOWNLOADS: "D:\\elsewhere"}, platform: "win32"}),
    path.resolve("D:\\elsewhere"),
  );
});

// ---------------------------------------------------------------------------
// candidate discovery and selection
// ---------------------------------------------------------------------------

test("supported sources are image-only and case-insensitive", () => {
  assert.equal(isSupportedSourceExtension("thumb.PNG"), true);
  assert.equal(isSupportedSourceExtension("thumb.jpg"), true);
  assert.equal(isSupportedSourceExtension("thumb.JPEG"), true);
  assert.equal(isSupportedSourceExtension("thumb.webp"), true);
  assert.equal(isSupportedSourceExtension("notes.pdf"), false);
  assert.equal(isSupportedSourceExtension("setup.exe"), false);
  assert.equal(isSupportedSourceExtension("thumbnail"), false);
});

test("only supported images become candidates, newest first", async () => {
  await withRoot(async (root) => {
    const downloads = await makeDownloads(root);
    await touch(path.join(downloads, "oldest.png"), makePng(1280, 720), 20);
    await touch(path.join(downloads, "newest.jpg"), makePng(1280, 720), 1);
    await touch(path.join(downloads, "middle.webp"), makePng(1280, 720), 5);
    await touch(path.join(downloads, "installer.exe"), "MZ");
    await touch(path.join(downloads, "notes.pdf"), "%PDF");
    await mkdir(path.join(downloads, "folder.png"));

    const candidates = await listImageCandidates(downloads);
    assert.deepEqual(candidates.map((entry) => entry.name), ["newest.jpg", "middle.webp", "oldest.png"]);
    assert.equal(candidates[0].extension, ".jpg");
    assert.ok(candidates[0].bytes > 0);
  });
});

test("the newest plausible candidate is selected", async () => {
  await withRoot(async (root) => {
    const downloads = await makeDownloads(root);
    await touch(path.join(downloads, "older.png"), makePng(1280, 720), 3);
    await touch(path.join(downloads, "newest.png"), makePng(1920, 1080), 0);
    const candidates = await listImageCandidates(downloads);
    const selection = selectNewestCandidate(candidates, {now: Date.now()});
    assert.equal(selection.reason, null);
    assert.equal(selection.selected.name, "newest.png");
    assert.ok(selection.ageDays < 1);
  });
});

test("a stale download is never guessed as the thumbnail", async () => {
  const now = Date.now();
  const stale = {name: "ancient.png", modifiedMs: now - 40 * 86_400_000};
  const selection = selectNewestCandidate([stale], {now});
  assert.equal(selection.reason, "stale");
  assert.equal(selection.selected, null);
  assert.equal(selection.newest.name, "ancient.png");
  // Widening the window is the explicit escape hatch.
  assert.equal(selectNewestCandidate([stale], {now, withinDays: 90}).selected.name, "ancient.png");
  // A download from the same working session is inside the default window.
  const fresh = {name: "just-downloaded.png", modifiedMs: now - 3 * 86_400_000};
  assert.equal(selectNewestCandidate([fresh], {now}).selected.name, "just-downloaded.png");
  assert.equal(PUBLICATION_DEFAULTS.newestCandidateWithinDays, 7);
});

test("an import run with only stale candidates fails instead of guessing", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const downloads = await makeDownloads(root);
    await touch(path.join(downloads, "old-photo.png"), makePng(1280, 720), 19);
    const candidates = await listImageCandidates(downloads);
    await assert.rejects(
      () => planThumbnailImport({factoryRoot, episode: "ESSY-0005", candidates}),
      /No recent thumbnail download found[\s\S]*waiting for the selected image/,
    );
    // Nothing was created.
    assert.equal(await isFile(path.join(factoryRoot, "projects", "ESSY-0005", "publication", "thumbnail.png")), false);
  });
});

test("no supported image in Downloads is an explicit failure", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const downloads = await makeDownloads(root);
    await touch(path.join(downloads, "notes.pdf"), "%PDF");
    const candidates = await listImageCandidates(downloads);
    assert.deepEqual(candidates, []);
    await assert.rejects(
      () =>
        planThumbnailImport({
          factoryRoot,
          episode: "ESSY-0005",
          candidates,
          downloadsDir: downloads,
        }),
      /No supported image found/,
    );
    // A missing Downloads folder is equally explicit.
    const missingFolderCandidates = await listImageCandidates(path.join(root, "absent"));
    await assert.rejects(
      () =>
        planThumbnailImport({
          factoryRoot,
          episode: "ESSY-0005",
          candidates: missingFolderCandidates,
        }),
      /No supported image found/,
    );
  });
});

// ---------------------------------------------------------------------------
// import planning
// ---------------------------------------------------------------------------

test("an unsupported source file is rejected before anything is written", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const downloads = await makeDownloads(root);
    const doc = await touch(path.join(downloads, "thumbnail.pdf"), "%PDF-1.7");
    await assert.rejects(
      () => planThumbnailImport({factoryRoot, episode: "ESSY-0005", sourcePath: doc}),
      /Unsupported thumbnail source: thumbnail\.pdf/,
    );
    assert.equal((await resolvePublicationPaths(factoryRoot, "ESSY-0005")).dir.includes(".pdf"), false);
  });
});

test("a missing explicit source is rejected", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    await assert.rejects(
      () =>
        planThumbnailImport({
          factoryRoot,
          episode: "ESSY-0005",
          sourcePath: path.join(root, "Downloads", "absent.png"),
        }),
      /does not exist/,
    );
  });
});

test("an existing canonical thumbnail is never overwritten silently", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const paths = resolvePublicationPaths(factoryRoot, "ESSY-0005");
    await mkdir(paths.dir, {recursive: true});
    const approved = makePng(1920, 1080);
    await writeFile(paths.thumbnail, approved);
    const downloads = await makeDownloads(root);
    const candidate = await touch(path.join(downloads, "newer.png"), makePng(1920, 1080));

    await assert.rejects(
      () =>
        planThumbnailImport({
          factoryRoot,
          episode: "ESSY-0005",
          sourcePath: candidate,
        }),
      /already exists[\s\S]*--replace/,
    );
    // The approved bytes are untouched.
    assert.deepEqual(await readFile(paths.thumbnail), approved);

    // Explicit replacement is allowed and reported.
    const plan = await planThumbnailImport({
      factoryRoot,
      episode: "ESSY-0005",
      sourcePath: candidate,
      replace: true,
    });
    assert.equal(plan.replaced, true);
  });
});

test("a PNG download is copied byte-for-byte and a JPEG is marked for conversion", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const downloads = await makeDownloads(root);
    const png = await touch(path.join(downloads, "a.png"), makePng(1920, 1080));
    const jpg = await touch(path.join(downloads, "b.jpg"), makePng(1920, 1080));
    const pngPlan = await planThumbnailImport({factoryRoot, episode: "ESSY-0005", sourcePath: png});
    assert.equal(pngPlan.needsConversion, false);
    assert.equal(pngPlan.paths.thumbnail, path.join(factoryRoot, "projects", "ESSY-0005", "publication", "thumbnail.png"));
    const jpgPlan = await planThumbnailImport({factoryRoot, episode: "ESSY-0005", sourcePath: jpg});
    assert.equal(jpgPlan.needsConversion, true);
    assert.equal(jpgPlan.source.extension, ".jpg");
  });
});

// ---------------------------------------------------------------------------
// thumbnail validation
// ---------------------------------------------------------------------------

test("a real 16:9 PNG at full resolution passes", async () => {
  await withRoot(async (root) => {
    const file = await touch(path.join(root, "thumbnail.png"), makePng(1920, 1080));
    const measured = await measureImage(file);
    assert.equal(measured.width, 1920);
    assert.equal(measured.height, 1080);
    const result = await validateThumbnailFile(file);
    assert.equal(result.passed, true, result.reasons.join("; "));
    assert.equal(result.aspectRatio, 1.7778);
  });
});

test("an approximately 16:9 crop passes; a square image fails", async () => {
  assert.equal(assessThumbnail({width: 1672, height: 941, bytes: 2_030_345}).passed, true);
  assert.equal(assessThumbnail({width: 1600, height: 900, bytes: 200_000}).passed, true);
  const square = assessThumbnail({width: 1200, height: 1200, bytes: 200_000});
  assert.equal(square.passed, false);
  assert.equal(square.checks.find((entry) => entry.id === "aspect-ratio").passed, false);
  // 4:3 is also rejected.
  assert.equal(assessThumbnail({width: 1440, height: 1080, bytes: 200_000}).passed, false);
  // Portrait fails both the minimum height and the aspect rule.
  const portrait = assessThumbnail({width: 1080, height: 1920, bytes: 200_000});
  assert.equal(portrait.checks.find((entry) => entry.id === "aspect-ratio").passed, false);
});

test("an undersized image is rejected", async () => {
  await withRoot(async (root) => {
    const file = await touch(path.join(root, "small.png"), makePng(640, 360));
    const result = await validateThumbnailFile(file);
    assert.equal(result.passed, false);
    const min = result.checks.find((entry) => entry.id === "minimum-resolution");
    assert.equal(min.passed, false);
    assert.equal(min.detail, "640x360");
    // A too-small byte payload is rejected independently of geometry.
    const tiny = assessThumbnail({width: 1920, height: 1080, bytes: 512});
    assert.equal(tiny.checks.find((entry) => entry.id === "file-size").passed, false);
  });
});

test("a missing or non-PNG canonical thumbnail fails clearly", async () => {
  await withRoot(async (root) => {
    const missing = await validateThumbnailFile(path.join(root, "absent.png"));
    assert.equal(missing.passed, false);
    assert.equal(missing.present, false);
    const notPng = await touch(path.join(root, "thumbnail.png"), "this is not a png");
    const result = await validateThumbnailFile(notPng);
    assert.equal(result.passed, false);
    assert.match(result.reasons[0], /not a PNG/);
  });
});

// ---------------------------------------------------------------------------
// metadata validation
// ---------------------------------------------------------------------------

test("a complete metadata document passes", () => {
  const result = validatePublicationMetadata(metadataFixture(), {episode: "ESSY-0005"});
  assert.equal(result.passed, true, result.reasons.join("; "));
  assert.equal(result.title, "What Is Still There When I'm Eighty?");
  assert.equal(result.tagCount, 2);
});

test("a missing metadata document fails every content rule", () => {
  const result = validatePublicationMetadata(null, {episode: "ESSY-0005"});
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].id, "document");
});

test("empty title, short description, and a wrong thumbnail reference fail", () => {
  const result = validatePublicationMetadata(
    metadataFixture("ESSY-0005", {
      title: "   ",
      description: "too short",
      thumbnail: "cover.png",
    }),
    {episode: "ESSY-0005"},
  );
  assert.equal(result.passed, false);
  const failed = result.checks.filter((entry) => !entry.passed).map((entry) => entry.id);
  assert.deepEqual(failed, ["title", "description", "thumbnail"]);
});

test("metadata must describe the requested episode and carry usable tags", () => {
  const wrongEpisode = validatePublicationMetadata(metadataFixture("ESSY-0004"), {episode: "ESSY-0005"});
  assert.equal(wrongEpisode.checks.find((entry) => entry.id === "episode").passed, false);

  const duplicateTags = validatePublicationMetadata(
    metadataFixture("ESSY-0005", {tags: ["aging", "aging", ""]}),
    {episode: "ESSY-0005"},
  );
  const tags = duplicateTags.checks.find((entry) => entry.id === "tags");
  assert.equal(tags.passed, false);
  assert.match(tags.detail, /duplicate tag/);
  assert.match(tags.detail, /empty tag/);

  const notAnArray = validatePublicationMetadata(metadataFixture("ESSY-0005", {tags: "aging"}), {
    episode: "ESSY-0005",
  });
  assert.equal(notAnArray.checks.find((entry) => entry.id === "tags").passed, false);
});

// ---------------------------------------------------------------------------
// lifecycle: completed is NOT archived
// ---------------------------------------------------------------------------

test("a draft-backed completed episode is completed, not archived", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    await writeJson(path.join(factoryRoot, "projects", "_drafts", "ESSY-0005", "state.yaml"), {
      schemaVersion: "2.0",
      draftId: "ESSY-0005",
      series: "ESSY",
      currentStage: "RENDER",
      status: "completed",
      approvals: {
        qa: {approved: true},
        finalAssembly: {approved: true, approvedAt: "2026-10-04T06:51:44.410Z"},
      },
    });
    const lifecycle = await resolveEpisodeLifecycle(factoryRoot, "ESSY-0005");
    assert.equal(lifecycle.state, "completed");
    assert.equal(lifecycle.completed, true);
    assert.equal(lifecycle.archived, false);
    assert.equal(lifecycle.source, "projects/_drafts/ESSY-0005/state.yaml");
    // status, not currentStage, carries completion.
    assert.equal(lifecycle.recordedStatus, "completed");
  });
});

test("an archived episode is archived even though it was completed first", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    await writeJson(path.join(factoryRoot, "archive", "episodes", "ESSY-0005", "archive.json"), {
      episode: "ESSY-0005",
      archivedAt: "2026-10-05T00:00:00.000Z",
      reason: "published",
    });
    const lifecycle = await resolveEpisodeLifecycle(factoryRoot, "ESSY-0005");
    assert.equal(lifecycle.state, "archived");
    assert.equal(lifecycle.archived, true);
    assert.equal(lifecycle.completed, true);
    assert.equal(lifecycle.source, "archive/episodes/ESSY-0005/archive.json");
  });
});

test("an episode workflow with status archived resolves as archived", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    await writeJson(path.join(factoryRoot, "projects", "ESSY-0001", "workflow.json"), {
      schemaVersion: "1.0",
      id: "ESSY-0001",
      kind: "episode",
      series: "ESSY",
      status: "archived",
      currentStage: "archived",
      approvals: {qa: true, finalQa: true},
    });
    const lifecycle = await resolveEpisodeLifecycle(factoryRoot, "ESSY-0001");
    assert.equal(lifecycle.state, "archived");
    assert.equal(lifecycle.source, "projects/ESSY-0001/workflow.json");
  });
});

test("an in-flight or unknown episode is not ready", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    await writeJson(path.join(factoryRoot, "projects", "_drafts", "ESSY-0006", "state.yaml"), {
      schemaVersion: "2.0",
      draftId: "ESSY-0006",
      series: "ESSY",
      currentStage: "RENDER",
      status: "final_assembly_pending",
      approvals: {qa: {approved: true}},
    });
    const pending = await resolveEpisodeLifecycle(factoryRoot, "ESSY-0006");
    assert.equal(pending.state, "not-ready");
    assert.equal(pending.completed, false);

    const unknown = await resolveEpisodeLifecycle(factoryRoot, "ESSY-9999");
    assert.equal(unknown.state, "not-ready");
    assert.equal(unknown.source, null);
  });
});

// ---------------------------------------------------------------------------
// episode location: active vs archived
// ---------------------------------------------------------------------------

// A published episode: the archive record plus the moved project/ and output/
// trees, and NO active projects/<EP> or output/<EP> at all.
async function makeArchivedEpisode(root, episode = "ESSY-0005") {
  const factoryRoot = await makeRepo(root);
  const archiveRoot = path.join(factoryRoot, "archive", "episodes", episode);
  await writeJson(path.join(archiveRoot, "archive.json"), {
    episode,
    archivedAt: "2026-10-05T12:28:32.827Z",
    reason: "published",
    locations: {inbox: "inbox/", project: "project/", output: "output/"},
    stateSource: `projects/_drafts/${episode}/state.yaml`,
  });
  await writeJson(path.join(archiveRoot, "project", "publication", "youtube.json"), metadataFixture(episode));
  await touch(path.join(archiveRoot, "project", "publication", "thumbnail.png"), makePng(1920, 1080));
  await writeJson(path.join(archiveRoot, "project", "final-assembly.json"), {
    title: {episodeTitle: "What Is Still There When I'm Eighty?"},
  });
  await writeJson(path.join(archiveRoot, "project", "temp", "final-assembly", "final-assembly-qa.json"), {
    episode,
    // The renderer records the active path; archival moves the file and leaves
    // the record untouched.
    output: `output/${episode}/${episode}-final-v1.mp4`,
    durationSec: 388.756,
    subtitleQa: {passed: true},
  });
  await touch(path.join(archiveRoot, "output", `${episode}-final-v1.mp4`), "mp4");
  return {factoryRoot, archiveRoot, episode};
}

test("an active episode resolves to projects/ and output/, unchanged", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const location = await resolveEpisodeLocation(factoryRoot, "ESSY-0004");
    assert.equal(location.archived, false);
    assert.equal(location.projectDir, path.join(factoryRoot, "projects", "ESSY-0004"));
    assert.equal(location.outputDir, path.join(factoryRoot, "output", "ESSY-0004"));
    // A recorded path still resolves against the repo root, exactly as before.
    assert.equal(
      resolveEpisodeRelativePath(location, "output/ESSY-0004/ESSY-0004-final-v1.mp4"),
      path.join(factoryRoot, "output", "ESSY-0004", "ESSY-0004-final-v1.mp4"),
    );
    assert.equal(
      resolvePublicationDir(factoryRoot, "ESSY-0004", location),
      path.join(factoryRoot, "projects", "ESSY-0004", "publication"),
    );
  });
});

test("an archived episode resolves to its canonical archive, not projects/ or output/", async () => {
  await withRoot(async (root) => {
    const {factoryRoot, archiveRoot, episode} = await makeArchivedEpisode(root);
    const location = await resolveEpisodeLocation(factoryRoot, episode);
    assert.equal(location.archived, true);
    assert.equal(location.source, `archive/episodes/${episode}/archive.json`);
    assert.equal(location.projectDir, path.join(archiveRoot, "project"));
    assert.equal(location.outputDir, path.join(archiveRoot, "output"));
    // The active trees stay gone: resolution reads, it never restores.
    assert.equal(await isDirectory(path.join(factoryRoot, "projects", episode)), false);
    assert.equal(await isDirectory(path.join(factoryRoot, "output", episode)), false);
    // Recorded repo-relative paths are re-rooted onto the archive areas.
    assert.equal(
      resolveEpisodeRelativePath(location, `output/${episode}/${episode}-final-v1.mp4`),
      path.join(archiveRoot, "output", `${episode}-final-v1.mp4`),
    );
    assert.equal(
      resolveEpisodeRelativePath(location, `projects/${episode}/temp/${episode}-subtitles.srt`),
      path.join(archiveRoot, "project", "temp", `${episode}-subtitles.srt`),
    );
    // A path recorded for another episode is never borrowed.
    assert.equal(
      resolveEpisodeRelativePath(location, "output/ESSY-0004/ESSY-0004-final-v1.mp4"),
      null,
    );
    assert.equal(resolveEpisodeRelativePath(location, "output/ESSY-0005/"), null);
    assert.equal(resolveEpisodeRelativePath(location, ""), null);
  });
});

test("an archive record that is a directory is not an archive", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    // An interrupted archive leaves archive.json unusable; the episode is then
    // still read from the active trees, never from a half-built archive.
    await mkdir(path.join(factoryRoot, "archive", "episodes", "ESSY-0005", "archive.json"), {
      recursive: true,
    });
    const location = await resolveEpisodeLocation(factoryRoot, "ESSY-0005");
    assert.equal(location.archived, false);
    assert.equal(location.projectDir, path.join(factoryRoot, "projects", "ESSY-0005"));
  });
});

// ---------------------------------------------------------------------------
// canonical final master resolution
// ---------------------------------------------------------------------------

test("the final master resolves from the renderer QA record, not a hard-coded label", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    await touch(path.join(factoryRoot, "output", "ESSY-0001", "ESSY-0001-final-v2.mp4"), "mp4");
    await writeJson(
      path.join(factoryRoot, "projects", "ESSY-0001", "temp", "final-assembly", "final-assembly-qa.json"),
      {
        episode: "ESSY-0001",
        output: "output/ESSY-0001/ESSY-0001-final-v2.mp4",
        subtitleQa: {passed: true},
      },
    );
    const master = await resolveFinalMaster(factoryRoot, "ESSY-0001");
    assert.equal(master.passed, true);
    assert.equal(master.relative, "output/ESSY-0001/ESSY-0001-final-v2.mp4");

    const missing = await resolveFinalMaster(factoryRoot, "ESSY-0007");
    assert.equal(missing.resolved, false);
    assert.match(missing.reason, /Final assembly has not been rendered/);

    // A recorded master whose file is gone fails.
    await writeJson(
      path.join(factoryRoot, "projects", "ESSY-0008", "temp", "final-assembly", "final-assembly-qa.json"),
      {episode: "ESSY-0008", output: "output/ESSY-0008/ESSY-0008-final-v1.mp4"},
    );
    const gone = await resolveFinalMaster(factoryRoot, "ESSY-0008");
    assert.equal(gone.passed, false);
    assert.match(gone.reason, /Final master is missing/);
  });
});

// ---------------------------------------------------------------------------
// archived publication check: an episode with no active projects/ or output/
// ---------------------------------------------------------------------------

test("an archived episode's package, master, and approved title resolve from the archive", async () => {
  await withRoot(async (root) => {
    const {factoryRoot, archiveRoot, episode} = await makeArchivedEpisode(root);
    const location = await resolveEpisodeLocation(factoryRoot, episode);
    const paths = resolvePublicationPaths(factoryRoot, episode, {}, location);
    assert.equal(
      paths.thumbnail,
      path.join(archiveRoot, "project", "publication", "thumbnail.png"),
    );
    assert.equal(paths.metadata, path.join(archiveRoot, "project", "publication", "youtube.json"));

    // 1. archived publication metadata and thumbnail
    const metadata = validatePublicationMetadata(
      await readPublicationMetadata(paths.metadata),
      {episode},
    );
    assert.equal(metadata.passed, true, metadata.reasons.join("; "));
    assert.equal(metadata.title, "What Is Still There When I'm Eighty?");
    const thumbnail = await validateThumbnailFile(paths.thumbnail);
    assert.equal(thumbnail.passed, true, thumbnail.reasons.join("; "));
    assert.equal(thumbnail.width, 1920);

    // 2. the archived final-assembly QA record resolves the archived master
    const video = await resolveFinalMaster(factoryRoot, episode);
    assert.equal(video.passed, true, video.reason);
    assert.equal(video.relative, `output/${episode}/${episode}-final-v1.mp4`);
    assert.equal(video.path, path.join(archiveRoot, "output", `${episode}-final-v1.mp4`));
    assert.equal(video.durationSec, 388.756);
    // Passing the location explicitly is equivalent.
    assert.equal((await resolveFinalMaster(factoryRoot, episode, {location})).path, video.path);

    // 3. the archived approved episode title
    assert.equal(
      await resolveApprovedEpisodeTitle(factoryRoot, episode),
      "What Is Still There When I'm Eighty?",
    );

    // 4. the composed check PASSES for a complete archived episode
    const lifecycle = await resolveEpisodeLifecycle(factoryRoot, episode);
    assert.equal(lifecycle.state, "archived");
    const report = buildPublicationCheckReport({
      episode,
      metadata,
      thumbnail,
      video,
      lifecycle,
      approvedTitle: "What Is Still There When I'm Eighty?",
    });
    assert.deepEqual(report.rows.map((row) => `${row.label}=${row.passed ? "PASS" : "FAIL"}`), [
      "Title=PASS",
      "Description=PASS",
      "Thumbnail=PASS",
      "Video=PASS",
    ]);
    assert.equal(report.ready, true);
    assert.ok(report.notes.some((note) => note.includes("is archived")));

    // Nothing was restored into the active trees.
    assert.equal(await isDirectory(path.join(factoryRoot, "projects", episode)), false);
    assert.equal(await isDirectory(path.join(factoryRoot, "output", episode)), false);
  });
});

test("an archived episode missing its master reports the archived QA path, not the active one", async () => {
  await withRoot(async (root) => {
    const {factoryRoot, episode} = await makeArchivedEpisode(root);
    await rm(path.join(factoryRoot, "archive", "episodes", episode, "output", `${episode}-final-v1.mp4`));
    const video = await resolveFinalMaster(factoryRoot, episode);
    assert.equal(video.passed, false);
    assert.match(video.reason, /Final master is missing/);

    // An archived episode that was never rendered names its archive path.
    await writeJson(
      path.join(factoryRoot, "archive", "episodes", "ESSY-0007", "archive.json"),
      {episode: "ESSY-0007", archivedAt: "2026-10-05T12:28:32.827Z", reason: "published"},
    );
    const never = await resolveFinalMaster(factoryRoot, "ESSY-0007");
    assert.equal(never.resolved, false);
    assert.match(never.reason, /archive\/episodes\/ESSY-0007\/project\/temp\/final-assembly/);
  });
});

test("an archived master's recorded path outside the episode is refused, not guessed", async () => {
  await withRoot(async (root) => {
    const {factoryRoot, archiveRoot, episode} = await makeArchivedEpisode(root);
    await writeJson(
      path.join(archiveRoot, "project", "temp", "final-assembly", "final-assembly-qa.json"),
      {episode, output: "output/ESSY-0004/ESSY-0004-final-v1.mp4", subtitleQa: {passed: true}},
    );
    const video = await resolveFinalMaster(factoryRoot, episode);
    assert.equal(video.resolved, true);
    assert.equal(video.passed, false);
    assert.equal(video.path, null);
    assert.match(video.reason, /is not inside ESSY-0005's archive/);
  });
});

test("a thumbnail import for an archived episode targets the archive, not projects/", async () => {
  await withRoot(async (root) => {
    const {factoryRoot, archiveRoot, episode} = await makeArchivedEpisode(root);
    const downloads = await makeDownloads(root);
    const source = await touch(path.join(downloads, "selected.png"), makePng(1920, 1080));
    const location = await resolveEpisodeLocation(factoryRoot, episode);
    // Start from a package with no thumbnail yet.
    await rm(path.join(archiveRoot, "project", "publication", "thumbnail.png"));

    const result = await importThumbnailAsset({factoryRoot, episode, sourcePath: source, location});
    assert.equal(result.thumbnail.passed, true, result.thumbnail.reasons.join("; "));
    assert.equal(
      result.recordPath,
      path.join(archiveRoot, "project", "publication", "publication-record.json"),
    );
    // The active project tree is still not recreated.
    assert.equal(await isDirectory(path.join(factoryRoot, "projects", episode)), false);
    // The approved archived thumbnail was replaced only because the archive copy
    // is the canonical one; planThumbnailImport still refuses without --replace.
    await assert.rejects(
      () => planThumbnailImport({factoryRoot, episode, sourcePath: source, location}),
      /already exists[\s\S]*--replace/,
    );
  });
});

// ---------------------------------------------------------------------------
// publication check composition
// ---------------------------------------------------------------------------

const passingVideo = {resolved: true, passed: true, relative: "output/ESSY-0005/ESSY-0005-final-v1.mp4", path: "C:/x.mp4", reason: null};
const passingThumbnail = {
  passed: true,
  present: true,
  width: 1672,
  height: 941,
  aspectRatio: 1.7768,
  bytes: 2_030_345,
  reasons: [],
  checks: [],
};

test("a completed episode with a valid package reports READY TO PUBLISH", () => {
  const metadata = validatePublicationMetadata(metadataFixture(), {episode: "ESSY-0005"});
  const report = buildPublicationCheckReport({
    episode: "ESSY-0005",
    metadata,
    thumbnail: passingThumbnail,
    video: passingVideo,
    lifecycle: {state: "completed", completed: true, archived: false, recordedStatus: "completed"},
    approvedTitle: "What Is Still There When I'm Eighty?",
  });
  assert.deepEqual(report.rows.map((row) => `${row.label}=${row.passed ? "PASS" : "FAIL"}`), [
    "Title=PASS",
    "Description=PASS",
    "Thumbnail=PASS",
    "Video=PASS",
  ]);
  assert.equal(report.ready, true);
  // Completed is reported as completed, and completion is never described as published.
  assert.ok(report.notes.some((note) => note.includes("completed is NOT published")));
  assert.ok(!report.notes.some((note) => note.includes("archived")));
});

test("any failing component blocks the verdict", () => {
  const metadata = validatePublicationMetadata(metadataFixture(), {episode: "ESSY-0005"});
  const cases = [
    [{...metadata}, {...passingThumbnail, passed: false, present: false}, passingVideo, "Thumbnail"],
    [metadata, passingThumbnail, {...passingVideo, passed: false, reason: "Final master is missing"}, "Video"],
  ];
  for (const [meta, thumbnail, video, expectedFail] of cases) {
    const report = buildPublicationCheckReport({
      episode: "ESSY-0005",
      metadata: meta,
      thumbnail,
      video,
      lifecycle: {state: "completed"},
      approvedTitle: null,
    });
    assert.equal(report.ready, false);
    assert.deepEqual(report.rows.filter((row) => !row.passed).map((row) => row.label), [expectedFail]);
  }

  const missingMetadata = validatePublicationMetadata(null, {episode: "ESSY-0005"});
  const noMetadata = buildPublicationCheckReport({
    episode: "ESSY-0005",
    metadata: missingMetadata,
    thumbnail: passingThumbnail,
    video: passingVideo,
    lifecycle: {state: "completed"},
    approvedTitle: null,
  });
  assert.equal(noMetadata.ready, false);
  assert.deepEqual(noMetadata.rows.filter((row) => !row.passed).map((row) => row.label), ["Title", "Description"]);
});

test("an archived episode is reported as archived, and title drift is advisory", () => {
  const metadata = validatePublicationMetadata(metadataFixture(), {episode: "ESSY-0005"});
  const report = buildPublicationCheckReport({
    episode: "ESSY-0005",
    metadata,
    thumbnail: passingThumbnail,
    video: passingVideo,
    lifecycle: {state: "archived", archived: true, completed: true},
    approvedTitle: "A Completely Different Renderer Title",
  });
  assert.equal(report.ready, true);
  assert.ok(report.notes.some((note) => note.includes("is archived")));
  assert.ok(report.notes.some((note) => note.includes("differs from the renderer-approved episode title")));
  assert.ok(!report.notes.some((note) => note.includes("completed is NOT published")));
});

test("publication defaults keep the repo thumbnail rules", () => {
  assert.equal(PUBLICATION_DEFAULTS.thumbnailFileName, "thumbnail.png");
  assert.equal(PUBLICATION_DEFAULTS.metadataFileName, "youtube.json");
  assert.equal(PUBLICATION_DEFAULTS.recordFileName, "publication-record.json");
  assert.equal(PUBLICATION_DEFAULTS.thumbnailMinWidth, 1280);
  assert.equal(PUBLICATION_DEFAULTS.thumbnailMinHeight, 720);
  assert.equal(PUBLICATION_DEFAULTS.thumbnailAspectRatio, 16 / 9);
});

// ---------------------------------------------------------------------------
// import execution (copy + record write)
// ---------------------------------------------------------------------------

test("a PNG download is copied, validated, and recorded without touching the source", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const paths = resolvePublicationPaths(factoryRoot, "ESSY-0005");
    const downloads = await makeDownloads(root);
    const source = await touch(path.join(downloads, "selected.png"), makePng(1920, 1080));
    const approved = makePng(1920, 1080);

    const result = await importThumbnailAsset({
      factoryRoot,
      episode: "ESSY-0005",
      sourcePath: source,
    });

    assert.equal(result.plan.needsConversion, false);
    assert.equal(result.thumbnail.passed, true, result.thumbnail.reasons.join("; "));
    assert.equal(result.thumbnail.width, 1920);
    assert.equal(result.sourceAssessment.passed, true);
    // The download is still in Downloads: COPY, never move.
    assert.deepEqual(await readFile(source), approved);
    // The canonical artifact is the byte-identical download.
    assert.deepEqual(await readFile(paths.thumbnail), approved);

    const record = JSON.parse(await readFile(paths.record, "utf8"));
    assert.equal(record.episode, "ESSY-0005");
    assert.equal(record.assets.thumbnail.file, "thumbnail.png");
    assert.equal(record.assets.thumbnail.source, source);
    assert.equal(record.assets.thumbnail.converted, false);
    assert.equal(record.assets.thumbnail.replacedExisting, false);
    assert.equal(record.assets.thumbnail.validation.passed, true);
    assert.equal(record.assets.thumbnail.width, 1920);
    assert.ok(record.assets.thumbnail.sha256);
    assert.ok(record.assets.thumbnail.importedAt);
  });
});

test("an undersized download is imported but reported FAIL, never resized to force a PASS", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const paths = resolvePublicationPaths(factoryRoot, "ESSY-0005");
    const downloads = await makeDownloads(root);
    const tiny = makePng(640, 360);
    const source = await touch(path.join(downloads, "tiny.png"), tiny);

    const result = await importThumbnailAsset({factoryRoot, episode: "ESSY-0005", sourcePath: source});
    assert.equal(result.thumbnail.passed, false);
    assert.equal(result.sourceAssessment.passed, false);
    // Written unchanged — no destructive crop or resize.
    assert.deepEqual(await readFile(paths.thumbnail), tiny);
    const record = JSON.parse(await readFile(paths.record, "utf8"));
    assert.equal(record.assets.thumbnail.validation.passed, false);
    assert.ok(record.assets.thumbnail.validation.reasons.length > 0);
  });
});

test("a non-PNG download is converted to the canonical PNG with ffmpeg", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const paths = resolvePublicationPaths(factoryRoot, "ESSY-0005");
    const downloads = await makeDownloads(root);
    // A minimal baseline JPEG produced by ffmpeg itself, so no fixture binary
    // is checked in.
    const jpeg = path.join(downloads, "selected.jpg");
    await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=1600x900:rate=1",
      "-frames:v", "1", jpeg,
    ]);

    const result = await importThumbnailAsset({factoryRoot, episode: "ESSY-0005", sourcePath: jpeg});
    assert.equal(result.plan.needsConversion, true);
    assert.equal(result.thumbnail.passed, true, result.thumbnail.reasons.join("; "));
    assert.equal(result.thumbnail.width, 1600);
    assert.equal((await readFile(paths.thumbnail)).subarray(0, 8).toString("hex"), PNG_SIGNATURE.toString("hex"));
    const record = JSON.parse(await readFile(paths.record, "utf8"));
    assert.equal(record.assets.thumbnail.converted, true);
    // The JPEG download is untouched.
    assert.equal(await isFile(jpeg), true);
  });
});

test("the publication record summarizes existing metadata when present", async () => {
  await withRoot(async (root) => {
    const factoryRoot = await makeRepo(root);
    const paths = resolvePublicationPaths(factoryRoot, "ESSY-0005");
    await writeJson(paths.metadata, metadataFixture());
    const downloads = await makeDownloads(root);
    const source = await touch(path.join(downloads, "selected.png"), makePng(1920, 1080));
    await importThumbnailAsset({factoryRoot, episode: "ESSY-0005", sourcePath: source});
    const record = JSON.parse(await readFile(paths.record, "utf8"));
    assert.equal(record.channel, "A Second Look at Life");
    assert.equal(record.metadata.file, "youtube.json");
    assert.equal(record.metadata.title, "What Is Still There When I'm Eighty?");
    assert.equal(record.metadata.tagCount, 2);
  });
});

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {stdio: ["ignore", "ignore", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

// ---------------------------------------------------------------------------
// helper
// ---------------------------------------------------------------------------

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), {recursive: true});
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("the fixture PNG encoder produces a readable image file", async () => {
  await withRoot(async (root) => {
    const file = path.join(root, "probe.png");
    await writeFile(file, makePng(16, 16));
    const info = await stat(file);
    assert.ok(info.size > PNG_SIGNATURE.length);
    const measured = await measureImage(file);
    assert.equal(measured.width, 16);
    assert.equal(measured.height, 16);
  });
});