import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertNewFinalVersion, digestFile, finalVersionPaths, validateEssyReleaseEvidence} from '../src/essy-release.mjs';
import {validateEssyCompletion, buildPublicationCheckReport, validatePublicationMetadata} from '../src/publication.mjs';
import {validateEditorialShotPlan} from '../src/essy-editorial-preview.mjs';
import {buildSubtitleTimeline} from '../scripts/_build-subtitle-timeline.mjs';
import {verifyEssyOpeningGrammar} from '../src/essy-opening-grammar.mjs';
import {isBilingualEpisode, resolveEpisodeSubtitleConfig} from '../scripts/_build-bilingual-subtitles.mjs';

async function fixture(run) { const root=await mkdtemp(path.join(tmpdir(),'essy-hardening-'));try {await run(root);} finally {await rm(root,{recursive:true,force:true});} }
async function put(file,data) {await mkdir(path.dirname(file),{recursive:true});await writeFile(file,typeof data==='string'?data:JSON.stringify(data));}
const ep='ESSY-0006';
async function releaseFixture(root) {
  const {output,work}=finalVersionPaths(root,ep,'v5');
  const files={master:output,english:path.join(work,'en.srt'),bilingual:path.join(work,'bilingual.srt'),translation:path.join(work,'zh.json'),bilingualQa:path.join(work,'zh-qa.json')};
  for (const [name,file] of Object.entries(files)) await put(file,name==='bilingualQa'?{passed:true,authoritativeEnglishCueCount:1,validTranslationCount:1}:name==='translation'?'{"translations":{"Hello":"你好"}}':name==='master'?'sample master':'1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  const evidence={}; for(const [name,file] of Object.entries(files)) evidence[name]={path:path.relative(root,file).replaceAll('\\','/'),sha256:await digestFile(file)};
  const qa={episode:ep,output:evidence.master.path,durationSec:1,videoCodec:'h264',audioCodec:'aac',subtitleQa:{passed:true},subtitleBurn:{mode:'bilingual-en-zhTW'},openingGrammar:{passed:true},evidence};
  await put(path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json'),qa);
  return {files,qa};
}
test('new final versions are isolated and cannot overwrite prior masters',()=>fixture(async root=>{
  const v4=finalVersionPaths(root,ep,'v4'),v5=await assertNewFinalVersion(root,ep,'v5');
  assert.notEqual(v4.work,v5.work);await put(v4.output,'approved');
  await assert.rejects(()=>assertNewFinalVersion(root,ep,'v4'),/already exists/);
  assert.equal(await readFile(v4.output,'utf8'),'approved');
  assert.throws(()=>finalVersionPaths(root,ep,'../v4'),/label/);
}));
test('release evidence refuses review video, absent or changed Chinese, and stale master',()=>fixture(async root=>{
  const {files,qa}=await releaseFixture(root);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,true);
  assert.equal((await validateEssyReleaseEvidence(root,ep,`output/${ep}/${ep}-v05-complete-review.mp4`)).passed,false);
  await rm(files.translation); assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
  await put(files.translation,'changed'); assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
  await put(files.translation,'{"translations":{"Hello":"你好"}}');
  await put(files.master,'modified'); assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
  qa.output=`output/${ep}/${ep}-v05-complete-review.mp4`;
  await put(path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json'),qa);
  assert.match((await validateEssyReleaseEvidence(root,ep)).reason,/versioned final master/);
}));
test('completion does not depend on publication metadata or thumbnail',()=>fixture(async root=>{
  const {qa}=await releaseFixture(root);
  assert.equal((await validateEssyCompletion(root,ep,qa.output)).passed,true);
}));
test('subtitle delivery requires scoped owner approval for omitted languages',()=>fixture(async root=>{
  const {files,qa}=await releaseFixture(root);
  const qaPath=path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json');
  qa.subtitleDelivery={mode:'selectable-tracks',languages:['en']};
  qa.evidence['track-en']=qa.evidence.english;
  await put(qaPath,qa);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
  const scope={episode:ep,version:'v5',omittedLanguages:['zh-TW']};
  const record={approved:true,by:'project owner',date:'2026-10-18',scope,rationale:'Approved English-only release'};
  const approvalFile=path.join(root,'projects',ep,'approvals','subtitle-exception.json');
  await put(approvalFile,record);
  const approval={approved:true,by:record.by,date:record.date,evidence:{path:path.relative(root,approvalFile),sha256:await digestFile(approvalFile)}};
  const spec={subtitleException:{scope,rationale:record.rationale,approval}};
  const specPath=path.join(root,'projects',ep,'final-assembly.json');
  await put(specPath,spec);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,true);
  spec.subtitleException.scope.version='v4';await put(specPath,spec);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
  spec.subtitleException.scope.version='v5';approval.approved=false;await put(specPath,spec);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
  approval.approved=true;await put(specPath,spec);await put(approvalFile,'changed');
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
  await put(approvalFile,record);await put(files.english,'changed');
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
}));
test('subtitle exception rejects forged external approval even when spec declares approved',()=>fixture(async root=>{
  const {files,qa}=await releaseFixture(root);
  const qaPath=path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json');
  qa.subtitleDelivery={mode:'selectable-tracks',languages:['en']};
  qa.evidence['track-en']=qa.evidence.english;
  await put(qaPath,qa);
  const scope={episode:ep,version:'v5',omittedLanguages:['zh-TW']};
  const approvalFile=path.join(root,'projects',ep,'approvals','subtitle-exception.json');
  await put(approvalFile,{approved:false,by:'project owner',date:'2026-10-18',scope,rationale:'Approved English-only release'});
  const spec={subtitleException:{scope,rationale:'Approved English-only release',approval:{approved:true,by:'project owner',date:'2026-10-18',evidence:{path:path.relative(root,approvalFile),sha256:await digestFile(approvalFile)}}}};
  const specPath=path.join(root,'projects',ep,'final-assembly.json');
  await put(specPath,spec);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
}));
test('subtitle exception rejects missing external evidence file',()=>fixture(async root=>{
  const {files,qa}=await releaseFixture(root);
  const qaPath=path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json');
  qa.subtitleDelivery={mode:'selectable-tracks',languages:['en']};
  qa.evidence['track-en']=qa.evidence.english;
  await put(qaPath,qa);
  const scope={episode:ep,version:'v5',omittedLanguages:['zh-TW']};
  const spec={subtitleException:{scope,rationale:'Approved English-only release',approval:{approved:true,by:'project owner',date:'2026-10-18',evidence:{path:`projects/${ep}/approvals/nonexistent.json`,sha256:'0'.repeat(64)}}}};
  const specPath=path.join(root,'projects',ep,'final-assembly.json');
  await put(specPath,spec);
  const result=await validateEssyReleaseEvidence(root,ep);
  assert.equal(result.passed,false);
  assert.match(result.reason,/ENOENT/);
}));
test('selectable bilingual tracks retain both language and hash requirements',()=>fixture(async root=>{
  const {qa}=await releaseFixture(root);
  qa.subtitleDelivery={mode:'selectable-tracks',languages:['en','zh-TW']};
  qa.evidence['track-en']=qa.evidence.english;
  qa.evidence['track-zh-TW']=qa.evidence.bilingual;
  await put(path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json'),qa);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,true);
  qa.evidence['track-zh-TW'].sha256='0'.repeat(64);
  await put(path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json'),qa);
  assert.equal((await validateEssyReleaseEvidence(root,ep)).passed,false);
}));
test('publication cannot report ready with invalid metadata or absent approval',()=>{
  const metadata=validatePublicationMetadata({episode:ep,title:'Title',description:'x'.repeat(120),thumbnail:'thumbnail.png',tags:['x'],channel:'',platform:'youtube',language:'en',visibility:'private'},{episode:ep});
  const report=buildPublicationCheckReport({episode:ep,metadata,thumbnail:{passed:true},video:{passed:true,relative:'master'},lifecycle:{state:'not-ready'},approvedTitle:null});
  assert.equal(report.ready,false);assert.ok(report.rows.some(r=>r.id==='metadata'&&!r.passed));assert.ok(report.rows.some(r=>r.id==='lifecycle'&&!r.passed));
});
test('publication readiness requires complete metadata and thumbnail',()=>{
  const metadata=validatePublicationMetadata({episode:ep,title:'Title',description:'x'.repeat(120),thumbnail:'thumbnail.png',tags:['x'],channel:'channel',platform:'youtube',language:'en',visibility:'private'},{episode:ep});
  const input={episode:ep,metadata,thumbnail:{passed:true},video:{passed:true,relative:'master'},lifecycle:{state:'completed',completed:true},approvedTitle:'Title'};
  assert.equal(buildPublicationCheckReport(input).ready,true);
  assert.equal(buildPublicationCheckReport({...input,thumbnail:{passed:false}}).ready,false);
  assert.equal(buildPublicationCheckReport({...input,metadata:validatePublicationMetadata(null,{episode:ep})}).ready,false);
});
test('editorial plan accepts provisional candidates but requires full continuous coverage',()=>{
  assert.equal(validateEditorialShotPlan([{slotId:'N001-S1',mediaId:123,input:'temp/candidate.mp4',startSec:0,durationSec:3}],3),true);
  assert.throws(()=>validateEditorialShotPlan([{slotId:'N001-S1',mediaId:123,input:'x',startSec:1,durationSec:2}],3),/contiguous/);
});
test('bilingual default is enabled for new episodes without changing legacy segmentation',()=>{
  assert.equal(isBilingualEpisode(ep),true);assert.deepEqual(resolveEpisodeSubtitleConfig(ep),{});
  assert.equal(isBilingualEpisode('ESSY-0004'),false);assert.equal(resolveEpisodeSubtitleConfig('ESSY-0005').MIN_GENERATED_DURATION_MS,450);
});
test('placeholder VTT recovers only hash-bound text and rejects mismatched word timing',()=>fixture(async root=>{
  const project=path.join(root,'projects',ep), text='What is an ordinary life?';
  const hash=createHash('sha256').update(text).digest('hex');
  await put(path.join(project,'assembly-timeline.json'),{blocks:[{sentenceId:'sentence-001',startSec:0,endSec:5}]});
  await put(path.join(project,'manifest.json'),{subtitleTiming:{policy:'word-boundary-required'},audio:[{id:'sentence-001',blockId:'n001',textSha256:hash}]});
  await put(path.join(project,'temp','N001.txt'),text);
  await put(path.join(project,'temp','sentence-001.vtt'),'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsentence-001 n001\n');
  const words={timingSource:'azure-speech-word-boundary',words:['What','is','an','ordinary','life','?'].map((text,i)=>({text,startSec:i*.6,endSec:i*.6+.5}))};
  await put(path.join(project,'temp','sentence-001.words.json'),words);
  const result=await buildSubtitleTimeline({root,episode:ep});
  assert.equal(result.report.passed,true);assert.equal(result.cues.map(c=>c.text).join(' '),text);
  words.words[1].text='was';await put(path.join(project,'temp','sentence-001.words.json'),words);
  assert.equal((await buildSubtitleTimeline({root,episode:ep})).report.passed,false);
  await put(path.join(project,'temp','N001.txt'),'changed');await assert.rejects(()=>buildSubtitleTimeline({root,episode:ep}),/hash mismatch/);
}));
test('opening grammar verifies hook, identity order and measured pauses',()=>fixture(async root=>{
  const project=path.join(root,'projects',ep), hook='Why now? What next? How then?';
  await put(path.join(project,'temp','N001.txt'),hook);
  const words=['Why','now','?','What','next','?','How','then','?'].map((text,i)=>({text,startSec:i,endSec:i+.5}));
  await put(path.join(project,'temp','sentence-001.words.json'),{words});
  await put(path.join(project,'temp','sentence-002.words.json'),{words:[{text:'Body',startSec:0,endSec:.5}]});
  const timeline={blocks:[{sentenceId:'sentence-001',startSec:0,endSec:9,shots:[{slotId:'N001-S1',absoluteStartSec:0,mediaType:'video',sourceDurationSec:20}]},{sentenceId:'sentence-002',startSec:9,endSec:12}]};
  const identity={seriesTitle:'A SECOND LOOK AT LIFE',episodeTitle:'Title',timing:{startSec:9,durationSec:7}};
  const result=await verifyEssyOpeningGrammar({root,episode:ep,identity,timeline,title:'Title'});
  assert.deepEqual(result.plan.cards.map(c=>c.kind),['channel','episode']);
  assert.equal(result.timing.questionToIdentitySec,2.5);assert.equal(result.timing.identityToNarrationSec,1);
  await put(path.join(project,'temp','N001.txt'),hook+' Main narration.');
  await assert.rejects(()=>verifyEssyOpeningGrammar({root,episode:ep,identity,timeline,title:'Title'}),/does not match approved narration/);
}));
test('approved opening plan controls question count and order',()=>fixture(async root=>{
  const project=path.join(root,'projects',ep);
  for (const count of [2,3,4]) {
    const questions=['Why now?','What next?','How then?','Who knows?'].slice(0,count);
    const words=questions.flatMap(q=>q.replace('?',' ?').split(' ')).map((text,i)=>({text,startSec:i,endSec:i+.5}));
    await put(path.join(project,'temp','N001.txt'),questions.join(' '));
    await put(path.join(project,'temp','sentence-001.words.json'),{words});
    await put(path.join(project,'temp','sentence-002.words.json'),{words:[{text:'Body',startSec:0,endSec:.5}]});
    const end=words.length;
    const timeline={blocks:[{sentenceId:'sentence-001',startSec:0,endSec:end,shots:[{slotId:'N001-S1',absoluteStartSec:0,mediaType:'video',sourceDurationSec:40}]},{sentenceId:'sentence-002',startSec:end,endSec:end+3}]};
    const identity={seriesTitle:'A SECOND LOOK AT LIFE',episodeTitle:'Title',openingPlan:{questions},timing:{startSec:end,durationSec:7}};
    assert.ok((await verifyEssyOpeningGrammar({root,episode:ep,identity,timeline,title:'Title'})).plan);
    identity.openingPlan.questions=[...questions].reverse();
    await assert.rejects(()=>verifyEssyOpeningGrammar({root,episode:ep,identity,timeline,title:'Title'}),/approved Opening Plan/);
  }
}));
test('intra-block insertion carries approved count and presentation to delivery',()=>fixture(async root=>{
  const project=path.join(root,'projects',ep);
  for (const count of [2,4]) {
    const questions=['Why now?','What next?','How then?','Who knows?'].slice(0,count);
    const tokens=[...questions.flatMap(q=>q.replace('?',' ?').split(' ')),'Body','.'];
    const words=tokens.map((text,i)=>({text,startSec:i,endSec:i+.5}));
    await put(path.join(project,'temp','N001.txt'),questions.join(' ')+' Body.');
    await put(path.join(project,'temp','sentence-001.words.json'),{words});
    await put(path.join(project,'temp','sentence-002.words.json'),{words:[{text:'Next',startSec:0,endSec:.5}]});
    const end=words.length, cut=(words[count*3-1].endSec+words[count*3].startSec)/2;
    const shot={slotId:'N001-S1',absoluteStartSec:0,absoluteEndSec:end,mediaType:'video',sourceDurationSec:40};
    const timeline={shots:[shot],blocks:[{sentenceId:'sentence-001',startSec:0,endSec:end,shots:[shot]},{sentenceId:'sentence-002',startSec:end,endSec:end+3}]};
    const identity={seriesTitle:'A SECOND LOOK AT LIFE',episodeTitle:'Title',openingPlan:{questions},timing:{startSec:cut,durationSec:7},presentation:{mode:'simultaneous',seriesTitleFirst:false}};
    const {plan}=await verifyEssyOpeningGrammar({root,episode:ep,identity,timeline,title:'Title'});
    assert.equal(plan.questionCount,count);
    assert.deepEqual(plan.cards.map(c=>c.kind),['episode','channel']);
    assert.equal(plan.cards[0].startSec,plan.cards[1].startSec);
    identity.timing.startSec+=1;
    await assert.rejects(()=>verifyEssyOpeningGrammar({root,episode:ep,identity,timeline,title:'Title'}),/timing does not match/);
  }
}));
