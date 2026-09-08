// GENERIC ESSY narration-master assembler (episode-agnostic).
//
// Deterministically assembles the episode's continuous narration master from
// the EXISTING approved cached TTS mp3 files using the approved narration
// offsets (assembly-timeline block windows). No TTS regeneration, no timing
// re-estimation, no pause changes — pure assembly.
//
// Per block: apad/atrim the block mp3 to the approved block window, then
// concat all blocks. Identical audio treatment to render-full-draft.mjs.
//
// Usage: node scripts/build-narration-master.mjs <EPISODE>
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import process from "node:process";

const FPS_TOLERANCE_SEC = 0.05;

const episode = process.argv[2];
if (!episode) {
  console.error("Usage: node scripts/build-narration-master.mjs <EPISODE>");
  process.exit(1);
}
const factoryRoot = process.cwd();
const projectRoot = path.join(factoryRoot, "projects", episode);
const tempRoot = path.join(projectRoot, "temp");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: factoryRoot, stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-800)}`)),
    );
  });
}

async function probeDuration(filePath) {
  const {execFileSync} = await import("node:child_process");
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    {cwd: factoryRoot, encoding: "utf8"},
  );
  return Number(out.trim());
}

const timeline = JSON.parse(await readFile(path.join(projectRoot, "assembly-timeline.json"), "utf8"));
const blocks = timeline.blocks ?? [];
if (!blocks.length) throw new Error("assembly-timeline.json has no blocks.");
await mkdir(path.join(tempRoot, "narration-master"), {recursive: true});

const segmentFiles = [];
for (const block of blocks) {
  const sentenceId = block.sentenceId;
  const audioPath = path.join(projectRoot, "audio", `${sentenceId}.mp3`);
  const audioDuration = await probeDuration(audioPath);
  const windowSec = block.endSec - block.startSec;
  if (audioDuration > windowSec + FPS_TOLERANCE_SEC) {
    throw new Error(
      `Narration TRUNCATION RISK ${sentenceId}: TTS ${audioDuration.toFixed(3)}s ` +
        `exceeds approved block window ${windowSec.toFixed(3)}s.`,
    );
  }
  const segmentPath = path.join(tempRoot, "narration-master", `${sentenceId}-narration.m4a`);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", audioPath,
    "-af",
    `apad=whole_dur=${windowSec.toFixed(6)},atrim=duration=${windowSec.toFixed(6)}`,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    segmentPath,
  ]);
  segmentFiles.push(segmentPath);
  process.stdout.write(`[NARR ${sentenceId}] ${windowSec.toFixed(3)}s (TTS ${audioDuration.toFixed(3)}s)\n`);
}

const listPath = path.join(tempRoot, "narration-master", "concat.txt");
await writeFile(
  listPath,
  `${segmentFiles.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join("\n")}\n`,
  "utf8",
);
const masterPath = path.join(tempRoot, `${episode}-narration-master.m4a`);
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "concat", "-safe", "0", "-i", listPath,
  "-c", "copy", masterPath,
]);

const masterDuration = await probeDuration(masterPath);
const expected = blocks.at(-1).endSec - blocks[0].startSec;
if (Math.abs(masterDuration - expected) > FPS_TOLERANCE_SEC) {
  throw new Error(
    `Narration master duration ${masterDuration.toFixed(3)}s != approved timeline ${expected.toFixed(3)}s.`,
  );
}
const reportPath = path.join(tempRoot, "narration-master", "narration-master-qa.json");
await writeFile(
  reportPath,
  `${JSON.stringify({
    episode,
    masterPath: path.relative(factoryRoot, masterPath).replaceAll("\\", "/"),
    durationSec: Number(masterDuration.toFixed(3)),
    expectedDurationSec: Number(expected.toFixed(3)),
    blocks: blocks.length,
    source: "existing approved cached TTS mp3 files (deterministic assembly, no TTS regeneration)",
    validation: "passed",
  }, null, 2)}\n`,
  "utf8",
);
console.log(
  `Narration master OK: ${path.relative(factoryRoot, masterPath)} — ${masterDuration.toFixed(3)}s ` +
    `(${blocks.length} blocks, expected ${expected.toFixed(3)}s)`,
);
