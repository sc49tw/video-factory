// Quantify whether an approved source asset is real picture content or a
// degenerate/blank download. Reports per-frame luma mean/std-dev and the mean
// absolute inter-frame difference, plus unique-frame count.
//
// Usage: node scripts/_asset-luma-stats.mjs <file> [<file> ...]
import process from "node:process";
import {spawn} from "node:child_process";

const run = (cmd, args, binary = false) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, {stdio: ["ignore", "pipe", "pipe"], encoding: binary ? "buffer" : "utf8"});
    const ch = [];
    let e = "";
    p.stdout.on("data", (d) => ch.push(d));
    p.stderr.on("data", (d) => (e += d.toString()));
    p.on("close", (k) => (k === 0 ? res(binary ? Buffer.concat(ch) : ch.join("")) : rej(new Error(`${cmd} ${k}: ${e.slice(-1500)}`))));
  });

const W = 160;
const H = 90;

for (const file of process.argv.slice(2)) {
  const meta = JSON.parse(
    await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height,r_frame_rate,nb_frames,duration", "-show_entries", "format=duration,size,bit_rate",
      "-of", "json", file]),
  );
  const st = meta.streams?.[0] ?? {};
  const fmt = meta.format ?? {};
  // 30 sampled frames spread across the clip.
  const dur = Number(fmt.duration ?? st.duration ?? 0);
  const n = 30;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = Math.max(0, Math.min(Math.max(dur - 0.2, 0), (dur * i) / n));
    const buf = await run("ffmpeg", ["-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1",
      "-vf", `scale=${W}:${H}:flags=area,format=gray`, "-f", "rawvideo", "-"], true);
    frames.push({t, px: Buffer.from(buf.subarray(0, W * H))});
  }
  const stats = frames.map(({t, px}) => {
    let s = 0;
    for (const v of px) s += v;
    const mean = s / px.length;
    let q = 0;
    for (const v of px) q += (v - mean) ** 2;
    return {t: Number(t.toFixed(3)), mean: Number(mean.toFixed(2)), stdDev: Number(Math.sqrt(q / px.length).toFixed(2))};
  });
  let inter = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1].px;
    const b = frames[i].px;
    let d = 0;
    for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
    inter += d / a.length;
  }
  inter /= frames.length - 1;
  const meanStd = stats.reduce((a, b) => a + b.stdDev, 0) / stats.length;
  const verdict = meanStd < 3 ? "DEGENERATE (blank/flat)" : inter < 0.5 ? "STATIC (no motion)" : "real content";
  console.log(`${file}`);
  console.log(`  ${st.width}x${st.height} ${st.r_frame_rate} frames=${st.nb_frames ?? "?"} dur=${dur}s bytes=${fmt.size} bitrate=${Math.round(Number(fmt.bit_rate ?? 0) / 1000)}kbps`);
  console.log(`  mean per-frame luma stdDev (spatial detail): ${meanStd.toFixed(2)}  [min ${Math.min(...stats.map((s) => s.stdDev)).toFixed(2)}, max ${Math.max(...stats.map((s) => s.stdDev)).toFixed(2)}]`);
  console.log(`  mean inter-frame abs diff (motion):         ${inter.toFixed(3)}`);
  console.log(`  VERDICT: ${verdict}\n`);
}