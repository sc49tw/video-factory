// Regression tests for the ESSY WRITE -> PREPARE -> DIRECT draft workflow
// contract (Runbook 5-phase mapping, ESSY-0004+).
//
// Run: pnpm test:workflow-essy
//
// Canonical mapping under test:
//   WRITE   = draft ENGLISH   (approved from projects/<EP>/script.md, not script.yaml)
//   PREPARE = draft PREPARE   (ESSY-only, no human approval; deterministic
//                              machine completion via recordPrepareComplete)
//   DIRECT  = draft STORYBOARD(ESSY block/slot semantics, valid only after
//                              PREPARE completion)
//   BUILD   = PACKAGE -> ASSETS -> RENDER (unchanged)
// Non-ESSY series keep the legacy ENGLISH -> STORYBOARD transition and LLFC
// scene validation exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {
  allowedRollbackTargets,
  approveDraftStage,
  assertEssyEnglishArtifact,
  createDraftState,
  DRAFT_STAGES,
  nextStageForSeries,
  parseEssyNarrationBlocks,
  readDraftState,
  recordPrepareComplete,
  rollbackDraft,
  submitStageArtifact,
  validateStageArtifact,
  writeDraftState,
} from "../src/draft-workflow.mjs";
import {buildStagePrompt} from "../src/stage-prompt.mjs";

const SCRIPT_MD = [
  "# Who Am I Beyond My Roles?",
  "",
  "## N001 — Opening question",
  "",
  "What if the roles you carry are not the whole of you?",
  "",
  "## N002 — Second movement",
  "",
  "A quieter life begins with a quieter question.",
].join("\n");

const WORDS_ARTIFACT = {
  schemaVersion: "1.0",
  timingSource: "edge-tts-word-boundary",
  cacheIdentity: {
    textSha256: "aa".repeat(32),
    matchesManifest: true,
    audioDurationSec: 3.2,
    tts: {voice: "en-GB-RyanNeural", rate: "-12%", pitch: "+0Hz", volume: "+0%"},
  },
  validation: {wordCount: 8, lastWordEndSec: 2.9, fitsAudioDuration: true},
  words: [{text: "What", startSec: 0.1, endSec: 0.4}],
};

async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), "essy-workflow-"));
}

function essyState(overrides = {}) {
  return {
    ...createDraftState({draftId: "ESSY-T1", series: "ESSY", subtype: "essay"}),
    currentStage: "ENGLISH",
    status: "needs_approval",
    approvals: {
      concept: {approved: true},
      english: {approved: false},
      scenes: {approved: false},
      package: {approved: false},
    },
    artifacts: {
      request: "request.yaml",
      script: "script.md",
      titles: "titles.json",
      compressionReview: "compression-review.md",
    },
    ...overrides,
  };
}

async function materializeWrite(factoryRoot) {
  const episodeDir = path.join(factoryRoot, "projects", "ESSY-T1");
  await mkdir(episodeDir, {recursive: true});
  await writeFile(path.join(episodeDir, "script.md"), `${SCRIPT_MD}\n`, "utf8");
  await writeFile(
    path.join(episodeDir, "titles.json"),
    `${JSON.stringify({seriesTitle: "A Second Look at Life"})}\n`,
    "utf8",
  );
  await writeFile(
    path.join(episodeDir, "compression-review.md"),
    "# Compression review\n",
    "utf8",
  );
}

async function materializePrepareTiming(factoryRoot, {episodeId = "ESSY-T1"} = {}) {
  const episodeDir = path.join(factoryRoot, "projects", episodeId);
  await mkdir(path.join(episodeDir, "audio"), {recursive: true});
  await mkdir(path.join(episodeDir, "temp"), {recursive: true});
  await writeFile(path.join(episodeDir, "audio", "sentence-001.mp3"), "fake-mp3");
  await writeFile(path.join(episodeDir, "temp", "sentence-001.vtt"), "WEBVTT\n");
  await writeFile(
    path.join(episodeDir, "temp", "sentence-001.words.json"),
    `${JSON.stringify(WORDS_ARTIFACT, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(episodeDir, "manifest.json"),
    `${JSON.stringify(
      {
        audio: [
          {
            id: "sentence-001",
            path: path
              .relative(factoryRoot, path.join(episodeDir, "audio", "sentence-001.mp3"))
              .replaceAll(path.sep, "/"),
            durationSec: 3.2,
            textSha256: "aa".repeat(32),
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function snapshotFiles(factoryRoot) {
  const workflowPaths = [
    path.join(factoryRoot, "projects", "ESSY-T1", "workflow.json"),
    path.join(factoryRoot, "projects", "_drafts", "ESSY-T1", "state.yaml"),
  ];
  const snapshot = {};
  for (const file of workflowPaths) {
    try {
      snapshot[file] = await readFile(file, "utf8");
    } catch (error) {
      snapshot[file] = error.code === "ENOENT" ? null : error;
    }
  }
  return snapshot;
}

test("ESSY english approval requires script.md and WRITE-side records", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState();
    await writeDraftState(factoryRoot, state);
    await materializeWrite(factoryRoot);
    const summary = await assertEssyEnglishArtifact(factoryRoot, state);
    assert.equal(summary.blockCount, 2);
    assert.deepEqual(summary.blocks, ["N001", "N002"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("ESSY missing script.md fails english approval", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState();
    await writeDraftState(factoryRoot, state);
    await assert.rejects(
      () => approveDraftStage(factoryRoot, state, "english"),
      /script\.md/,
    );
    assert.equal(state.currentStage, "ENGLISH");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("non-ESSY english approval still requires script.yaml", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = createDraftState({draftId: "DRAFT-T1", series: "LLFC", subtype: "default"});
    state.currentStage = "ENGLISH";
    state.status = "needs_approval";
    state.approvals.concept = {approved: true};
    state.artifacts.script = "script.yaml";
    await writeDraftState(factoryRoot, state);
    await assert.rejects(
      () => approveDraftStage(factoryRoot, state, "english"),
      /script\.yaml/,
    );
    await writeFile(
      path.join(factoryRoot, "projects", "_drafts", "DRAFT-T1", "script.yaml"),
      `${JSON.stringify({sentences: ["A sentence."]}, null, 2)}\n`,
      "utf8",
    );
    await approveDraftStage(factoryRoot, state, "english");
    assert.equal(state.currentStage, "STORYBOARD");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("ESSY ENGLISH approval transitions to PREPARE; non-ESSY to STORYBOARD", async () => {
  assert.equal(nextStageForSeries("ENGLISH", "ESSY"), "PREPARE");
  assert.equal(nextStageForSeries("ENGLISH", "LLFC"), "STORYBOARD");
  assert.equal(nextStageForSeries("PREPARE", "ESSY"), "STORYBOARD");

  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState();
    await writeDraftState(factoryRoot, state);
    await materializeWrite(factoryRoot);
    await approveDraftStage(factoryRoot, state, "english");
    assert.equal(state.currentStage, "PREPARE");
    assert.equal(state.status, "in_progress");
    assert.equal(state.approvals.english.approved, true);
    const persisted = await readDraftState(factoryRoot, "ESSY-T1");
    assert.equal(persisted.currentStage, "PREPARE");
    assert.ok(persisted.history.some((entry) => entry.event === "english-approved"));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("PREPARE completion requires valid timing artifacts", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState({currentStage: "PREPARE", status: "in_progress"});
    state.approvals.english = {approved: true};
    await writeDraftState(factoryRoot, state);

    await assert.rejects(() => recordPrepareComplete(factoryRoot, state), /manifest\.json/);

    await mkdir(path.join(factoryRoot, "projects", "ESSY-T1"), {recursive: true});
    await writeFile(
      path.join(factoryRoot, "projects", "ESSY-T1", "manifest.json"),
      `${JSON.stringify({audio: []}, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(() => recordPrepareComplete(factoryRoot, state), /no audio entries/);

    await materializePrepareTiming(factoryRoot);
    await recordPrepareComplete(factoryRoot, state);
    assert.equal(state.currentStage, "STORYBOARD");
    assert.equal(state.status, "in_progress");
    assert.equal(state.prepare.completed, true);
    assert.equal(state.prepare.blockCount, 1);
    assert.equal(state.prepare.totalDurationSec, 3.2);
    const persisted = await readDraftState(factoryRoot, "ESSY-T1");
    assert.ok(persisted.history.some((entry) => entry.event === "prepare-complete"));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("PREPARE completion rejects stale or non-word-boundary timing", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState({currentStage: "PREPARE", status: "in_progress"});
    state.approvals.english = {approved: true};
    await writeDraftState(factoryRoot, state);
    await materializePrepareTiming(factoryRoot);
    const wordsPath = path.join(
      factoryRoot,
      "projects",
      "ESSY-T1",
      "temp",
      "sentence-001.words.json",
    );
    const stale = {
      ...WORDS_ARTIFACT,
      cacheIdentity: {...WORDS_ARTIFACT.cacheIdentity, textSha256: "bb".repeat(32)},
    };
    await writeFile(wordsPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => recordPrepareComplete(factoryRoot, state),
      /textSha256 does not match/,
    );
    const legacy = {...WORDS_ARTIFACT, timingSource: "char-proportional"};
    await writeFile(wordsPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    await assert.rejects(
      () => recordPrepareComplete(factoryRoot, state),
      /edge-tts-word-boundary/,
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("ESSY cannot submit STORYBOARD before PREPARE completion; full path after", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState({currentStage: "PREPARE", status: "in_progress"});
    state.approvals.english = {approved: true};
    await writeDraftState(factoryRoot, state);

    await assert.rejects(
      () =>
        submitStageArtifact(factoryRoot, state, "STORYBOARD", {
          blocks: [{narrationId: "N001", visualArc: "arc", slots: []}],
        }),
      /requires completed PREPARE/,
    );
    await assert.rejects(
      () => approveDraftStage(factoryRoot, state, "scenes"),
      /Cannot approve scenes; current stage is PREPARE/,
    );

    await materializePrepareTiming(factoryRoot);
    await recordPrepareComplete(factoryRoot, state);
    const storyboard = {
      episodeId: "ESSY-T1",
      blocks: [
        {
          narrationId: "N001",
          visualArc: "question -> stillness",
          slots: [
            {
              slotId: "N001-S1",
              editorialFunction: "Open inside a recognizable working life.",
              visualIntent: "An anonymous office crowd at dusk.",
              avoid: ["grinning stock professional"],
            },
          ],
        },
      ],
      sequenceLiteralnessReview: {status: "PASS"},
    };
    await submitStageArtifact(factoryRoot, state, "STORYBOARD", storyboard);
    assert.equal(state.status, "needs_approval");
    await approveDraftStage(factoryRoot, state, "scenes");
    assert.equal(state.currentStage, "PACKAGE");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("ESSY storyboard validation uses ESSY semantics, not LLFC scenes", async () => {
  const state = createDraftState({draftId: "ESSY-T2", series: "ESSY", subtype: "essay"});
  state.prepare = {completed: true, blockCount: 1, totalDurationSec: 3.2};
  const slot = {slotId: "N001-S1", editorialFunction: "f", visualIntent: "v", avoid: ["cliché"]};
  const valid = {
    blocks: [{narrationId: "N001", visualArc: "arc", slots: [slot]}],
    sequenceLiteralnessReview: {status: "PASS"},
  };
  assert.throws(
    () => validateStageArtifact("STORYBOARD", {scenes: [{scene: 1}]}, state),
    /blocks\/slots, not LLFC scenes/,
  );
  assert.throws(
    () =>
      validateStageArtifact(
        "STORYBOARD",
        {blocks: [{narrationId: "N001", visualArc: "arc", slots: [slot]}]},
        state,
      ),
    /sequenceLiteralnessReview/,
  );
  validateStageArtifact("STORYBOARD", valid, state);
});

test("non-ESSY storyboard validation unchanged (LLFC scenes)", () => {
  const state = createDraftState({draftId: "DRAFT-T2", series: "LLFC", subtype: "default"});
  assert.throws(
    () => validateStageArtifact("STORYBOARD", {blocks: []}, state),
    /scenes/,
  );
  assert.throws(
    () =>
      validateStageArtifact(
        "STORYBOARD",
        {
          scenes: [
            {scene: 1, imageDescription: "d", action: "a", environment: "e", sentences: []},
          ],
        },
        state,
      ),
    /sentences/,
  );
  validateStageArtifact(
    "STORYBOARD",
    {
      scenes: [
        {scene: 1, imageDescription: "d", action: "a", environment: "e", sentences: ["s"]},
      ],
    },
    state,
  );
});

test("ESSY rollback STORYBOARD -> PREPARE -> ENGLISH invalidates PREPARE completion", async () => {
  assert.deepEqual(allowedRollbackTargets("STORYBOARD", "ESSY"), ["PREPARE", "ENGLISH", "CONCEPT"]);
  assert.deepEqual(allowedRollbackTargets("STORYBOARD", "LLFC"), ["ENGLISH", "CONCEPT"]);
  assert.deepEqual(allowedRollbackTargets("PREPARE", "ESSY"), ["ENGLISH", "CONCEPT"]);
  assert.ok(DRAFT_STAGES.includes("PREPARE"));

  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState({currentStage: "STORYBOARD", status: "in_progress"});
    state.approvals.english = {approved: true};
    state.prepare = {completed: true, blockCount: 1, totalDurationSec: 3.2};
    await writeDraftState(factoryRoot, state);

    await rollbackDraft(factoryRoot, state, "PREPARE");
    assert.equal(state.currentStage, "PREPARE");
    assert.equal(state.prepare.completed, false);
    assert.equal(state.approvals.english.approved, true);

    await rollbackDraft(factoryRoot, state, "ENGLISH");
    assert.equal(state.currentStage, "ENGLISH");
    assert.equal(state.approvals.english.approved, false);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("ESSY stage prompts carry PREPARE/DIRECT guidance; non-ESSY prompts preserved", () => {
  const essy = createDraftState({draftId: "ESSY-T3", series: "ESSY", subtype: "essay"});
  essy.currentStage = "PREPARE";
  essy.approvals.english = {approved: true};
  const essyPrompt = buildStagePrompt(essy);
  assert.match(essyPrompt, /generate-essy-tts\.py/);
  assert.match(essyPrompt, /WordBoundary/);
  assert.match(essyPrompt, /Do NOT fix shot\/slot counts/);

  essy.currentStage = "STORYBOARD";
  const directPrompt = buildStagePrompt(essy);
  assert.match(directPrompt, /DIRECT/);
  assert.match(directPrompt, /PREPARE timing/);
  assert.match(directPrompt, /editorialFunction/);

  const llfc = createDraftState({draftId: "DRAFT-T3", series: "LLFC", subtype: "default"});
  llfc.currentStage = "ENGLISH";
  assert.match(buildStagePrompt(llfc), /script\.yaml/);
  llfc.currentStage = "STORYBOARD";
  assert.match(buildStagePrompt(llfc), /visually teachable scenes/);
});

test("no competing production workflow.json during the ESSY WRITE/PREPARE/DIRECT path", async () => {
  const root = await makeRoot();
  try {
    const factoryRoot = path.join(root, "factory");
    const state = essyState();
    await writeDraftState(factoryRoot, state);
    await materializeWrite(factoryRoot);
    const before = await snapshotFiles(factoryRoot);
    assert.equal(before[path.join(factoryRoot, "projects", "ESSY-T1", "workflow.json")], null);

    await approveDraftStage(factoryRoot, state, "english");
    const afterApproval = await snapshotFiles(factoryRoot);
    assert.equal(
      afterApproval[path.join(factoryRoot, "projects", "ESSY-T1", "workflow.json")],
      null,
      "ENGLISH -> PREPARE must not create projects/ESSY-T1/workflow.json",
    );

    await materializePrepareTiming(factoryRoot);
    await recordPrepareComplete(factoryRoot, state);
    const afterPrepare = await snapshotFiles(factoryRoot);
    assert.equal(
      afterPrepare[path.join(factoryRoot, "projects", "ESSY-T1", "workflow.json")],
      null,
      "PREPARE completion must not create projects/ESSY-T1/workflow.json",
    );
    const persisted = await readDraftState(factoryRoot, "ESSY-T1");
    assert.equal(persisted.currentStage, "STORYBOARD");
    assert.notEqual(
      afterPrepare[path.join(factoryRoot, "projects", "_drafts", "ESSY-T1", "state.yaml")],
      null,
      "state.yaml remains the authoritative workflow state",
    );
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("parseEssyNarrationBlocks is deterministic", () => {
  const blocks = parseEssyNarrationBlocks(SCRIPT_MD);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].id, "N001");
  assert.match(blocks[0].text, /roles you carry/);
  assert.equal(parseEssyNarrationBlocks("no blocks here").length, 0);
});
