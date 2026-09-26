// ---------------------------------------------------------------------------
// Shared ESSY series-identity configuration — THE ONE authoritative definition.
//
// Viewer-facing series text is NEVER derived from the episode ID, project ID,
// filename ("ESSY") or any internal workflow label. Episodes supply ONLY their
// episodeTitle; the renderer consumes seriesTitle from here.
// ---------------------------------------------------------------------------
import {readFile} from 'node:fs/promises';
import path from 'node:path';

// A visual-only title is not authorization for a standalone pre-roll.
export async function resolveEpisodePreRollTitleCard({root, episode}) {
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(root, 'projects', '_drafts', episode, 'production-package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const card = pkg.packaging?.preRollTitleCard;
  if (!card) return null;
  if (pkg.openingIdentity || pkg.packaging?.coldOpenExperiment) throw new Error('Conflicting opening mechanisms');
  if (!card.text || !(card.durationSec > 0)) throw new Error('Explicit pre-roll requires text and durationSec');
  return card;
}
export function preRollOffsetSec(card) { return card?.durationSec ?? 0; }
export function buildPreRollClipArgs({fontPath, titleCard, width, height, fps, crf = 18, outputPath}) {
  return ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`color=black:s=${width}x${height}:r=${fps}`,
    '-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',String(titleCard.durationSec),
    '-vf',`drawtext=fontfile=${fontPath}:text='${escapeFilterText(titleCard.text).replaceAll("'", '’')}':expansion=none:fontcolor=white:fontsize=${height / 22.5}:x=(w-text_w)/2:y=(h-text_h)/2`,
    '-c:v','libx264','-crf',String(crf),'-pix_fmt','yuv420p','-c:a','aac',outputPath];
}

export const ESSY_SERIES_IDENTITY = Object.freeze({
  seriesId: "ESSY",
  seriesTitle: "A SECOND LOOK AT LIFE",
});

function escapeFilterText(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function normalize(value) {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * Resolve the viewer-facing identity for an episode from its
 * final-assembly.json. Canonical schema is `title.episodeTitle`; legacy
 * layouts (`title.subtitle`, `title.text`) are resolved
 * with back-compat, but any candidate that equals the series title
 * (case-insensitive, e.g. the v1 typo "A second look at life") is
 * rejected so the series title can never be demoted or duplicated.
 */
export function resolveEssayIdentity({finalAssembly}) {
  const title = finalAssembly?.title ?? {};
  const seriesTitle = ESSY_SERIES_IDENTITY.seriesTitle;
  const candidates = [title.episodeTitle, title.subtitle, title.text];
  let episodeTitle = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (normalize(candidate) === normalize(seriesTitle)) continue;
    episodeTitle = String(candidate).trim();
    break;
  }
  if (!episodeTitle) {
    throw new Error(
      `final-assembly.json has no episodeTitle (checked title.episodeTitle/title.subtitle/title.text).`,
    );
  }
  const ignoredEndCardOverride =
    finalAssembly?.endCard?.text != null &&
    normalize(finalAssembly.endCard.text) !== normalize(seriesTitle)
      ? finalAssembly.endCard.text
      : null;
  return {seriesTitle, episodeTitle, ignoredEndCardOverride};
}

/**
 * Ending card text — ALWAYS the series title. Any endCard.text that differs
 * (e.g. an internal label like "ESSY") is deliberately ignored.
 */
export function resolveEndingCardText({finalAssembly}) {
  return resolveEssayIdentity({finalAssembly}).seriesTitle;
}

// ---------------------------------------------------------------------------
// Shared ESSY ending-hold / end-card contract (single authoritative source).
//
// Canonical behavior from the approved final-assembly implementation
// (render-essay-final.mjs renderEndingHold): the ending hold extends the final
// shot, freezes its subtitle-free last frame, and fades the centered series
// title in/out. Both the 1080p final renderer and the 540p review renderer
// MUST consume these helpers so the two paths cannot drift again.
// ---------------------------------------------------------------------------
export const ENDING_CARD_TIMING = Object.freeze({
  fadeInStartSec: 0.4, // hold-relative
  fadeInDurSec: 1.0,
  fadeOutStartSec: 2.8, // hold-relative
  fadeOutDurSec: 1.0,
});

// Alpha expression for the end-card fade, optionally offset by `baseSec`
// (the episode time at which the ending hold starts; 0 for a hold-local
// timeline). With baseSec=0 this is byte-equivalent to the original
// render-essay-final.mjs inline expression.
export function endingCardAlphaExpression(baseSec = 0) {
  const b = Number(baseSec) || 0;
  const t0 = (b + ENDING_CARD_TIMING.fadeInStartSec).toFixed(3);
  const t1 = (b + ENDING_CARD_TIMING.fadeInStartSec + ENDING_CARD_TIMING.fadeInDurSec).toFixed(3);
  const t2 = (b + ENDING_CARD_TIMING.fadeOutStartSec).toFixed(3);
  const t3 = (b + ENDING_CARD_TIMING.fadeOutStartSec + ENDING_CARD_TIMING.fadeOutDurSec).toFixed(3);
  return (
    `'if(lt(t,${t0}),0,if(lt(t,${t1}),(t-${t0})/${ENDING_CARD_TIMING.fadeInDurSec.toFixed(1)},` +
    `if(lt(t,${t2}),1,if(lt(t,${t3}),(${t3}-t)/${ENDING_CARD_TIMING.fadeOutDurSec.toFixed(1)},0))))'`
  );
}

// The shared end-card drawtext filter. `textFile` is a staged UTF-8 text file
// (canonical: the series title written by the renderer), keeping the filter
// free of escaping concerns. `baseSec` shifts the fade to the hold's position
// on a longer timeline (540p review single-pass); 0 for the final renderer's
// hold-local clip.
export function buildEndingCardFilter({fontPath, textFile, fontSize, baseSec = 0}) {
  return (
    `drawtext=fontfile=${fontPath}:textfile=${textFile}:` +
    `expansion=none:fontcolor=white:fontsize=${fontSize}:` +
    `x=(w-text_w)/2:y=(h-text_h)/2:alpha=${endingCardAlphaExpression(baseSec)}`
  );
}

// Resolve the ending spec for an episode. `finalAssembly` is the episode's
// projects/<EP>/final-assembly.json when it exists (authoritative hold
// duration + identity validation); absent it falls back to the canonical
// ESSY defaults (4.0 s hold, series-title card) so the review render can be
// produced before final-assembly decisions are frozen.
export function resolveEndingCardSpec({finalAssembly = null, defaultEndingHoldSec = 4.0} = {}) {
  const endingHoldSec = Number(finalAssembly?.endingHoldSec ?? defaultEndingHoldSec);
  const text = finalAssembly
    ? resolveEndingCardText({finalAssembly})
    : ESSY_SERIES_IDENTITY.seriesTitle;
  return {text, endingHoldSec};
}

/**
 * Opening title drawtext filters (drawn over the first shot, same restrained
 * visual language as the approved ESSY series master):
 *   - seriesTitle  DOMINANT upper line (64 px, y = h*0.26)
 *   - episodeTitle smaller secondary line below (40 px, white@0.88, y = +92)
 * Centered, white, upper-third (never overlaps the bottom subtitle band),
 * shared alpha fade (timing comes from the episode's title block).
 */
export function buildOpeningTitleFilters({seriesTitle, episodeTitle, timing = {}, fontPath}) {
  const fadeInStart = timing.fadeInStartSec ?? 5.0;
  const fadeInDur = timing.fadeInDurSec ?? 0.6;
  const fadeOutStart = timing.fadeOutStartSec ?? 8.0;
  const fadeOutDur = timing.fadeOutDurSec ?? 0.75;
  const alpha =
    `'if(lt(t,${fadeInStart}),0,` +
    `if(lt(t,${(fadeInStart + fadeInDur).toFixed(2)}),(t-${fadeInStart})/${fadeInDur},` +
    `if(lt(t,${fadeOutStart}),1,` +
    `if(lt(t,${(fadeOutStart + fadeOutDur).toFixed(2)}),(${fadeOutStart.toFixed(2)}+${fadeOutDur}-t)/${fadeOutDur},0))))'`;
  const font = escapeFilterText(fontPath);
  return [
    // DOMINANT: series title
    `drawtext=fontfile=${font}:text=${escapeFilterText(seriesTitle)}:` +
      `expansion=none:fontcolor=white:fontsize=64:` +
      `x=(w-text_w)/2:y=h*0.26:alpha=${alpha}`,
    // SECONDARY: episode title (smaller, slightly dimmer, below)
    `drawtext=fontfile=${font}:text=${escapeFilterText(episodeTitle)}:` +
      `expansion=none:fontcolor=white@0.88:fontsize=40:` +
      `x=(w-text_w)/2:y=h*0.26+92:alpha=${alpha}`,
  ].join(",");
}

/** Build a metadata-timed cold-open card for either final-assembly resolution. */
export function buildColdOpenTitleCardFilter({card, fontPath, fontSize}) {
  const start = Number(card.startSec ?? 0);
  const end = Number(card.endSec ?? start);
  const fadeIn = Number(card.fadeInDurSec ?? 0.5);
  const fadeOut = Number(card.fadeOutDurSec ?? 0.4);
  const fadeOutStart = Math.max(end - fadeOut, start);
  const text = escapeFilterText(card.text).replaceAll("'", "\u2019").replaceAll("%", "\\%");
  const alpha =
    `'if(lt(t,${start.toFixed(3)}),0,if(lt(t,${(start + fadeIn).toFixed(3)}),` +
    `(t-${start.toFixed(3)})/${fadeIn.toFixed(3)},if(lt(t,${fadeOutStart.toFixed(3)}),1,` +
    `if(lt(t,${end.toFixed(3)}),(${end.toFixed(3)}-t)/${fadeOut.toFixed(3)},0))))'`;
  return `drawtext=fontfile=${fontPath}:text='${text}':expansion=none:fontcolor=white:` +
    `fontsize=${fontSize}:borderw=1:bordercolor=black@0.6:shadowcolor=black@0.45:shadowx=1:shadowy=1:` +
    `x=(w-text_w)/2:y=h*0.40:alpha=${alpha}`;
}
