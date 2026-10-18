import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {buildApprovedEssyHandoff} from '../src/essy-approved-handoff.mjs';
import {validateAssemblyTimeline} from '../src/assembly-timeline.mjs';

const load = async path => JSON.parse(await readFile(path,'utf8'));
const integrationOptions = {skip: !existsSync('projects/ESSY-0006/sourcing/downloads/provenance.json') && 'ESSY-0006 local production evidence is not available'};
async function fixture() {
  const p='projects/ESSY-0006', d='projects/_drafts/ESSY-0006';
  return {episode:'ESSY-0006', state:await load(`${d}/state.yaml`), pkg:await load(`${d}/production-package.json`), script:await readFile(`${p}/script.md`,'utf8'), manifest:await load(`${p}/manifest.json`), storyboard:await load(`${d}/storyboard.yaml`), selection:await load(`${d}/slot-selection-proposed.json`), assetMap:await load(`${p}/sourcing/approved-slot-asset-map.json`), provenance:await load(`${p}/sourcing/downloads/provenance.json`), assetsValidation:await load(`${d}/assets-validation.json`)};
}
test('approved handoff preserves all storyboard slots, identity, provenance and selected timing', integrationOptions, async () => {
  const input=await fixture(), {lesson,timeline}=buildApprovedEssyHandoff(input);
  assert.equal(lesson.sections.length,8);
  assert.equal(timeline.shots.length,32);
  assert.deepEqual(timeline.shots.map(s=>s.slotId),input.storyboard.blocks.flatMap(b=>b.slots.map(s=>s.slotId)));
  assert.ok(timeline.shots.some(s=>s.slotId==='N001-S4'));
  for (const shot of timeline.shots) {
    const selection=input.selection.slots.find(s=>s.slotId===shot.slotId), p=input.provenance.items.find(s=>s.slotId===shot.slotId);
    assert.equal(shot.assetId,selection.assetId); assert.equal(shot.sourcePath,p.localPath); assert.equal(shot.sourceSha256,p.sha256);
    assert.equal(shot.absoluteStartSec,selection.proposedStartSec); assert.equal(shot.renderDurationSec,selection.proposedDurationSec);
  }
  validateAssemblyTimeline(timeline);
});
test('handoff rejects changed asset, timing, narration and missing approval', integrationOptions, async () => {
  const original=await fixture();
  for (const mutate of [x=>x.provenance.items[0].id='different',x=>x.selection.slots[0].proposedDurationSec+=1,x=>x.script=x.script.replace('What if the ordinary life', 'What if the changed life'),x=>x.state.approvals.package.approved=false]) {
    const input=structuredClone(original); mutate(input); assert.throws(()=>buildApprovedEssyHandoff(input));
  }
});
