import {packageContractPathForSeries} from "./series-contracts.mjs";

const STAGE_DETAILS = Object.freeze({
  REQUEST: ["Collect the one missing request detail.", "request.yaml", "Stop when the request is complete."],
  CONCEPT: ["Create the best concept proposal.", "concept.yaml", "Present it and wait for explicit concept approval."],
  ENGLISH: ["Write the complete A2 English text from the approved concept.", "script.yaml", "Present it and wait for explicit English approval."],
  PREPARE: [
    "Generate per-block TTS plus same-session WordBoundary timing and record actual ffprobe durations.",
    "projects/<EP>/manifest.json + audio/*.mp3 + temp/*.vtt + temp/*.words.json",
    "Stop: do NOT fix shot/slot counts and do NOT source assets. Timing only.",
  ],
  STORYBOARD: ["Assign the approved English text to visually teachable scenes.", "storyboard.yaml", "Present the scenes and wait for explicit scene approval."],
  PACKAGE: ["Build the final package only from approved artifacts.", "production-package.json", "Validate it and wait for explicit package approval."],
  ASSETS: ["Hand the approved package to the existing asset pipeline.", "assets/manifest.json", "Stop if required assets are missing."],
  RENDER: ["Use the existing renderer and complete QA.", "output/<EPISODE>/<EPISODE>.mp4", "Record QA approval after review."],
});

const ESSY_STAGE_DETAILS = Object.freeze({
  ENGLISH: [
    "WRITE is already human-approved: preserve script.md narration blocks exactly.",
    "projects/<EP>/script.md + titles.json + compression-review.md",
    "Present Gate 1 readiness and wait for explicit English approval. Do NOT rewrite narration.",
  ],
  PREPARE: [
    "Synthesize approved narration per block with scripts/generate-essy-tts.py: same-session audio + VTT parent window + WordBoundary words.json, then record actual ffprobe durations in manifest.json.",
    "projects/<EP>/manifest.json + audio/*.mp3 + temp/*.vtt + temp/*.words.json",
    "Timing only. Do NOT fix shot/slot counts, do NOT plan sourcing, do NOT download assets. Audio is the master timeline.",
  ],
  STORYBOARD: [
    "DIRECT visual-slot planning FROM actual PREPARE timing: Visual Arc -> Slots -> editorialFunction -> visualIntent -> avoid, then sequence literalness review. Only here may slot count become concrete.",
    "storyboard.yaml (blocks/slots + sequenceLiteralnessReview)",
    "Present the slots and wait for explicit Gate 2 visual-selection approval.",
  ],
});

function isEssySeriesDraft(state) {
  return String(state?.series ?? "").toUpperCase() === "ESSY";
}

export function buildStagePrompt(state) {
  const details = isEssySeriesDraft(state)
    ? (ESSY_STAGE_DETAILS[state.currentStage] ?? STAGE_DETAILS[state.currentStage])
    : STAGE_DETAILS[state.currentStage];
  if (!details) throw new Error(`Unsupported prompt stage ${state.currentStage}.`);
  const root = `projects/_drafts/${state.draftId}`;
  const reads = [
    "workflows/episode-production.workflow.yaml",
    `series/${state.series}/series.yaml`,
    `series/${state.series}/creative-direction.md`,
    `series/${state.series}/style-guide.md`,
    `${root}/request.yaml`,
    `${root}/state.yaml`,
  ];
  for (const name of [
    state.artifacts.concept,
    state.artifacts.script,
    state.artifacts.storyboard,
  ]) {
    if (name) reads.push(`${root}/${name}`);
  }
  if (state.currentStage === "PACKAGE") {
    // Series-specific package contract; dispatch lives ONLY in series-contracts.
    reads.push(packageContractPathForSeries(state.series));
  }
  return [
    `Draft: ${state.draftId}`,
    `Series: ${state.series}`,
    `Subtype: ${state.subtype}`,
    `Current stage: ${state.currentStage}`,
    "",
    "Read:",
    ...reads.map((item) => `- ${item}`),
    "",
    `Task:\n${details[0]}`,
    "",
    `Required output: ${details[1]}`,
    "",
    `Stop condition:\n${details[2]}`,
    "Only perform the current stage. Do not create later-stage artifacts.",
  ].join("\n");
}
