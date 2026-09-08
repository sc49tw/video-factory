import {readFileSync} from "node:fs";

const s = readFileSync("projects/ESSY-0002/temp/ESSY-0002-review-540p.srt", "utf8");
const cues = [];
const lines = s.split(/\r?\n/);
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].includes("-->")) {
    const m = lines[i].match(
      /(\d+):(\d+):(\d+)[,.]\d+\s*-->\s*(\d+):(\d+):(\d+)[,.]\d+/,
    );
    if (m) {
      const sa = +m[1] * 3600 + +m[2] * 60 + +m[3];
      const ea = +m[4] * 3600 + +m[5] * 60 + +m[6];
      cues.push({s: sa, e: ea, txt: lines[i + 1] || ""});
      i += 1;
    }
  }
}
for (const t of [5, 271, 489]) {
  const hit = cues.find((c) => t >= c.s && t <= c.e);
  console.log(`${t}s -> ${hit ? `${hit.s}..${hit.e} : "${hit.txt}"` : "NO CUE ACTIVE"}`);
}
console.log("total cues", cues.length);