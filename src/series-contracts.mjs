import {validateProductionPackage} from "./production-package.mjs";
import {validateEssyProductionPackage} from "./essy-production-package.mjs";

// Single dispatch layer for series-specific production-package contracts.
// Shared workflow code orchestrates stages; series-specific fields, approval
// prerequisites, and validators live ONLY here — never inline in unrelated
// files, and never as fake fields to satisfy another series' validator.
//
//   LLFC: concepts/characters/scenes/imagePrompt/A2 + DRAFT-* ids; requires
//         concept/english/scenes approvals.
//   ESSY: references canonical artifacts (script, PREPARE manifest, repaired
//         storyboard, approved-slot-asset-map); requires english + scenes
//         approvals and completed PREPARE timing; no CONCEPT gate exists.
//   Any other series: explicit unsupported-series error.

const PACKAGE_CONTRACTS = Object.freeze({
  LLFC: {
    approvals: Object.freeze(["concept", "english", "scenes"]),
    contractPath: "contracts/production-package.schema.json",
  },
  ESSY: {
    approvals: Object.freeze(["english", "scenes"]),
    contractPath: "contracts/essy-production-package.schema.json",
  },
});

function normalizeSeries(series) {
  return String(series ?? "").toUpperCase();
}

export function packageApprovalsForSeries(series) {
  const contract = PACKAGE_CONTRACTS[normalizeSeries(series)];
  if (!contract) {
    throw new Error(
      `Series "${series}" has no production-package contract (supported: ${Object.keys(PACKAGE_CONTRACTS).join(", ")}).`,
    );
  }
  return contract.approvals;
}

export function packageContractPathForSeries(series) {
  const contract = PACKAGE_CONTRACTS[normalizeSeries(series)];
  if (!contract) {
    throw new Error(
      `Series "${series}" has no production-package contract (supported: ${Object.keys(PACKAGE_CONTRACTS).join(", ")}).`,
    );
  }
  return contract.contractPath;
}

export function validatePackageForSeries(series, value, state = {}) {
  const normalized = normalizeSeries(series);
  switch (normalized) {
    case "LLFC": {
      for (const approval of packageApprovalsForSeries(normalized)) {
        if (state.approvals?.[approval]?.approved !== true) {
          throw new Error(`PACKAGE requires approved ${approval}.`);
        }
      }
      return validateProductionPackage(value, {
        draftId: state.draftId,
        series: state.series,
        subtype: state.subtype,
      });
    }
    case "ESSY": {
      for (const approval of packageApprovalsForSeries(normalized)) {
        if (state.approvals?.[approval]?.approved !== true) {
          throw new Error(`PACKAGE requires approved ${approval}.`);
        }
      }
      if (state.prepare?.completed !== true) {
        throw new Error("ESSY PACKAGE requires completed PREPARE timing.");
      }
      return validateEssyProductionPackage(value, {
        draftId: state.draftId,
        series: state.series,
        language: "en",
      });
    }
    default:
      throw new Error(
        `Series "${series}" has no production-package contract (supported: ${Object.keys(PACKAGE_CONTRACTS).join(", ")}).`,
      );
  }
}
