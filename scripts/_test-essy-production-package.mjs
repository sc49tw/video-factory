// Regression tests for the ESSY production-package contract and its optional
// openingIdentity metadata.
//
// Run: pnpm test:essy-package
//
// Contract under test (semantics live in docs/ESSY_SERIES_GRAMMAR.md; the
// single opening algorithm lives in scripts/essay-opening-plan.mjs):
//   - contracts/essy-production-package.schema.json is the ESSY package contract.
//   - openingIdentity is OPTIONAL package metadata (series title + episode title
//     + timing), authored by contracts/essy-opening-identity.schema.json and
//     referenced with $ref ??never duplicated inline.
//   - A package WITHOUT openingIdentity stays valid (identity-free episodes keep
//     validating unchanged, so no approval state is invalidated by the fix).
//   - A malformed openingIdentity fails through the referenced contract.
//   - Unknown ROOT package fields still fail (additionalProperties: false).
//   - The approved ESSY-0004 package (the canonical identity precedent) and the
//     current ESSY-0005 package both validate.
// These tests assert contract behavior only. They never re-derive the opening
// timing rule; scripts/_test-opening-parity.mjs owns that.
import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {validateEssyProductionPackage} from "../src/essy-production-package.mjs";
import {validateEssyOpeningIdentity} from "../src/essy-opening-identity.mjs";
import {validatePackageForSeries} from "../src/series-contracts.mjs";

const factoryRoot = process.cwd();

const PACKAGE_SCHEMA_PATH = path.join(factoryRoot, "contracts", "essy-production-package.schema.json");
const IDENTITY_SCHEMA_PATH = path.join(factoryRoot, "contracts", "essy-opening-identity.schema.json");

const EXPECTED = {draftId: "ESSY-9009", series: "ESSY", language: "en"};

/** Minimal valid ESSY package (no openingIdentity). */
function basePackage() {
  return {
    schemaVersion: "1.0",
    draftId: "ESSY-9009",
    series: "ESSY",
    title: "What Is Still There When I'm Eighty?",
    language: "en",
    narration: {script: "projects/ESSY-9009/script.md", manifest: "projects/ESSY-9009/manifest.json", blockCount: 18},
    storyboard: {path: "projects/_drafts/ESSY-9009/storyboard.yaml", slotCount: 43},
    approvedAssets: {path: "projects/ESSY-9009/sourcing/approved-slot-asset-map.json", count: 43},
  };
}

/** The approved identity shape, mirroring the ESSY-0004 canonical package. */
function openingIdentity() {
  return {
    seriesTitle: "A SECOND LOOK AT LIFE",
    episodeTitle: "What Is Still There When I'm Eighty?",
    timing: {startSec: 14.136, durationSec: 4},
    presentation: {mode: "sequential", seriesTitleFirst: true},
    narrationSuppression: {enabled: true},
    subtitleSuppression: {enabled: true},
  };
}

function withIdentity(identity = openingIdentity()) {
  return {...basePackage(), openingIdentity: identity};
}

function essyState() {
  return {
    draftId: "ESSY-9009",
    series: "ESSY",
    language: "en",
    approvals: {english: {approved: true}, scenes: {approved: true}},
    prepare: {completed: true},
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

// ---------------------------------------------------------------------------
// 1. Contract shape: optional, referenced, never duplicated.
// ---------------------------------------------------------------------------
test("1: openingIdentity is optional, $ref'd, and not duplicated in the package schema", async () => {
  const schema = await readJson(PACKAGE_SCHEMA_PATH);
  assert.deepEqual(
    schema.properties.openingIdentity,
    {$ref: "essy-opening-identity.schema.json"},
    "the package schema must reference the identity contract, never inline a copy",
  );
  assert.equal(
    schema.required.includes("openingIdentity"),
    false,
    "openingIdentity must stay optional at package level",
  );
  assert.deepEqual(
    schema.required,
    ["schemaVersion", "draftId", "series", "title", "language", "narration", "storyboard", "approvedAssets"],
    "the required package field list must be unchanged by the fix",
  );
  assert.equal(schema.additionalProperties, false, "the root package contract must stay closed");
  const identity = await readJson(IDENTITY_SCHEMA_PATH);
  assert.equal(
    identity.$id,
    "contracts/essy-opening-identity.schema.json",
    "the relative $ref resolves against this $id",
  );
  assert.deepEqual(identity.required, ["seriesTitle", "episodeTitle", "timing"]);
  assert.equal(identity.type, "object");
});

// ---------------------------------------------------------------------------
// 2. Identity-free packages stay valid (backward compatibility).
// ---------------------------------------------------------------------------
test("2: a package without openingIdentity remains valid", () => {
  const value = basePackage();
  assert.equal("openingIdentity" in value, false);
  assert.equal(validateEssyProductionPackage(value, EXPECTED), value);
  assert.equal(validatePackageForSeries("ESSY", value, essyState()), value);
});

// ---------------------------------------------------------------------------
// 3. Valid identity metadata passes, including the full draft-stage dispatch.
// ---------------------------------------------------------------------------
test("3: a valid package with openingIdentity passes PACKAGE submission", () => {
  const value = withIdentity();
  assert.equal(validateEssyProductionPackage(value, EXPECTED), value);
  assert.equal(validatePackageForSeries("ESSY", value, essyState()), value);
});

test("3b: the minimal required identity (3 fields) is enough; defaults are not mandatory", () => {
  const value = withIdentity({
    seriesTitle: "A SECOND LOOK AT LIFE",
    episodeTitle: "What Is Still There When I'm Eighty?",
    timing: {startSec: 14.136, durationSec: 4},
  });
  assert.equal(validateEssyProductionPackage(value, EXPECTED), value);
});

// ---------------------------------------------------------------------------
// 4. Malformed identity metadata fails through the referenced contract.
// ---------------------------------------------------------------------------
test("4: malformed openingIdentity fails", () => {
  const cases = [
    ["missing seriesTitle", {seriesTitle: undefined}, /seriesTitle/],
    ["missing episodeTitle", {episodeTitle: undefined}, /episodeTitle/],
    ["missing timing", {timing: undefined}, /timing/],
    ["timing without startSec", {timing: {durationSec: 4}}, /startSec/],
    ["timing without durationSec", {timing: {startSec: 14.136}}, /durationSec/],
    ["zero duration", {timing: {startSec: 14.136, durationSec: 0}}, /durationSec/],
    ["negative start", {timing: {startSec: -1, durationSec: 4}}, /startSec/],
    ["non-numeric start", {timing: {startSec: "14.136", durationSec: 4}}, /startSec/],
    ["empty series title", {seriesTitle: ""}, /seriesTitle/],
    ["whitespace episode title", {episodeTitle: "   "}, /episodeTitle/],
    ["non-string series title", {seriesTitle: 42}, /seriesTitle/],
    ["unknown presentation mode", {presentation: {mode: "cascade"}}, /mode/],
    ["unknown field inside identity", {fadeInDurSec: 0.35}, /additional propert/i],
    ["identity is a bare string", "A SECOND LOOK AT LIFE", /must be object|additional propert/i],
    ["identity is an array", ["A SECOND LOOK AT LIFE"], /must be object|additional propert/i],
  ];
  for (const [name, patch, pattern] of cases) {
    const identity = {...openingIdentity(), ...patch};
    for (const key of Object.keys(identity)) if (identity[key] === undefined) delete identity[key];
    const value = withIdentity(identity);
    assert.throws(() => validateEssyProductionPackage(value, EXPECTED), pattern, name);
    assert.throws(() => validatePackageForSeries("ESSY", value, essyState()), pattern, name);
  }
});

test("4b: the declared identity runtime implementation agrees with the package contract", () => {
  // contracts/essy-opening-identity.schema.json declares
  // x-runtimeValidation.implementation = src/essy-opening-identity.mjs. It must
  // load and accept exactly what the package contract accepts.
  const identity = openingIdentity();
  assert.equal(validateEssyOpeningIdentity(identity), identity);
  for (const patch of [{episodeTitle: "   "}, {timing: {startSec: 14.136, durationSec: 0}}]) {
    assert.throws(() => validateEssyOpeningIdentity({...openingIdentity(), ...patch}));
  }
});

// ---------------------------------------------------------------------------
// 5. The root contract stays closed.
// ---------------------------------------------------------------------------
test("5: unknown root package fields still fail, with and without identity", () => {
  for (const extra of [{packaging: {}}, {opening: {}}, {characters: []}, {openingIdentityExtra: true}]) {
    assert.throws(
      () => validateEssyProductionPackage({...basePackage(), ...extra}, EXPECTED),
      /additional propert/i,
      `root field ${Object.keys(extra)[0]} must be rejected`,
    );
    assert.throws(
      () => validateEssyProductionPackage({...withIdentity(), ...extra}, EXPECTED),
      /additional propert/i,
      `root field ${Object.keys(extra)[0]} must be rejected alongside identity`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Approved real packages validate.
// ---------------------------------------------------------------------------
const real0004 = path.join(factoryRoot, "projects", "_drafts", "ESSY-0004", "production-package.json");
const real0005 = path.join(factoryRoot, "projects", "_drafts", "ESSY-0005", "production-package.json");

test("6: the approved ESSY-0004 canonical package validates with its openingIdentity", {skip: !existsSync(real0004)}, async () => {
  const pkg = await readJson(real0004);
  assert.ok(pkg.openingIdentity, "the approved identity precedent must still be present");
  assert.equal(
    validateEssyProductionPackage(pkg, {draftId: "ESSY-0004", series: "ESSY", language: "en"}),
    pkg,
  );
});

test("7: the current ESSY-0005 package still validates without openingIdentity", {skip: !existsSync(real0005)}, async () => {
  const pkg = await readJson(real0005);
  assert.equal(
    validateEssyProductionPackage(pkg, {draftId: "ESSY-0005", series: "ESSY", language: "en"}),
    pkg,
  );
});
