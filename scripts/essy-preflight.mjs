// Read-only, cheap checks before spending time on an ESSY render.
//
// Review AND final share one opening-identity delivery plan
// (essay-opening-delivery.mjs, built on essay-opening-plan.mjs), so this
// preflight verifies the SAME plan both renderers will consume.
import {readFile, access} from 'node:fs/promises';
import path from 'node:path';
import {buildOpeningDeliveryPlan} from './essay-opening-delivery.mjs';
import * as identity from './essay-identity-config.mjs';
import {buildAssForceStyle} from './subtitle-config.mjs';

const episode = process.argv[2];
const target = process.argv[3] ?? 'review';
if (!episode || !['review','final'].includes(target)) throw new Error('Usage: node scripts/essy-preflight.mjs <EPISODE> [review|final]');
const root = process.cwd();
const json = async file => JSON.parse(await readFile(path.join(root,file),'utf8'));
const pkg = await json(`projects/_drafts/${episode}/production-package.json`);
const timeline = await json(`projects/${episode}/assembly-timeline.json`);
const required = ['buildColdOpenTitleCardFilter','buildEndingCardFilter','buildPreRollClipArgs','preRollOffsetSec','resolveEpisodePreRollTitleCard'];
for (const name of required) if (typeof identity[name] !== 'function') throw new Error(`Missing renderer export: ${name}`);
if (!buildAssForceStyle()) throw new Error('Missing shared subtitle style');
const opening = buildOpeningDeliveryPlan({identity: pkg.openingIdentity, timeline});
for (const block of timeline.blocks) {
  for (const file of [`audio/${block.sentenceId}.mp3`,`temp/${block.sentenceId}.vtt`,`temp/${block.sentenceId}.words.json`]) {
    await access(path.join(root,'projects',episode,file));
  }
}
for (const shot of timeline.shots) await access(path.resolve(root,shot.sourcePath));
// The insertion is INSERTION-ONLY: an openingIdentity episode must not also
// resolve a standalone pre-roll segment (the shared resolver rejects it).
const preRoll = await identity.resolveEpisodePreRollTitleCard({root, episode});
if (opening && preRoll) throw new Error('Conflicting opening mechanisms: openingIdentity + pre-roll');
// Opening timing must fit BOTH the insertion window and the approved source tail.
if (opening) {
  const hook = timeline.shots.find(s => s.slotId === opening.hookSlotId);
  const override = opening.deliveryShotOverrides.get(opening.hookSlotId);
  if (!hook || !override || override.mode !== 'extend-source-tail') throw new Error('Opening insertion has no hook source tail');
  if (override.playbackDurationSec + override.trailingHoldSec > hook.sourceDurationSec + 0.001) {
    throw new Error(`Opening insertion exceeds approved source tail for ${opening.hookSlotId}`);
  }
  if (Math.abs(opening.startSec - timeline.blocks[0].endSec) > 0.001) throw new Error('Opening insertion must follow the complete hook');
}
// FINAL additionally needs the episode's frozen final-assembly decisions and
// the pre-built media those decisions reference (not created by this check).
const finalInputs = [];
if (opening && target === 'final') {
  const decisionsPath = path.join(root, 'projects', episode, 'final-assembly.json');
  try {
    const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
    if (!decisions?.music?.extendedPath) finalInputs.push('final-assembly.json music.extendedPath (BGM decision)');
    else await access(path.resolve(root, decisions.music.extendedPath));
    if (!(decisions.endingHoldSec > 0)) finalInputs.push('final-assembly.json endingHoldSec');
  } catch (error) {
    if (error.code === 'ENOENT' && error.path?.endsWith('final-assembly.json')) finalInputs.push('final-assembly.json');
    else throw error;
  }
  try {
    await access(path.join(root, 'projects', episode, 'temp', `${episode}-narration-master.m4a`));
  } catch {
    finalInputs.push(`projects/${episode}/temp/${episode}-narration-master.m4a (run pnpm video:build-narration-master ${episode})`);
  }
}
console.log(JSON.stringify({episode,target,passed:finalInputs.length === 0,
  blocks:timeline.blocks.length,shots:timeline.shots.length,
  opening:opening ? {
    startSec:opening.startSec,durationSec:opening.durationSec,bodyOffsetSec:opening.bodyOffsetSec,
    hookSlotId:opening.hookSlotId,continuingFootage:true,preRoll:'none',
    cards:opening.cards.map(c => ({kind:c.kind,text:c.text,startSec:c.startSec,endSec:c.endSec})),
    narrationSilenceWindow:opening.narrationSilenceWindow,
  } : 'legacy (no openingIdentity insertion)',
  finalParity:opening ? 'READY — review and final consume the same shared delivery plan' : 'legacy path — verify separately',
  missingFinalInputs:finalInputs,
  scope:'Input/export/footage-capacity checks only; short render, subtitle QA and human review still required.'},null,2));
if (finalInputs.length) throw new Error(`FINAL NOT READY: missing ${finalInputs.join(', ')}`);

