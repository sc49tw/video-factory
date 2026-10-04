// Degenerate-media detection for sourced/downloaded assets.
//
// A downloaded or materialized asset can satisfy every container-level check
// (ISO-BMFF `ftyp`, ffprobe duration, plausible byte size) while carrying NO
// picture content at all: a flat gray frame encoded at a few kbps does exactly
// that. Such a file passes sha256 verification (the approved map records the
// hash of whatever was written), so no amount of hash/provenance checking
// catches it.
//
// This module measures the decoded PICTURE instead of the container:
//   spatialDetail  mean per-frame luma standard deviation. Real footage sits far
//                  above 3; a flat fill scores exactly 0.
//   motion         mean absolute inter-frame luma difference. A frozen still
//                  scores ~0.
//
// It is deliberately dependency-free (ffprobe/ffmpeg only) and deterministic:
// frames are sampled at fixed fractions of the clip duration.

import {spawn} from "node:child_process";

const PROBE_W = 160;
const PROBE_H = 90;
const DEFAULT_SAMPLES = 12;

export const MEDIA_VALIDATION_DEFAULTS = {
  // Mean per-frame luma stdDev below this means "no spatial detail".
  minSpatialDetail: 3,
  // Mean inter-frame abs difference below this means "no motion".
  minMotion: 0.5,
  sampleCount: DEFAULT_SAMPLES,
};

function run(command, args, {binary = false} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: binary ? "buffer" : "utf8",
    });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve(binary ? Buffer.concat(chunks) : chunks.join(""))
        : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1500)}`)),
    );
  });
}

async function probeStream(filePath) {
  const json = JSON.parse(
    await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
      "-show_entries", "format=duration,size,bit_rate,format_name",
      "-of", "json",
      filePath,
    ]),
  );
  const stream = json.streams?.[0];
  if (!stream) throw new Error(`no video stream: ${filePath}`);
  const durationSec = Number(json.format?.duration ?? stream.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(`unusable duration for ${filePath}`);
  }
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    frameRate: stream.r_frame_rate ?? null,
    frameCount: stream.nb_frames ? Number(stream.nb_frames) : null,
    durationSec,
    bytes: Number(json.format?.size ?? 0),
    bitRate: json.format?.bit_rate ? Number(json.format.bit_rate) : null,
    formatName: json.format?.format_name ?? null,
  };
}

async function sampleGrayFrame(filePath, seekSec) {
  const args = ["-v", "error"];
  // An image demuxer yields no frame when a seek is requested, not even `-ss 0`,
  // so a still is read with no seek at all.
  if (seekSec !== null && seekSec > 0) args.push("-ss", seekSec.toFixed(3));
  args.push(
    "-i", filePath,
    "-frames:v", "1",
    "-vf", `scale=${PROBE_W}:${PROBE_H}:flags=area,format=gray`,
    "-f", "rawvideo", "-",
  );
  const buf = await run("ffmpeg", args, {binary: true});
  const expected = PROBE_W * PROBE_H;
  if (buf.length < expected) {
    throw new Error(`short frame decode at ${seekSec}s (${buf.length}/${expected} bytes)`);
  }
  return buf.subarray(0, expected);
}

const stdDev = (values) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const meanAbsDiff = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

/**
 * Measure the decoded picture content of a media file.
 * @returns {Promise<{durationSec:number,width:number,height:number,bytes:number,
 *   bitRate:number|null,spatialDetail:number,motion:number,samples:number,
 *   sampleSecs:number[],degenerate:boolean,reasons:string[]}>}
 */
export async function measureMediaContent(filePath, options = {}) {
  const {minSpatialDetail, minMotion, sampleCount, stillImage = false} = {...MEDIA_VALIDATION_DEFAULTS, ...options};
  const probe = await probeStream(filePath);
  const usable = Math.max(probe.durationSec - 0.05, 0);
  // A still image (photo slot) has exactly one picture: seeking an image demuxer
  // yields no frame at all, so it is sampled once at t=0 with no -ss.
  const sampleSecs = stillImage
    ? [0]
    : Array.from({length: sampleCount}, (_, i) =>
        Number(Math.min(usable, (probe.durationSec * i) / sampleCount).toFixed(3)),
      );

  const frames = [];
  for (const t of sampleSecs) frames.push(await sampleGrayFrame(filePath, t));

  const perFrameStdDev = frames.map(stdDev);
  const spatialDetail = perFrameStdDev.reduce((a, b) => a + b, 0) / perFrameStdDev.length;

  let motion = 0;
  for (let i = 1; i < frames.length; i++) motion += meanAbsDiff(frames[i - 1], frames[i]);
  motion = frames.length > 1 ? motion / (frames.length - 1) : 0;

  const reasons = [];
  if (spatialDetail < minSpatialDetail) {
    reasons.push(
      `flat picture: mean per-frame luma stdDev ${spatialDetail.toFixed(3)} < ${minSpatialDetail} ` +
        `(decoded frames carry no spatial detail)`,
    );
  }
  // A still image is SUPPOSED to have no motion; only video must move.
  if (!stillImage && motion < minMotion) {
    reasons.push(
      `no motion: mean inter-frame abs difference ${motion.toFixed(3)} < ${minMotion}`,
    );
  }

  return {
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    bytes: probe.bytes,
    bitRate: probe.bitRate,
    frameRate: probe.frameRate,
    frameCount: probe.frameCount,
    stillImage,
    spatialDetail: Number(spatialDetail.toFixed(3)),
    motion: Number(motion.toFixed(3)),
    samples: frames.length,
    sampleSecs,
    degenerate: reasons.length > 0,
    reasons,
  };
}

/**
 * Hard gate: throws when the file has no usable picture content. Used by the
 * downloader/materializer so a flat stub can never be recorded as an approved,
 * provenance-verified asset.
 */
export async function assertMediaHasContent(filePath, label = filePath, options = {}) {
  const stats = await measureMediaContent(filePath, options);
  if (stats.degenerate) {
    throw new Error(
      `Degenerate media rejected for ${label}: ${stats.reasons.join("; ")} ` +
        `(${stats.width}x${stats.height}, ${stats.durationSec.toFixed(3)}s, ${stats.bytes} bytes, ` +
        `bitrate ${stats.bitRate ? Math.round(stats.bitRate / 1000) : "?"}kbps). ` +
        `A file with no picture content cannot be an approved editorial asset.`,
    );
  }
  return stats;
}