// Deterministic materialization of ONE already-approved slot asset.
//
// Scope guard: this tool NEVER chooses an asset. It resolves the rendition for
// the assetId that the approved-slot-asset-map already names, downloads it,
// measures the decoded picture, and rewrites the asset map + provenance with the
// values that are actually true of the bytes on disk.
//
// Why this exists: a previous materialization recorded a 51,548-byte,
// 1920x1080, 20.000s file for this asset. It was a flat gray frame (per-frame
// luma stdDev 0.000, zero inter-frame motion) that passed every container check
// — ftyp signature, ffprobe duration, MIN_BYTES, and its own sha256 — because
// the map recorded the hash of the stub itself. Only measuring the decoded
// picture reveals that.
//
// Usage:
//   node scripts/_materialize-approved-slot.mjs <EPISODE> <SLOT_ID> [--url <renditionUrl>]
import {createHash} from "node:crypto";
import {mkdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import {createWriteStream} from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import {measureMediaContent} from "../src/media-content-validation.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("too many redirects"));
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          "User-Agent": UA,
          Accept: "video/mp4,video/webm,video/*,*/*;q=0.9",
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.pexels.com/",
        },
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          downloadFile(next, destPath, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const file = createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(300000, () => {
      req.destroy();
      reject(new Error(`download timeout: ${url}`));
    });
  });
}

const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags.set(argv[i].slice(2), argv[i + 1]);
  else positional.push(argv[i]);
}
const episode = positional[0];
const slotId = positional[1];
const explicitUrl = flags.get("url") ?? null;
if (!episode || !slotId) {
  console.error("Usage: node scripts/_materialize-approved-slot.mjs <EPISODE> <SLOT_ID> [--url <renditionUrl>]");
  process.exit(1);
}

const root = process.cwd();
const project = path.join(root, "projects", episode);
const downloads = path.join(project, "sourcing", "downloads");
const mapPath = path.join(project, "sourcing", "approved-slot-asset-map.json");
const provPath = path.join(downloads, "provenance.json");

const assetMap = JSON.parse(await readFile(mapPath, "utf8"));

// Locate the approved record for this slot anywhere in the map.
let approved = null;
const locate = (node) => {
  if (Array.isArray(node)) return node.forEach(locate);
  if (node && typeof node === "object") {
    if (node.slotId === slotId && (node.assetId || node.localName)) approved = node;
    else Object.values(node).forEach(locate);
  }
};
locate(assetMap);
if (!approved) throw new Error(`No approved asset record for ${slotId} in ${path.relative(root, mapPath)}`);

console.log(`Slot            : ${slotId}`);
console.log(`Approved assetId: ${approved.assetId}  (this tool does not change it)`);
console.log(`Source page     : ${approved.sourcePage}`);
console.log(`Recorded URL    : ${approved.downloadUrl}`);

// ---- Rendition resolution (same assetId, first URL that actually serves) ----
// A recorded downloadUrl may name a rendition the provider never published; the
// asset identity is the pexels id, not the rendition filename.
const pexelsId = String(approved.pexelsId ?? approved.assetId?.match(/(\d+)$/)?.[1] ?? "");
const candidates = explicitUrl
  ? [explicitUrl]
  : [
      approved.downloadUrl,
      ...["hd_1920_1080_25fps", "hd_1366_720_25fps", "uhd_2560_1440_25fps", "hd_1080_1920_25fps", "hd_720_1280_25fps", "sd_540_960_25fps", "sd_360_640_25fps", "sd_240_426_25fps"]
        .map((rendition) => `https://videos.pexels.com/video-files/${pexelsId}/${pexelsId}-${rendition}.mp4`)
        .filter((u) => u !== approved.downloadUrl),
    ].filter(Boolean);

await mkdir(downloads, {recursive: true});
const staging = path.join(downloads, `.staging-${slotId}.mp4`);
let downloaded = null;
for (const url of candidates) {
  try {
    process.stdout.write(`  trying ${url} ... `);
    await downloadFile(url, staging);
    const bytes = (await stat(staging)).size;
    if (bytes < 50000) throw new Error(`only ${bytes} bytes`);
    process.stdout.write(`ok (${bytes} bytes)\n`);
    downloaded = {url, bytes};
    break;
  } catch (error) {
    process.stdout.write(`unavailable (${error.message})\n`);
    await rm(staging, {force: true});
  }
}
if (!downloaded) throw new Error(`No published rendition could be downloaded for asset ${approved.assetId}`);

// ---- Degenerate-content gate: measure the PICTURE, not the container ----
const stats = await measureMediaContent(staging);
console.log(
  `  measured: ${stats.width}x${stats.height}, ${stats.durationSec.toFixed(3)}s, ` +
    `${stats.bytes} bytes, ${stats.bitRate ? Math.round(stats.bitRate / 1000) : "?"}kbps, ` +
    `spatialDetail=${stats.spatialDetail}, motion=${stats.motion}`,
);
if (stats.degenerate) {
  await rm(staging, {force: true});
  throw new Error(
    `Downloaded rendition for ${approved.assetId} is degenerate: ${stats.reasons.join("; ")}. ` +
      `Refusing to install it as an approved asset.`,
  );
}

// ---- Fit check against the slot window the timeline will allocate ----
const timeline = JSON.parse(await readFile(path.join(project, "assembly-timeline.json"), "utf8"));
const shots = timeline.blocks.flatMap((b) => (b.shots ?? []).map((s) => ({...s, sentenceId: b.sentenceId})));
const timelineShot = shots.find((s) => s.slotId === slotId);
const need = timelineShot?.renderDurationSec ?? approved.slotDurationSec ?? null;
if (need !== null && stats.durationSec + 0.05 < need) {
  await rm(staging, {force: true});
  throw new Error(
    `Asset ${approved.assetId} is ${stats.durationSec.toFixed(3)}s but ${slotId} needs ${need.toFixed(3)}s. ` +
      `Cannot install.`,
  );
}
console.log(`  slot window needs ${need !== null ? `${need.toFixed(3)}s` : "unknown"}; asset provides ${stats.durationSec.toFixed(3)}s`);

// ---- Install + record the values that are true of the bytes on disk ----
const localName = approved.localName ?? `${slotId}-${approved.assetId}.mp4`;
const finalPath = path.join(downloads, localName);
const previousPath = path.join(downloads, approved.localName ?? localName);
if (path.resolve(previousPath) !== path.resolve(finalPath)) {
  await rm(previousPath, {force: true});
}
await rename(staging, finalPath);
const data = await readFile(finalPath);
const sha256 = createHash("sha256").update(data).digest("hex");

Object.assign(approved, {
  downloadUrl: downloaded.url,
  width: stats.width,
  height: stats.height,
  orientation: stats.width >= stats.height ? "landscape" : "portrait",
  sourceDurationSec: Number(stats.durationSec.toFixed(3)),
  usableSec: Number(stats.durationSec.toFixed(3)),
  bytes: stats.bytes,
  sha256,
  localName,
  localPath: path.relative(root, finalPath).replaceAll("\\", "/"),
  durationSource: `ffprobe + decoded-picture measurement of the materialized file named by localName (sha256 ${sha256.slice(0, 12)}…)`,
  materializedAt: new Date().toISOString(),
});
await writeFile(mapPath, `${JSON.stringify(assetMap, null, 2)}\n`, "utf8");
console.log(`Approved map updated: ${path.relative(root, mapPath)}`);

// ---- Provenance: exactly ONE record per slot ----
// Two records for one slot make resolution order-dependent: whichever record is
// read last silently wins. Collapse to the approved record so the resolver has a
// single, unambiguous answer.
const provenance = JSON.parse(await readFile(provPath, "utf8"));
const others = provenance.items.filter((i) => i.slotId !== slotId);
provenance.items = [
  ...others,
  {
    slotId,
    id: approved.assetId,
    mediaType: approved.mediaType,
    sourceUrl: approved.sourcePage,
    downloadUrl: approved.downloadUrl,
    creator: approved.creator,
    creatorUrl: approved.creatorUrl,
    license: approved.license,
    licenseUrl: approved.licenseUrl,
    originalFilename: localName,
    localPath: approved.localPath,
    bytes: stats.bytes,
    fileSizeBytes: stats.bytes,
    sha256,
    downloadedAt: new Date().toISOString(),
    durationSec: Number(stats.durationSec.toFixed(3)),
    width: stats.width,
    height: stats.height,
    orientation: approved.orientation,
    stillMotion: approved.stillMotion ?? null,
  },
];
await writeFile(provPath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");

const dupes = Object.entries(
  provenance.items.reduce((acc, i) => ({...acc, [i.slotId]: (acc[i.slotId] ?? 0) + 1}), {}),
).filter(([, n]) => n > 1);
console.log(`Provenance rewritten: ${path.relative(root, provPath)}`);
console.log(`  duplicate slot records remaining: ${dupes.length ? JSON.stringify(dupes) : "none"}`);
console.log(`\n${slotId} materialized: ${localName}`);
console.log(`  ${stats.width}x${stats.height} ${approved.orientation}, ${stats.durationSec.toFixed(3)}s, ${stats.bytes} bytes`);
console.log(`  sha256 ${sha256}`);
console.log(`  assetId UNCHANGED: ${approved.assetId}`);