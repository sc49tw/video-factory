// SHARED SUBTITLE CONFIGURATION (all episodes, default ESSY pipeline).
//
// Single source of truth for subtitle segmentation limits, QA thresholds and
// burn-in style defaults. Episode-level overrides are possible by passing a
// partial config into buildSubtitleTimeline()/render, but a normal ESSY
// episode requires NO override.
//
// IMPORTANT: render scripts must import these values — never re-declare
// font sizes, margins, or segmentation limits locally.

export const SUBTITLE_CONFIG = Object.freeze({
  // ---- Line fitting (approved defaults, do not change without re-QA) ----
  MAX_CHARS: 44, // max characters per rendered line
  MAX_LINES: 2, // max rendered lines per cue

  // ---- Generated-child-cue QA thresholds ----
  MIN_GENERATED_WORDS: 3, // a generated child must not be a 1-word orphan; 2-word children fail QA
  MIN_GENERATED_CHARS: 12, // generated children shorter than this are flagged
  MIN_GENERATED_DURATION_MS: 700, // generated children shorter than this are flagged

  // ---- Overlap normalization ----
  OVERLAP_GAP_MS: 1, // deterministic guard gap clamped between consecutive cues

  // ---- Word-boundary timing (authoritative fine-grained subtitle timing) ----
  // Per-block artifacts: projects/<EP>/temp/<sentenceId>.words.json
  // (edge-tts WordBoundary offsets; see scripts/oneoff/generate-word-timing.py).
  // REQUIRE_WORD_TIMING: when true, any block without word timing FAILS QA.
  // When false (default), fallback blocks are clearly reported as WARN.
  REQUIRE_WORD_TIMING: false,

  // ---- Presentation policy (display vs speech timing) ----
  // Speech timing (speechStartSec/speechEndSec from word boundaries) is the
  // authoritative record and is never modified by these values. They only
  // shift the DISPLAYED cue for lead-in/lead-out presentation policy.
  PRESENTATION_LEAD_MS: 0,
  PRESENTATION_LINGER_MS: 0,

  // ---- Burn-in style defaults (540p review proxy; scaled from 1080 design) ----
  STYLE: Object.freeze({
    FONT_NAME: "Arial",
    FONT_SIZE: 20, // 540p = half of the 1080 design's 36
    OUTLINE: 1.0,
    SHADOW: 0.8,
    ALIGNMENT: 2, // bottom-center (ASS alignment)
    MARGIN_V: 48, // lower safe area at 540p (1080 design: 96)
    MARGIN_LR: 40,
    PRIMARY_COLOUR: "&H00FFFFFF",
    OUTLINE_COLOUR: "&H008C0000",
    BACK_COLOUR: "&H96000000",
  }),
});

// Shallow-merge episode-level overrides over the shared defaults.
// Unknown override keys are ignored to keep configs forward-compatible.
export function resolveSubtitleConfig(overrides = {}) {
  const {STYLE: styleOverrides, ...rest} = overrides ?? {};
  return {
    ...SUBTITLE_CONFIG,
    ...Object.fromEntries(
      Object.entries(rest).filter(([k]) => k in SUBTITLE_CONFIG),
    ),
    STYLE: {...SUBTITLE_CONFIG.STYLE, ...(styleOverrides ?? {})},
  };
}
