// Tiny P1 policy smoke: render one STATIC and one SLOW-PUSH clip via the
// canonical shared module (temp-only output, no renderer changes).
import {execFileSync} from "node:child_process";
import {mkdirSync} from "node:fs";
import {resolveStillMotion, stillImageFilter} from "../_still-motion.mjs";

mkdirSync("temp/still-motion-smoke", {recursive: true});
const img = "projects/ESSY-0001/sourcing/downloads/N006-S3-pexels-photo-9818697.jpg";
const args = {width: 960, height: 540, fps: 25, frameCount: 100};
for (const sm of ["static", "slow-push"]) {
  const vf = stillImageFilter({...args, stillMotion: resolveStillMotion({stillMotion: sm})});
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
    "-loop", "1", "-i", img, "-t", "4", "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    `temp/still-motion-smoke/${sm}.mp4`]);
  console.log("rendered", sm);
}
console.log("SMOKE OK");
