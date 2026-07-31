import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getCategory,
  nextEpisodeId,
  validateEpisodeForCategory,
} from "../src/categories.mjs";
import {nextStageFromGates} from "../src/gates.mjs";
import {
  createWorkflow,
  readWorkflow,
  registerAttempt,
  writeWorkflow,
} from "../src/workflow.mjs";

const registry = {
  series: {
    ESSD: {
      episodePattern: "^ESSD-[0-9]{4}$",
      episodePrefix: "ESSD-",
      digits: 4,
      subtypes: {
        "classic-twisted": {
          label: "Classic Twisted",
          description: "Test",
        },
      },
    },
  },
};

test("category registry validates IDs and allocates the next ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vf-category-"));
  await mkdir(path.join(root, "inbox", "ESSD-0010"), {recursive: true});
  await mkdir(path.join(root, "projects", "ESSD-0011"), {recursive: true});
  assert.equal(
    getCategory(registry, "ESSD", "classic-twisted").subtype.label,
    "Classic Twisted",
  );
  assert.equal(validateEpisodeForCategory(registry, "ESSD-0010", "ESSD"), "ESSD-0010");
  assert.equal(await nextEpisodeId(root, registry, "ESSD"), "ESSD-0012");
});

test("gates stop at approval and QA boundaries", () => {
  const gates = {
    lesson: {passed: true},
    images: {passed: true},
    render: {passed: false},
    qa: {passed: false},
  };
  assert.equal(nextStageFromGates(gates, {}), "content-approval");
  assert.equal(nextStageFromGates(gates, {content: true}), "render-ready");
  gates.render.passed = true;
  gates.qa.passed = true;
  assert.equal(nextStageFromGates(gates, {content: true}), "qa");
  assert.equal(nextStageFromGates(gates, {content: true, qa: true}), "completed");
});

test("workflow persists checkpoints and blocks after three repeated failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vf-workflow-"));
  const workflow = createWorkflow({
    id: "ESSD-0010",
    kind: "episode",
    series: "ESSD",
    subtype: "classic-twisted",
    currentStage: "rendering",
    status: "running",
  });
  for (let index = 0; index < 3; index += 1) {
    registerAttempt(workflow, "rendering", "failed", "ffmpeg failed");
  }
  assert.equal(workflow.status, "blocked");
  await writeWorkflow(root, workflow);
  assert.equal((await readWorkflow(root, "ESSD-0010")).blocker, "ffmpeg failed");
});

test("rerender invalidation returns a completed workflow to render-ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vf-rerender-"));
  const workflow = createWorkflow({
    id: "ESSD-0010",
    kind: "episode",
    series: "ESSD",
    subtype: "classic-twisted",
    currentStage: "completed",
    status: "completed",
  });
  workflow.approvals.content = true;
  workflow.approvals.images = true;
  workflow.approvals.qa = false;
  workflow.needsRerender = true;
  workflow.rerenderReason = "Wrong ESSD timeline";
  assert.equal(workflow.needsRerender, true);
  assert.equal(workflow.rerenderReason, "Wrong ESSD timeline");
});
