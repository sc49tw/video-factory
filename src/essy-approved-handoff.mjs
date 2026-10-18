import {createHash} from 'node:crypto';
import {parseEssyNarrationBlocks} from './draft-workflow.mjs';

const near = (a, b, tolerance = 0.002) => Math.abs(a - b) <= tolerance;
const round = n => Math.round(n * 1000) / 1000;
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const indexed = (items, key, label) => {
  ensure(Array.isArray(items), `${label} missing`);
  const map = new Map(items.map(item => [item[key], item]));
  ensure(map.size === items.length, `Duplicate ${label}`);
  return map;
};

// Transform recorded, validated slot windows directly; never distribute or
// infer shot durations. Files and hashes are verified by the calling CLI.
export function buildApprovedEssyHandoff({episode, state, pkg, script, manifest, storyboard, selection, assetMap, provenance, assetsValidation}) {
  ensure(state?.draftId === episode && state.currentStage === 'RENDER' && state.approvals?.package?.approved === true, 'Approved PACKAGE and RENDER state required');
  ensure(pkg?.draftId === episode && manifest?.episode === episode && storyboard?.episodeId === episode && selection?.episode === episode, 'Episode identity mismatch');
  const blocks = parseEssyNarrationBlocks(script);
  ensure(blocks.length === manifest.audio?.length && blocks.length === storyboard.blocks?.length && blocks.length === pkg.narration?.blockCount, 'Narration block count mismatch');
  ensure(assetsValidation?.draftId === episode && assetsValidation.expectedAssets === assetsValidation.validatedAssets && Object.values(assetsValidation.validation ?? {}).length > 0 && Object.values(assetsValidation.validation).every(v => v === 'pass'), 'ASSETS validation missing or failed');
  const slots = indexed(selection.slots, 'slotId', 'selected slots');
  const approved = indexed(assetMap.items, 'slotId', 'approved slots');
  const downloaded = indexed(provenance.items, 'slotId', 'provenance slots');
  const boardIds = storyboard.blocks.flatMap(block => block.slots.map(slot => slot.slotId));
  ensure(new Set(boardIds).size === boardIds.length && boardIds.length === pkg.storyboard?.slotCount && boardIds.length === pkg.approvedAssets?.count && boardIds.length === assetsValidation.expectedAssets && slots.size === boardIds.length && approved.size === boardIds.length && downloaded.size === boardIds.length, 'Slot count or uniqueness mismatch');
  let cursor = 0;
  const timelineBlocks = [], shots = [], sections = [];
  for (const [i, block] of blocks.entries()) {
    const board = storyboard.blocks[i], audio = manifest.audio[i];
    ensure(block.id === board.narrationId && audio.blockId?.toUpperCase() === block.id && audio.id === `sentence-${block.id.slice(1)}`, `Block identity mismatch: ${block.id}`);
    const text = block.text.replace(/\s+/g, ' ').trim();
    ensure(createHash('sha256').update(text).digest('hex') === audio.textSha256, `Narration hash mismatch: ${block.id}`);
    ensure(Number.isFinite(audio.durationSec) && audio.durationSec > 0 && near(board.windowSec[0], cursor) && near(board.windowSec[1], cursor + audio.durationSec), `Narration window mismatch: ${block.id}`);
    const start = round(cursor), end = round(cursor + audio.durationSec);
    const blockShots = [];
    let position = start;
    for (const slot of board.slots) {
      const s = slots.get(slot.slotId), a = approved.get(slot.slotId), p = downloaded.get(slot.slotId);
      ensure(s && a && p && s.assetId === a.assetId && p.id === a.assetId && a.narrationId === block.id && a.editorialStatus === 'human-approved', `Asset identity mismatch: ${slot.slotId}`);
      ensure(Number.isFinite(s.proposedStartSec) && Number.isFinite(s.proposedDurationSec) && s.proposedDurationSec > 0 && near(s.proposedStartSec, position) && near(p.slotDurationSec, s.proposedDurationSec), `Slot window mismatch: ${slot.slotId}`);
      const inPointSec = Number(a.inPointSec ?? 0);
      ensure(p.mediaType === a.mediaType && p.mediaType === 'video' && Number.isFinite(p.durationSec) && p.durationSec + 0.001 >= inPointSec + s.proposedDurationSec && p.localPath && /^[a-f0-9]{64}$/.test(p.sha256 ?? ''), `Invalid production source: ${slot.slotId}`);
      const absStart = s.proposedStartSec, absEnd = round(absStart + s.proposedDurationSec);
      const shot = {index: shots.length, blockId: audio.id, slotId: slot.slotId, mediaType: p.mediaType, sourcePath: p.localPath, sourceDurationSec: p.durationSec, inPointSec, stillMotion: a.stillMotion ?? null, renderDurationSec: s.proposedDurationSec, speechEndSec: round(absEnd - start), startSec: round(absStart - start), endSec: round(absEnd - start), trailingHoldSec: 0, absoluteStartSec: absStart, absoluteEndSec: absEnd, assetId: a.assetId, sourceSha256: p.sha256};
      blockShots.push(shot); shots.push(shot); position = absEnd;
    }
    ensure(near(position, end), `Slots do not cover ${block.id}`);
    timelineBlocks.push({sentenceId: audio.id, startSec: start, endSec: end, audioDurationSec: audio.durationSec, pauseAfterSec: 0, trailingHoldSec: 0, trimmedSec: 0, durationSec: audio.durationSec, cues: [], shots: blockShots});
    sections.push({id: block.id.toLowerCase(), heading: block.id, narration: [{id: block.id.toLowerCase(), text, pauseAfterSec: 0}]});
    cursor += audio.durationSec;
  }
  ensure(near(cursor, storyboard.targetDurationSec) && near(cursor, selection.narrationDurationSec), 'Episode duration mismatch');
  return {lesson: {schemaVersion:'1.0', episode, series:'ESSY', subtype:'essay', title:pkg.title, language:pkg.language, renderMode:'essay-narration', voice:manifest.tts, sections}, timeline: {schemaVersion:'1.0', episode, strategy:'real-asset-sourced', plannedDurationSec:round(cursor), blocks:timelineBlocks, shots}};
}
