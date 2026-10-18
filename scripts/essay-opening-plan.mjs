// Delivery insertion: keep source narration/VTT timing intact within each block.
export function planOpeningInsertion(identity, timeline, boundary = null) {
  if (!identity) return null;
  if (boundary) {
    const nominal = identity.timing.durationSec;
    const before = identity.timing.pauseBeforeIdentitySec ?? 2;
    const after = identity.timing.pauseAfterIdentitySec ?? 1;
    const cardsDuration = nominal - before - after;
    const cut = (boundary.questionMarkerEndSec + boundary.bodyStartSec) / 2;
    const durationSec = nominal - (boundary.bodyStartSec - boundary.questionSpeechEndSec);
    const firstCard = boundary.questionSpeechEndSec + before;
    const shot = (timeline.shots ?? timeline.blocks.flatMap(b => b.shots ?? []))
      .find(s => s.absoluteStartSec <= cut && s.absoluteEndSec > cut);
    if (!shot || !(cardsDuration > 0 && durationSec > 0 && firstCard >= cut && firstCard + cardsDuration <= cut + durationSec)) throw new Error('Opening boundary or requested pauses cannot be represented safely.');
    const cards = [{kind:'channel',text:identity.seriesTitle},{kind:'episode',text:identity.episodeTitle}];
    if (identity.presentation?.seriesTitleFirst === false) cards.reverse();
    const sequential = identity.presentation?.mode !== 'simultaneous';
    return {startSec:cut, durationSec, shot, intraBlock:true, questionCount:boundary.questionCount ?? 3,
      cards:cards.map((card,i)=>({...card,
        startSec:firstCard + (sequential ? i * cardsDuration / 2 : 0), endSec:firstCard + (sequential ? (i + 1) * cardsDuration / 2 : cardsDuration),
        fadeInDurSec:0.35, fadeOutDurSec:0.35}))};
  }
  const {startSec, durationSec} = identity.timing ?? {};
  if (!(startSec > 0 && durationSec > 0 && Number.isFinite(startSec + durationSec))) throw new Error('Invalid opening timing');
  const hook = timeline.blocks[0];
  if (Math.abs(hook.endSec - startSec) > 0.001) throw new Error('Identity must follow the complete hook');
  const shot = hook.shots.at(-1);
  const sourceDuration = startSec - shot.absoluteStartSec + durationSec;
  if (shot.mediaType !== 'video' || sourceDuration > shot.sourceDurationSec) throw new Error('Insufficient approved moving footage for identity');
  const sequential = identity.presentation?.mode !== 'simultaneous';
  const before = Number(identity.timing?.pauseBeforeIdentitySec ?? 0);
  const after = Number(identity.timing?.pauseAfterIdentitySec ?? 0);
  if (!(before >= 0 && after >= 0 && before + after < durationSec)) throw Error('Opening pauses leave no time for identity cards');
  const cardsStart = startSec + before;
  const cardsDuration = durationSec - before - after;
  const entries = [
    {kind: 'channel', text: identity.seriesTitle},
    {kind: 'episode', text: identity.episodeTitle},
  ];
  if (identity.presentation?.seriesTitleFirst === false) entries.reverse();
  return {startSec, durationSec, sourceDuration, shot, cards: entries.map((c, i) => ({
    ...c, startSec: cardsStart + (sequential ? i * cardsDuration / 2 : 0),
    endSec: cardsStart + (sequential ? (i + 1) * cardsDuration / 2 : cardsDuration),
    fadeInDurSec: 0.35, fadeOutDurSec: 0.35,
  }))};
}
