import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveDraftStage,
  createDraftState,
  readDraftState,
  submitStageArtifact,
  writeDraftState,
  writeRequest,
} from "../src/draft-workflow.mjs";
import {validateProductionPackage} from "../src/production-package.mjs";
import {buildStagePrompt} from "../src/stage-prompt.mjs";

const draftId = "DRAFT-20260726-001";

test("draft state persists and approval gates cannot be skipped", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vf-draft-"));
  const state = createDraftState({
    draftId,
    series: "LLFC",
    subtype: "default",
  });
  await writeDraftState(root, state);
  await assert.rejects(
    approveDraftStage(root, state, "concept"),
    /current stage is REQUEST/,
  );
  await writeRequest(root, state, {
    draftId,
    series: "LLFC",
    subtype: "default",
    format: "LLFC",
    sourceConcept: "Home Alone",
  });
  assert.equal(state.currentStage, "CONCEPT");
  await assert.rejects(
    approveDraftStage(root, state, "concept"),
    /before concept.yaml exists/,
  );
  await submitStageArtifact(root, state, "CONCEPT", {
    workingTitle: "The Residential Security Review",
    professionalFraming: "incident investigation",
    satiricalPremise: "A child runs a highly improvised security department.",
    learningObjective: "Use must and must not for safety rules.",
    summary: "An inquiry reviews a house defense failure.",
    centralLesson: "Good safety plans need clear rules.",
    mainCharacters: ["The child", "Two intruders"],
    sceneOutline: ["The risk", "The plan", "The review"],
  });
  assert.equal(state.status, "needs_approval");
  await approveDraftStage(root, state, "concept");
  assert.equal(state.currentStage, "ENGLISH");
  assert.equal((await readDraftState(root, draftId)).approvals.concept.approved, true);
});

test("package validation enforces sequential scenes and safe image prompts", () => {
  const valid = productionPackage();
  assert.equal(validateProductionPackage(valid).title, "Security Review");
  assert.throws(
    () =>
      validateProductionPackage({
        ...valid,
        scenes: [{...valid.scenes[0], scene: 2}],
      }),
    /sequential/,
  );
  assert.throws(
    () =>
      validateProductionPackage({
        ...valid,
        scenes: [{...valid.scenes[0], imagePrompt: "Include subtitles at the bottom."}],
      }),
    /schema validation failed/,
  );
});

test("runtime prompt references contracts instead of copying their rules", async () => {
  const state = createDraftState({
    draftId,
    series: "LLFC",
    subtype: "default",
    requestComplete: true,
  });
  const prompt = buildStagePrompt(state);
  assert.match(prompt, /Current stage: CONCEPT/);
  assert.match(prompt, /series\/LLFC\/series.yaml/);
  assert.match(prompt, /series\/LLFC\/creative-direction.md/);
  assert.match(prompt, /wait for explicit concept approval/i);
  assert.doesNotMatch(prompt, /Final JSON contract/);
  assert.doesNotMatch(prompt, /Production rules:/);
  const schema = JSON.parse(
    await readFile(
      path.join(process.cwd(), "contracts", "production-package.schema.json"),
      "utf8",
    ),
  );
  assert.equal(schema.properties.series.const, "LLFC");
});

function productionPackage() {
  return {
    draftId,
    series: "LLFC",
    subtype: "default",
    title: "Security Review",
    language: "en",
    level: "A2",
    summary: "A formal review of a very unusual home defense plan.",
    characters: [
      {
        name: "The child",
        visualDescription: "A small boy with short blond hair and a red sweater.",
      },
    ],
    scenes: [
      {
        scene: 1,
        imageDescription: "The child checks a quiet hallway.",
        imagePrompt: "A child checks a quiet hallway in warm cinematic light.",
        sentences: ["You must check every door."],
      },
    ],
  };
}
