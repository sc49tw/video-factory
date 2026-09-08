import {spawn} from "node:child_process";

const W = 960;
const H = 540;

// Extract the subtitle band as raw gray for a given timestamp and compute a
// pixel-diff vs the unsubtitled master (scaled to the same geometry). Burned
// text yields many nonzero-diff pixels in that band.
function bandPixels(videoPath, t, y0, y1) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(t), "-i", videoPath,
      "-frames:v", "1",
      "-vf", `scale=${W}:${H}:flags=lanczos,crop=${W}:${y1 - y0}:0:${y0},format=gray,fps=30`,
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ]);
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({buf: Buffer.concat(chunks), code}));
  });
}

const subtitled = "output/ESSY-0002/ESSY-0002-review-540p-subtitled-v1.mp4";
const master = "output/ESSY-0002/ESSY-0002-full-draft-v1.mp4";
const points = [
  {label: "early", t: 5.0, y0: 380, y1: 500},
  {label: "mid", t: 271.0, y0: 380, y1: 500},
  {label: "late", t: 489.0, y0: 380, y1: 500},
];

for (const p of points) {
  const a = await bandPixels(subtitled, p.t, p.y0, p.y1);
  const b = await bandPixels(master, p.t, p.y0, p.y1);
  // Compare byte-wise in the same band; burned text adds diff pixels.
  const n = Math.min(a.buf.length, b.buf.length);
  let diff = 0;
  let sumAbs = 0;
  for (let i = 0; i < n; i += 1) {
    const d = Math.abs(a.buf[i] - b.buf[i]);
    if (d > 40) diff += 1;
    sumAbs += d;
  }
  console.log(
    `${p.label} @ ${p.t}s  bytes=${n}  hard_diff_px=${diff}  mean_abs=${(sumAbs / n).toFixed(2)}  ` +
    (diff > 800 ? "=> SUBTITLES PRESENT" : "=> no clear delta"),
  );
}