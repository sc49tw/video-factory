import test from 'node:test';
import assert from 'node:assert/strict';
import {planOpeningInsertion} from './essay-opening-plan.mjs';
import {buildSubtitleTimeline} from './_build-subtitle-timeline.mjs';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const identity = {seriesTitle:'Series',episodeTitle:'Episode',timing:{startSec:10,durationSec:4}};
const timeline = {blocks:[{endSec:10,shots:[{absoluteStartSec:5,mediaType:'video',sourceDurationSec:12}]}]};
test('identity continues approved footage and preserves hook boundary',()=>{
  const p=planOpeningInsertion(identity,timeline);
  assert.equal(p.sourceDuration,9);
  assert.deepEqual(p.cards.map(c=>[c.startSec,c.endSec]),[[10,12],[12,14]]);
  assert.throws(()=>planOpeningInsertion({...identity,timing:{startSec:8,durationSec:4}},timeline));
  assert.throws(()=>planOpeningInsertion({...identity,timing:{startSec:10,durationSec:20}},timeline));
});
test('insertion shifts entire body cues without dropping words or changing durations',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'essay-opening-'));
  try {
    const project=path.join(root,'projects','TEST');
    await mkdir(path.join(project,'temp'),{recursive:true});
    await writeFile(path.join(project,'assembly-timeline.json'),JSON.stringify({blocks:[{sentenceId:'one',startSec:0,endSec:10},{sentenceId:'two',startSec:10,endSec:20}]}));
    for(const id of ['one','two']) await writeFile(path.join(project,'temp',`${id}.vtt`),'WEBVTT\n\n00:00:00.100 --> 00:00:02.000\nEvery word stays here.\n');
    const before=await buildSubtitleTimeline({root,episode:'TEST'});
    const after=await buildSubtitleTimeline({root,episode:'TEST',insertion:{startSec:10,durationSec:4}});
    assert.deepEqual(after.cues.map(c=>c.text),before.cues.map(c=>c.text));
    assert.equal(after.cues[0].startSec,before.cues[0].startSec);
    assert.equal(after.cues[1].startSec,before.cues[1].startSec+4);
    assert.equal(after.cues[1].endSec,before.cues[1].endSec+4);
    assert.equal(after.report.passed,true);
    await assert.rejects(buildSubtitleTimeline({root,episode:'TEST',insertion:{startSec:8,durationSec:4}}));
  } finally { await rm(root,{recursive:true,force:true}); }
});
