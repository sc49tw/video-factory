// Delivery insertion: keep source narration/VTT timing intact within each block.
export function planOpeningInsertion(identity, timeline) {
  if (!identity) return null;
  const {startSec, durationSec} = identity.timing ?? {};
  if (!(startSec > 0 && durationSec > 0 && Number.isFinite(startSec + durationSec))) throw new Error('Invalid opening timing');
  const hook = timeline.blocks[0];
  if (Math.abs(hook.endSec - startSec) > 0.001) throw new Error('Identity must follow the complete hook');
  const shot = hook.shots.at(-1);
  const sourceDuration = startSec - shot.absoluteStartSec + durationSec;
  if (shot.mediaType !== 'video' || sourceDuration > shot.sourceDurationSec) throw new Error('Insufficient approved moving footage for identity');
  const sequential = identity.presentation?.mode !== 'simultaneous';
  const entries = [
    {kind: 'channel', text: identity.seriesTitle},
    {kind: 'episode', text: identity.episodeTitle},
  ];
  if (identity.presentation?.seriesTitleFirst === false) entries.reverse();
  return {startSec, durationSec, sourceDuration, shot, cards: entries.map((c, i) => ({
    ...c, startSec: startSec + (sequential ? i * durationSec / 2 : 0),
    endSec: startSec + (sequential ? (i + 1) * durationSec / 2 : durationSec),
    fadeInDurSec: 0.35, fadeOutDurSec: 0.35,
  }))};
}
