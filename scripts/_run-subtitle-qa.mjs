import {buildSubtitleTimeline} from "./_build-subtitle-timeline.mjs";

const report = (await buildSubtitleTimeline({root: process.cwd(), episode: "ESSY-0002"})).report;
console.log(JSON.stringify({
  total: report.totalCueCount,
  overlapsBefore: report.overlapCountBeforeFix,
  overlapsAfter: report.overlapCount,
  zeroOrNegative: report.zeroNegativeDurationCount,
  over2Lines: report.cuesExceeding2Lines,
  minDur: report.minimumCueDurationSec,
  maxDur: report.maximumCueDurationSec,
  passed: report.passed,
}, null, 1));
console.log("N004/N005 boundary:", JSON.stringify(
  report.narrationBlockBoundaries.filter((b) => /004|005/.test(b.boundary)),
));
