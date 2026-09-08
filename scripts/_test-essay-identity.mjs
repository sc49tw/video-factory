// Regression tests for the shared ESSY series-identity contract.
// Run: pnpm test:essay-identity
//
// Covers:
//  1. opening contains seriesTitle
//  2. opening contains episodeTitle
//  3. ending contains seriesTitle
//  4. ending does NOT substitute the internal project ID
//  5. ESSY-0002 opening text is exactly the canonical strings
//  6. ESSY-0002 ending is exactly the series title
//  7. the identity configuration is episode-agnostic
import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  ESSY_SERIES_IDENTITY,
  buildOpeningTitleFilters,
  resolveEndingCardText,
  resolveEssayIdentity,
} from "./essay-identity-config.mjs";

const factoryRoot = process.cwd();
const SERIES = ESSY_SERIES_IDENTITY.seriesTitle;
const FONT = "fonts/arial.ttf";

const assemblies = {
  "ESSY-0001": JSON.parse(
    await readFile(path.join(factoryRoot, "projects", "ESSY-0001", "final-assembly.json"), "utf8"),
  ),
  "ESSY-0002": JSON.parse(
    await readFile(path.join(factoryRoot, "projects", "ESSY-0002", "final-assembly.json"), "utf8"),
  ),
};

function openingFiltersFor(episode) {
  const identity = resolveEssayIdentity({finalAssembly: assemblies[episode]});
  return buildOpeningTitleFilters({
    seriesTitle: identity.seriesTitle,
    episodeTitle: identity.episodeTitle,
    timing: assemblies[episode].title,
    fontPath: FONT,
  });
}

test("1+2: opening filter contains seriesTitle (dominant, first) then episodeTitle (secondary)", () => {
  for (const episode of Object.keys(assemblies)) {
    const filters = openingFiltersFor(episode);
    const identity = resolveEssayIdentity({finalAssembly: assemblies[episode]});
    assert.ok(filters.includes(identity.seriesTitle), `${episode}: opening contains seriesTitle`);
    assert.ok(filters.includes(identity.episodeTitle), `${episode}: opening contains episodeTitle`);
    // Hierarchy: seriesTitle is the DOMINANT upper line — drawn first, fontsize 64.
    const seriesIdx = filters.indexOf(identity.seriesTitle);
    const episodeIdx = filters.indexOf(identity.episodeTitle);
    assert.ok(seriesIdx < episodeIdx, `${episode}: seriesTitle drawn before episodeTitle`);
    const seriesPart = filters.slice(0, episodeIdx);
    assert.match(seriesPart, /fontsize=64/, `${episode}: seriesTitle uses dominant fontsize=64`);
    assert.match(filters.slice(episodeIdx), /fontsize=40/, `${episode}: episodeTitle uses secondary fontsize=40`);
  }
});

test("3+4: ending card is the seriesTitle, never the internal project ID", () => {
  for (const episode of Object.keys(assemblies)) {
    const endingText = resolveEndingCardText({finalAssembly: assemblies[episode]});
    assert.equal(endingText, SERIES, `${episode}: ending card equals seriesTitle`);
    assert.notEqual(endingText, episode, `${episode}: ending card is not the episode ID`);
    assert.doesNotMatch(endingText, /^ESSY$/, `${episode}: ending card is not the internal label "ESSY"`);
  }
});

test("5: ESSY-0002 opening shows the exact canonical strings", () => {
  const identity = resolveEssayIdentity({finalAssembly: assemblies["ESSY-0002"]});
  assert.equal(identity.seriesTitle, "A SECOND LOOK AT LIFE");
  assert.equal(identity.episodeTitle, "When the Future Suddenly Becomes Visible");
  const filters = openingFiltersFor("ESSY-0002");
  assert.ok(filters.includes("A SECOND LOOK AT LIFE"));
  assert.ok(filters.includes("When the Future Suddenly Becomes Visible"));
});

test("5b: legacy ESSY-0002 mainTitle typo cannot leak into the opening", () => {
  // The v1 regression: "A second look at life" (wrong case) was the secondary
  // line and the episode title was dominant. The resolver must reject any
  // candidate equal (case-insensitive) to the series title.
  const legacy = {
    title: {
      mainTitle: "A second look at life",
      text: "When the Future Suddenly Becomes Visible",
    },
  };
  const identity = resolveEssayIdentity({finalAssembly: legacy});
  assert.equal(identity.seriesTitle, "A SECOND LOOK AT LIFE");
  assert.equal(identity.episodeTitle, "When the Future Suddenly Becomes Visible");
});

test("5c: v1 endCard.text 'ESSY' override is ignored, not propagated", () => {
  const legacy = {title: {episodeTitle: "X"}, endCard: {text: "ESSY"}};
  const identity = resolveEssayIdentity({finalAssembly: legacy});
  assert.equal(identity.ignoredEndCardOverride, "ESSY");
  assert.equal(resolveEndingCardText({finalAssembly: legacy}), SERIES);
});

test("6: ESSY-0002 ending card is exactly the series title", () => {
  const endingText = resolveEndingCardText({finalAssembly: assemblies["ESSY-0002"]});
  assert.equal(endingText, "A SECOND LOOK AT LIFE");
});

test("7: identity configuration is episode-agnostic", async () => {
  const configSource = await readFile(
    path.join(factoryRoot, "scripts", "essay-identity-config.mjs"),
    "utf8",
  );
  // No episode IDs in the shared identity definition.
  assert.doesNotMatch(configSource, /ESSY-\d{4}/);
  // The series title is defined exactly once across the whole repository's
  // episode configurations (removed from final-assembly.json files).
  for (const episode of Object.keys(assemblies)) {
    assert.ok(
      !assemblies[episode].title?.text && !assemblies[episode].title?.subtitle && !assemblies[episode].title?.mainTitle,
      `${episode}: no per-episode duplicate of the series title in title block`,
    );
    assert.ok(
      assemblies[episode].endCard?.source === "seriesTitle",
      `${episode}: endCard sources the shared seriesTitle`,
    );
  }
  // Canonical series title appears exactly once in the shared config.
  const occurrences = configSource.split(SERIES).length - 1;
  assert.equal(occurrences, 1, "seriesTitle defined exactly once in the shared config");
});