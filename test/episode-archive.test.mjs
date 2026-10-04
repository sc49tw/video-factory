// Archive regression tests for `pnpm video:workflow archive <EP> --published`.
//
// The archive command must support BOTH authoritative episode record kinds:
//
//   - legacy workflow-backed episodes: projects/<EP>/workflow.json
//   - current draft-backed episodes:   projects/_drafts/<EP>/state.yaml
//
// Covered here: legacy compatibility, draft-backed archival, the mandatory
// --published confirmation, completed + QA + final-assembly eligibility, project
// and output movement, archive.json, the draft status transition to archived,
// and no partial archive when a move fails.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createDraftState, readDraftState, writeDraftState} from "../src/draft-workflow.mjs";
import {
  archiveEpisodeRecord,
  draftArchiveBlockers,
  episodeArchiveRoot,
  isEpisodeArchived,
  resolveArchiveRecord,
  workflowArchiveBlockers,
} from "../src/episode-archive.mjs";
import {createWorkflow, readWorkflow, writeWorkflow} from "../src/workflow.mjs";

const DRAFT_EPISODE = "ESSY-9005";
const LEGACY_EPISODE = "LLFC-9001";

async function makeRoot() {
  return mkdtemp(path.join(os.tmpdir(), "vf-archive-"));
}

async function exists(value) {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

// --- draft-backed fixture ----------------------------------------------------

function draftState(overrides = {}) {
  const state = createDraftState({
    draftId: DRAFT_EPISODE,
    series: "ESSY",
    subtype: "essay",
  });
  state.currentStage = "RENDER";
  // `completed` is reached only through `approve <EP> final-assembly`, which
  // requires the QA approval plus a rendered final master.
  state.status = "completed";
  state.approvals = {
    concept: {approved: true},
    english: {approved: true},
    scenes: {approved: true},
    package: {approved: true},
    qa: {approved: true, approvedAt: "2026-10-04T04:21:23.690Z"},
    finalAssembly: {approved: true, approvedAt: "2026-10-04T06:51:44.410Z"},
  };
  return {...state, ...overrides};
}

// A draft-backed ESSY episode has no projects/<EP>/workflow.json: state.yaml is
// the only authoritative record, which is exactly what broke before this fix.
async function writeDraftEpisode(root, state = draftState()) {
  await writeDraftState(root, state);
  await mkdir(path.join(root, "projects", DRAFT_EPISODE, "source"), {recursive: true});
  await writeFile(
    path.join(root, "projects", DRAFT_EPISODE, "script.md"),
    "# Script\n",
    "utf8",
  );
  await mkdir(path.join(root, "inbox", DRAFT_EPISODE), {recursive: true});
  await writeFile(
    path.join(root, "inbox", DRAFT_EPISODE, "lesson.json"),
    `${JSON.stringify({episode: DRAFT_EPISODE, series: "ESSY"}, null, 2)}\n`,
    "utf8",
  );
  await mkdir(path.join(root, "output", DRAFT_EPISODE), {recursive: true});
  await writeFile(
    path.join(root, "output", DRAFT_EPISODE, `${DRAFT_EPISODE}-final-v1.mp4`),
    "fake-mp4",
  );
  return state;
}

// --- legacy workflow-backed fixture ------------------------------------------

const LESSON = {
  episode: LEGACY_EPISODE,
  series: "LLFC",
  subtype: "default",
  title: "A Legacy Episode",
  language: "en",
  scenes: [{image: "scene01.png", sentences: ["A completed legacy episode."]}],
};

async function writeLegacyEpisode(root, {qa = true} = {}) {
  await mkdir(path.join(root, "inbox", LEGACY_EPISODE), {recursive: true});
  await writeFile(
    path.join(root, "inbox", LEGACY_EPISODE, "lesson.json"),
    `${JSON.stringify(LESSON, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(root, "inbox", LEGACY_EPISODE, "scene01.png"), "png");
  await mkdir(path.join(root, "projects", LEGACY_EPISODE), {recursive: true});
  await writeFile(
    path.join(root, "projects", LEGACY_EPISODE, "manifest.json"),
    `${JSON.stringify({status: "success", validation: {passed: true}}, null, 2)}\n`,
    "utf8",
  );
  await mkdir(path.join(root, "output", LEGACY_EPISODE), {recursive: true});
  await writeFile(
    path.join(root, "output", LEGACY_EPISODE, `${LEGACY_EPISODE}.mp4`),
    "fake-mp4",
  );
  const workflow = createWorkflow({
    id: LEGACY_EPISODE,
    kind: "episode",
    series: "LLFC",
    subtype: "default",
    currentStage: "qa",
    status: "ready",
  });
  workflow.approvals.content = true;
  workflow.approvals.images = true;
  workflow.approvals.qa = qa;
  await writeWorkflow(root, workflow);
  return workflow;
}

test("archive resolves the authoritative record draft-first", async () => {
  const root = await makeRoot();
  try {
    await writeDraftEpisode(root);
    await writeLegacyEpisode(root);
    const draft = await resolveArchiveRecord(root, DRAFT_EPISODE);
    assert.equal(draft.kind, "draft");
    assert.equal(draft.source, `projects/_drafts/${DRAFT_EPISODE}/state.yaml`);
    const legacy = await resolveArchiveRecord(root, LEGACY_EPISODE);
    assert.equal(legacy.kind, "workflow");
    assert.equal(legacy.source, `projects/${LEGACY_EPISODE}/workflow.json`);
    await assert.rejects(() => resolveArchiveRecord(root, "ESSY-0000"), /not found/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a completed draft-backed ESSY episode archives from state.yaml alone", async () => {
  const root = await makeRoot();
  try {
    await writeDraftEpisode(root);
    const archiveRoot = episodeArchiveRoot(root, DRAFT_EPISODE);
    assert.equal(await exists(path.join(root, "projects", DRAFT_EPISODE, "workflow.json")), false);

    const result = await archiveEpisodeRecord({
      factoryRoot: root,
      episode: DRAFT_EPISODE,
      confirmation: "--published",
    });

    assert.equal(result.kind, "draft");
    assert.equal(result.source, `projects/_drafts/${DRAFT_EPISODE}/state.yaml`);

    // inbox, project and output all move; the draft record itself stays.
    assert.equal(await exists(path.join(root, "inbox", DRAFT_EPISODE)), false);
    assert.equal(await exists(path.join(root, "projects", DRAFT_EPISODE)), false);
    assert.equal(await exists(path.join(root, "output", DRAFT_EPISODE)), false);
    assert.equal(await exists(path.join(archiveRoot, "inbox", "lesson.json")), true);
    assert.equal(await exists(path.join(archiveRoot, "project", "script.md")), true);
    assert.equal(
      await exists(path.join(archiveRoot, "output", `${DRAFT_EPISODE}-final-v1.mp4`)),
      true,
    );
    assert.deepEqual(result.moved, ["inbox/", "project/", "output/"]);
    assert.equal(await exists(path.join(root, "projects", "_drafts", DRAFT_EPISODE, "state.yaml")), true);

    const record = await readJson(path.join(archiveRoot, "archive.json"));
    assert.equal(record.episode, DRAFT_EPISODE);
    assert.equal(record.reason, "published");
    assert.deepEqual(record.locations, {inbox: "inbox/", project: "project/", output: "output/"});
    assert.equal(record.stateSource, `projects/_drafts/${DRAFT_EPISODE}/state.yaml`);
    assert.equal(record.archivedAt, result.archivedAt);

    assert.equal(await isEpisodeArchived(root, DRAFT_EPISODE), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a draft-backed archive transitions the draft to archived and records archivedAt", async () => {
  const root = await makeRoot();
  try {
    await writeDraftEpisode(root);
    const result = await archiveEpisodeRecord({
      factoryRoot: root,
      episode: DRAFT_EPISODE,
      confirmation: "--published",
    });
    const state = await readDraftState(root, DRAFT_EPISODE);
    assert.equal(state.status, "archived");
    assert.equal(state.archivedAt, result.archivedAt);
    assert.equal(state.currentStage, "RENDER", "the finishing stage is preserved");
    assert.equal(state.approvals.qa.approved, true);
    assert.equal(state.approvals.finalAssembly.approved, true);
    assert.ok(
      state.history.some(
        (entry) => entry.event === "episode-archived" && entry.reason === "published",
      ),
      "the archive transition is recorded in the authoritative draft history",
    );
    assert.notEqual(
      state.status,
      "completed",
      "archival must not leave a dangling completed draft",
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("an already archived draft cannot be archived twice", async () => {
  const root = await makeRoot();
  try {
    await writeDraftEpisode(root);
    await archiveEpisodeRecord({
      factoryRoot: root,
      episode: DRAFT_EPISODE,
      confirmation: "--published",
    });
    await writeDraftEpisode(root);
    await assert.rejects(
      () =>
        archiveEpisodeRecord({
          factoryRoot: root,
          episode: DRAFT_EPISODE,
          confirmation: "--published",
        }),
      /already archived/,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("archive requires the explicit --published confirmation", async () => {
  const root = await makeRoot();
  try {
    await writeDraftEpisode(root);
    await writeLegacyEpisode(root);
    for (const episode of [DRAFT_EPISODE, LEGACY_EPISODE]) {
      for (const confirmation of [undefined, "--done", "published", ""]) {
        await assert.rejects(
          () => archiveEpisodeRecord({factoryRoot: root, episode, confirmation}),
          /Archive requires explicit publication confirmation/,
        );
      }
    }
    assert.equal(await exists(path.join(root, "projects", DRAFT_EPISODE)), true);
    assert.equal(await exists(path.join(root, "projects", LEGACY_EPISODE)), true);
    assert.equal(await isEpisodeArchived(root, DRAFT_EPISODE), false);
    assert.equal(await isEpisodeArchived(root, LEGACY_EPISODE), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("an incomplete draft is rejected and left untouched", async () => {
  const root = await makeRoot();
  try {
    const pending = draftState({status: "in_progress"});
    pending.approvals.qa = {approved: false};
    pending.approvals.finalAssembly = undefined;
    await writeDraftEpisode(root, pending);
    await assert.rejects(
      () =>
        archiveEpisodeRecord({
          factoryRoot: root,
          episode: DRAFT_EPISODE,
          confirmation: "--published",
        }),
      /draft status is "in_progress"/,
    );
    assert.equal(await exists(path.join(root, "projects", DRAFT_EPISODE)), true);
    assert.equal(await exists(path.join(root, "output", DRAFT_EPISODE)), true);
    assert.equal(await isEpisodeArchived(root, DRAFT_EPISODE), false);
    assert.equal((await readDraftState(root, DRAFT_EPISODE)).status, "in_progress");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a completed draft without QA approval is rejected", async () => {
  const root = await makeRoot();
  try {
    const state = draftState();
    state.approvals.qa = {approved: false};
    await writeDraftEpisode(root, state);
    await assert.rejects(
      () =>
        archiveEpisodeRecord({
          factoryRoot: root,
          episode: DRAFT_EPISODE,
          confirmation: "--published",
        }),
      /QA is not approved/,
    );
    assert.equal((await readDraftState(root, DRAFT_EPISODE)).status, "completed");
    assert.equal(await isEpisodeArchived(root, DRAFT_EPISODE), false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a completed, QA-approved draft without final-assembly approval is rejected", async () => {
  const root = await makeRoot();
  try {
    const state = draftState();
    state.approvals.finalAssembly = undefined;
    await writeDraftEpisode(root, state);
    await assert.rejects(
      () =>
        archiveEpisodeRecord({
          factoryRoot: root,
          episode: DRAFT_EPISODE,
          confirmation: "--published",
        }),
      /final assembly is not approved/,
    );
    assert.equal(await exists(path.join(root, "projects", DRAFT_EPISODE)), true);
    assert.equal(await exists(path.join(root, "output", DRAFT_EPISODE)), true);
    assert.equal((await readDraftState(root, DRAFT_EPISODE)).status, "completed");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("draft archive eligibility is derived from the draft lifecycle", async () => {
  assert.deepEqual(draftArchiveBlockers(draftState()), []);
  assert.deepEqual(
    draftArchiveBlockers(draftState({status: "final_assembly_pending"})),
    ['draft status is "final_assembly_pending"'],
  );
  assert.deepEqual(draftArchiveBlockers(draftState({status: "archived"})), [
    "the draft is already archived",
  ]);
  assert.deepEqual(draftArchiveBlockers(undefined), [
    'draft status is "unknown"',
    "QA is not approved",
    "final assembly is not approved",
  ]);
});

test("legacy workflow-backed episodes still archive exactly as before", async () => {
  const root = await makeRoot();
  try {
    await writeLegacyEpisode(root);
    const archiveRoot = episodeArchiveRoot(root, LEGACY_EPISODE);
    const result = await archiveEpisodeRecord({
      factoryRoot: root,
      episode: LEGACY_EPISODE,
      confirmation: "--published",
    });
    assert.equal(result.kind, "workflow");

    assert.equal(await exists(path.join(root, "inbox", LEGACY_EPISODE)), false);
    assert.equal(await exists(path.join(root, "projects", LEGACY_EPISODE, "workflow.json")), false);
    assert.equal(await exists(path.join(root, "output", LEGACY_EPISODE)), false);
    assert.equal(await exists(path.join(archiveRoot, "inbox", "lesson.json")), true);
    assert.equal(await exists(path.join(archiveRoot, "project", "manifest.json")), true);
    assert.equal(await exists(path.join(archiveRoot, "output", `${LEGACY_EPISODE}.mp4`)), true);

    const record = await readJson(path.join(archiveRoot, "archive.json"));
    assert.equal(record.episode, LEGACY_EPISODE);
    assert.equal(record.reason, "published");
    assert.deepEqual(record.locations, {inbox: "inbox/", project: "project/", output: "output/"});
    assert.equal(record.archivedAt, result.archivedAt);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a legacy archive marks the episode workflow archived", async () => {
  const root = await makeRoot();
  try {
    await writeLegacyEpisode(root);
    const result = await archiveEpisodeRecord({
      factoryRoot: root,
      episode: LEGACY_EPISODE,
      confirmation: "--published",
    });
    const archived = await readJson(
      path.join(episodeArchiveRoot(root, LEGACY_EPISODE), "project", "workflow.json"),
    );
    assert.equal(archived.status, "archived");
    assert.equal(archived.currentStage, "archived");
    assert.equal(archived.archivedAt, result.archivedAt);
    assert.equal(archived.nextAction, "Archived after publication confirmation.");
    assert.ok(archived.history.some((entry) => entry.event === "episode-archived"));
    assert.equal(await readWorkflow(root, LEGACY_EPISODE), null);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a legacy episode without QA approval is rejected", async () => {
  const root = await makeRoot();
  try {
    await writeLegacyEpisode(root, {qa: false});
    await assert.rejects(
      () =>
        archiveEpisodeRecord({
          factoryRoot: root,
          episode: LEGACY_EPISODE,
          confirmation: "--published",
        }),
      /Only a completed, QA-approved episode can be archived/,
    );
    assert.equal(await exists(path.join(root, "inbox", LEGACY_EPISODE)), true);
    assert.equal(await exists(path.join(root, "output", LEGACY_EPISODE)), true);
    assert.equal(await isEpisodeArchived(root, LEGACY_EPISODE), false);
    const workflow = await readWorkflow(root, LEGACY_EPISODE);
    assert.equal(workflow.currentStage, "qa", "the gates still hold the episode at QA");
    assert.equal(workflow.status, "ready");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("legacy archive eligibility keeps the refreshed, gate-derived status", () => {
  assert.deepEqual(
    workflowArchiveBlockers({
      status: "completed",
      currentStage: "completed",
      approvals: {qa: true},
    }),
    [],
  );
  assert.deepEqual(
    workflowArchiveBlockers({
      status: "ready",
      currentStage: "qa",
      approvals: {qa: false},
    }),
    ['workflow status is "ready"', "QA is not approved"],
  );
  assert.deepEqual(
    workflowArchiveBlockers({
      status: "archived",
      currentStage: "archived",
      approvals: {qa: true},
    }),
    ["the episode workflow is already archived"],
  );
});

test("a failed archive commit rolls back the moves and the draft transition", async () => {
  const root = await makeRoot();
  try {
    await writeDraftEpisode(root);
    // archive.json exists but is a directory: not a readable archive record, so
    // every pre-flight check passes and the failure only happens at the final
    // commit step, after the working directories were already moved.
    const archiveRoot = episodeArchiveRoot(root, DRAFT_EPISODE);
    await mkdir(path.join(archiveRoot, "archive.json"), {recursive: true});

    await assert.rejects(
      () =>
        archiveEpisodeRecord({
          factoryRoot: root,
          episode: DRAFT_EPISODE,
          confirmation: "--published",
        }),
      /Archive of ESSY-9005 failed/,
    );

    // Everything is back in place and nothing claims the episode is archived.
    assert.equal(await exists(path.join(root, "inbox", DRAFT_EPISODE, "lesson.json")), true);
    assert.equal(await exists(path.join(root, "projects", DRAFT_EPISODE, "script.md")), true);
    assert.equal(await exists(path.join(root, "output", DRAFT_EPISODE)), true);
    assert.equal(await exists(path.join(archiveRoot, "project")), false);
    assert.equal(await exists(path.join(archiveRoot, "inbox")), false);
    assert.equal(await exists(path.join(archiveRoot, "output")), false);
    const state = await readDraftState(root, DRAFT_EPISODE);
    assert.equal(state.status, "completed");
    assert.equal(state.archivedAt, undefined);
    assert.equal(
      state.history.some((entry) => entry.event === "episode-archived"),
      false,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("an existing archive target is refused instead of overwritten", async () => {
  const root = await makeRoot();
  try {
    await writeDraftEpisode(root);
    const archiveRoot = episodeArchiveRoot(root, DRAFT_EPISODE);
    await mkdir(path.join(archiveRoot, "project"), {recursive: true});
    await writeFile(path.join(archiveRoot, "project", "leftover.txt"), "old", "utf8");
    await assert.rejects(
      () =>
        archiveEpisodeRecord({
          factoryRoot: root,
          episode: DRAFT_EPISODE,
          confirmation: "--published",
        }),
      /Archive target already exists/,
    );
    assert.equal(await exists(path.join(root, "projects", DRAFT_EPISODE)), true);
    assert.equal((await readDraftState(root, DRAFT_EPISODE)).status, "completed");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});