const STAGE_DETAILS = Object.freeze({
  REQUEST: ["Collect the one missing request detail.", "request.yaml", "Stop when the request is complete."],
  CONCEPT: ["Create the best concept proposal.", "concept.yaml", "Present it and wait for explicit concept approval."],
  ENGLISH: ["Write the complete A2 English text from the approved concept.", "script.yaml", "Present it and wait for explicit English approval."],
  STORYBOARD: ["Assign the approved English text to visually teachable scenes.", "storyboard.yaml", "Present the scenes and wait for explicit scene approval."],
  PACKAGE: ["Build the final package only from approved artifacts.", "production-package.json", "Validate it and wait for explicit package approval."],
  ASSETS: ["Hand the approved package to the existing asset pipeline.", "assets/manifest.json", "Stop if required assets are missing."],
  RENDER: ["Use the existing renderer and complete QA.", "output/<EPISODE>/<EPISODE>.mp4", "Record QA approval after review."],
});

export function buildStagePrompt(state) {
  const details = STAGE_DETAILS[state.currentStage];
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
    reads.push("contracts/production-package.schema.json");
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
