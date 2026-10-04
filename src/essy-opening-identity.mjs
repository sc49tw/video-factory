import {readFileSync} from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import {ESSY_SERIES_IDENTITY} from "../scripts/essay-identity-config.mjs";

// ESSY Opening Identity validation — canonical metadata for the opening
// identity reveal (series title + episode title after the hook, over
// continuing footage). See contracts/essy-opening-identity.schema.json.

const schema = JSON.parse(
  readFileSync(
    new URL("../contracts/essy-opening-identity.schema.json", import.meta.url),
    "utf8",
  ),
);
const validateSchema = new Ajv2020({allErrors: true, strict: false}).compile(schema);

export function validateEssyOpeningIdentity(value, expected = {}) {
  if (!validateSchema(value)) {
    const details = validateSchema.errors
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`ESSY openingIdentity validation failed: ${details}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ESSY openingIdentity must be a JSON object.");
  }
  for (const field of ["seriesTitle", "episodeTitle", "timing"]) {
    if (!value[field]) {
      throw new Error(`ESSY openingIdentity requires "${field}".`);
    }
  }
  if (typeof value.seriesTitle !== "string" || !value.seriesTitle.trim()) {
    throw new Error('ESSY openingIdentity "seriesTitle" must be a non-empty string.');
  }
  if (typeof value.episodeTitle !== "string" || !value.episodeTitle.trim()) {
    throw new Error('ESSY openingIdentity "episodeTitle" must be a non-empty string.');
  }
  if (typeof value.timing !== "object" || value.timing === null) {
    throw new Error('ESSY openingIdentity "timing" must be an object.');
  }
  if (typeof value.timing.startSec !== "number" || value.timing.startSec < 0) {
    throw new Error('ESSY openingIdentity "timing.startSec" must be a non-negative number.');
  }
  if (typeof value.timing.durationSec !== "number" || value.timing.durationSec <= 0) {
    throw new Error('ESSY openingIdentity "timing.durationSec" must be a positive number.');
  }

  // Cross-field validation: seriesTitle should match the canonical series title
  // unless there's an explicit editorial reason to override.
  const expectedSeries = ESSY_SERIES_IDENTITY.seriesTitle;
  if (value.seriesTitle.trim().toUpperCase() !== expectedSeries.toUpperCase()) {
    // Allow override but log a warning — this is unusual
    console.warn(
      `ESSY openingIdentity seriesTitle "${value.seriesTitle}" differs from canonical "${expectedSeries}".`,
    );
  }

  return value;
}

export function normalizeOpeningIdentity(value) {
  if (!value) return null;
  return {
    seriesTitle: String(value.seriesTitle ?? "").trim(),
    episodeTitle: String(value.episodeTitle ?? "").trim(),
    timing: {
      startSec: Number(value.timing?.startSec ?? 0),
      durationSec: Number(value.timing?.durationSec ?? 4),
    },
    presentation: value.presentation ?? {mode: "sequential", seriesTitleFirst: true},
    narrationSuppression: value.narrationSuppression ?? {enabled: true},
    subtitleSuppression: value.subtitleSuppression ?? {enabled: true},
  };
}
