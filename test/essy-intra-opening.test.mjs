import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {verifyEssyOpeningGrammar} from '../src/essy-opening-grammar.mjs';
import {buildSubtitleTimeline} from '../scripts/_build-subtitle-timeline.mjs';
import {buildBilingualSrt, parseSrt} from '../scripts/_build-bilingual-subtitles.mjs';
import {buildOpeningDeliveryPlan} from '../scripts/essay-opening-delivery.mjs';
import {renderOpeningVisualHold} from '../scripts/essay-opening-visual.mjs';

const ep='ESSY-0006', source=path.join(process.cwd(),'projects',ep);
const integrationOptions = {skip: !existsSync(path.join(source,'temp','sentence-001.words.json')) && 'ESSY-0006 local timing evidence is not available'};
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(fn) {
  const root=await mkdtemp(path.join(tmpdir(),'essy-intra-'));
  try {
    const project=path.join(root,'projects',ep),temp=path.join(project,'temp');await mkdir(temp,{recursive:true});
    const manifest=JSON.parse(await readFile(path.join(source,'manifest.json'),'utf8'));
    await writeFile(path.join(project,'manifest.json'),JSON.stringify(manifest));
    let start=0; const blocks=[];
    for(const a of manifest.audio) {
      for(const name of [`${a.id}.vtt`,`${a.id}.words.json`,`${a.blockId.toUpperCase()}.txt`]) await copyFile(path.join(source,'temp',name),path.join(temp,name));
      blocks.push({sentenceId:a.id,startSec:start,endSec:start+a.durationSec,durationSec:a.durationSec});start+=a.durationSec;
    }
    const shots=[{slotId:'N001-S1',absoluteStartSec:0,absoluteEndSec:51.432,renderDurationSec:51.432,sourceDurationSec:51.432,mediaType:'video'}];
    const timeline={blocks,shots,plannedDurationSec:start};await writeFile(path.join(project,'assembly-timeline.json'),JSON.stringify(timeline));
    const identity={seriesTitle:'A Second Look at Life',episodeTitle:'An Ordinary Life',timing:{startSec:1,durationSec:8,pauseBeforeIdentitySec:2,pauseAfterIdentitySec:1}};
    const verified=await verifyEssyOpeningGrammar({root,episode:ep,identity,timeline,title:identity.episodeTitle});
    await fn({root,project,timeline,identity,...verified});
  } finally {await rm(root,{recursive:true,force:true});}
}
test('real N001 boundary, pauses, ordering and downstream visual shift',integrationOptions,()=>fixture(async ({plan,timing,boundary,timeline,identity})=>{
  assert.deepEqual(boundary,{questionSpeechEndSec:16.316,questionMarkerEndSec:16.456,bodyStartSec:17.394});
  assert.ok(plan.startSec>16.456&&plan.startSec<17.394);
  assert.ok(Math.abs(plan.durationSec-6.922)<1e-9);
  assert.ok(Math.abs(timing.questionToIdentitySec-2)<1e-9);
  assert.ok(Math.abs(timing.identityToNarrationSec-1)<1e-9);
  assert.deepEqual(plan.cards.map(c=>c.kind),['channel','episode']);
  assert.equal(plan.cards[0].endSec,plan.cards[1].startSec);
  const delivery=buildOpeningDeliveryPlan({identity,timeline,verifiedPlan:plan});
  assert.equal(delivery.deliveryShotOverrides.get('N001-S1').mode,'hold-at-boundary');
  assert.equal(delivery.subtitleInsertion.durationSec,plan.durationSec);
}));
test('EN and zh-TW retain exact cue mapping and shift after insertion',integrationOptions,()=>fixture(async ({root,project,plan})=>{
  const baseline=await buildSubtitleTimeline({root,episode:ep,insertion:{...plan,durationSec:0.000001}});
  const base=baseline.cues.map(c=>({...c}));
  const shifted=await buildSubtitleTimeline({root,episode:ep,insertion:plan});
  assert.ok(baseline.report.passed&&shifted.report.passed);
  assert.equal(base.length,shifted.cues.length);
  for(let i=0;i<base.length;i++) {
    const a=base[i],b=shifted.cues[i];assert.equal(a.text,b.text);
    const shift=a.speechStartSec>=plan.startSec ? plan.durationSec-0.000001 : 0;
    assert.ok(Math.abs(b.speechStartSec-a.speechStartSec-shift)<1e-7);
    assert.ok(!(b.startSec<plan.startSec+plan.durationSec&&b.endSec>plan.startSec));
  }
  const en=parseSrt(await readFile(shifted.srtPath,'utf8'));
  const translations=Object.fromEntries(en.map((c,i)=>[c.text,`測試字幕${i+1}`]));
  const zh=path.join(project,'test-zh.json');await writeFile(zh,JSON.stringify({translations}));
  const bilingual=await buildBilingualSrt({root,episode:ep,englishSrtPath:shifted.srtPath,zhPath:zh,log:()=>{}});
  assert.equal(bilingual.report.passed,true);
  assert.deepEqual(bilingual.cues.map(c=>c.timecode),en.map(c=>c.timecode));
}));
test('PCM split and silence insertion preserve every canonical sample',integrationOptions,()=>fixture(async ({plan})=>{
  const audio=path.join(source,'audio','N001.mp3'), before=await readFile(audio), opts={maxBuffer:32*1024*1024};
  const common=['-hide_banner','-loglevel','error','-i',audio];
  const original=execFileSync('ffmpeg',[...common,'-af','aresample=48000,aformat=channel_layouts=stereo','-f','s16le','-acodec','pcm_s16le','pipe:1'],opts);
  const filter=`[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[a][b];[a]atrim=end=${plan.startSec},asetpts=PTS-STARTPTS[head];[b]atrim=start=${plan.startSec},asetpts=PTS-STARTPTS[tail];anullsrc=r=48000:cl=stereo:d=${plan.durationSec}[sil];[head][sil][tail]concat=n=3:v=0:a=1[out]`;
  const inserted=execFileSync('ffmpeg',[...common,'-filter_complex',filter,'-map','[out]','-f','s16le','-acodec','pcm_s16le','pipe:1'],opts);
  const cut=Math.round(plan.startSec*48000)*4, silence=Math.round(plan.durationSec*48000)*4;
  assert.deepEqual(inserted.subarray(0,cut),original.subarray(0,cut));
  assert.ok(inserted.subarray(cut,cut+silence).every(v=>v===0));
  assert.deepEqual(inserted.subarray(cut+silence),original.subarray(cut));
  assert.equal(hash(await readFile(audio)),hash(before));
}));
test('reusable visual composer holds a real frame throughout insertion',integrationOptions,()=>fixture(async ({root})=>{
  const work=path.join(root,'visual');await mkdir(work,{recursive:true});
  const output=path.join(work,'result.mp4');
  const run=async (cmd,args)=>execFileSync(cmd,args,{stdio:'pipe'});
  await renderOpeningVisualHold({run,source:path.join(source,'ESSY-0006-v04-review.mp4'),cutSec:2,sourceDurationSec:6,holdSec:2,width:160,height:90,fps:30,work,output});
  const frame=at=>execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-ss',String(at),'-i',output,'-frames:v','1','-pix_fmt','gray','-f','rawvideo','pipe:1']);
  const a=frame(2.4),b=frame(3.4);
  assert.equal(a.length,160*90);assert.equal(b.length,a.length);
  let difference=0, brightness=0;for(let i=0;i<a.length;i++){difference+=Math.abs(a[i]-b[i]);brightness+=a[i];}
  assert.ok(difference/a.length<1,`hold frame mean difference ${difference/a.length}`);
  assert.ok(brightness/a.length>5,'hold is not an unintended black frame');
}));
test('review preflight accepts intra-block delivery with canonical N-block audio paths',integrationOptions,()=>fixture(async ({root,project,timeline,identity})=>{
  const draft=path.join(root,'projects','_drafts',ep);await mkdir(draft,{recursive:true});
  await writeFile(path.join(draft,'production-package.json'),JSON.stringify({title:'An Ordinary Life',openingIdentity:identity}));
  await mkdir(path.join(project,'audio'),{recursive:true});
  for(let i=1;i<=8;i++){const name=`N${String(i).padStart(3,'0')}.mp3`;await copyFile(path.join(source,'audio',name),path.join(project,'audio',name));}
  timeline.shots[0].sourcePath=path.join(source,'ESSY-0006-v04-review.mp4');
  await writeFile(path.join(project,'assembly-timeline.json'),JSON.stringify(timeline));
  const output=execFileSync(process.execPath,[path.join(process.cwd(),'scripts','essy-preflight.mjs'),ep,'review'],{cwd:root,encoding:'utf8'});
  const result=JSON.parse(output);assert.equal(result.passed,true);assert.equal(result.opening.visualMode,'hold-at-boundary');
}));
