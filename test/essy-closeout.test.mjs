import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {closeoutEssy} from '../src/essy-closeout.mjs';
import {digestFile, finalVersionPaths} from '../src/essy-release.mjs';

const ep = 'ESSY-0006', url = 'https://youtu.be/abcdefghijk';
const run = (cwd, ...args) => execFileSync('git', args, {cwd, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
async function put(file, data) { await mkdir(path.dirname(file), {recursive:true}); await writeFile(file, typeof data === 'string' ? data : JSON.stringify(data)); }
async function fixture(fn) {
  const base = await mkdtemp(path.join(tmpdir(), 'essy-closeout-'));
  const root = path.join(base, 'repo'), remote = path.join(base, 'remote.git');
  try {
    await mkdir(root); run(base, 'init', '--bare', remote); run(root, 'init', '-b', 'main');
    run(root, 'config', 'user.email', 'test@example.invalid'); run(root, 'config', 'user.name', 'Test');
    run(root, 'remote', 'add', 'origin', remote);
    await put(path.join(root,'.gitignore'), 'output/\nprojects/*/temp/\n');
    await put(path.join(root,'other-episode.txt'), 'original');
    const {output,work}=finalVersionPaths(root,ep,'v1');
    const files={master:output,english:path.join(work,'en.srt'),bilingual:path.join(work,'bilingual.srt'),translation:path.join(work,'zh.json'),bilingualQa:path.join(work,'zh-qa.json')};
    for (const [name,file] of Object.entries(files)) await put(file, name==='bilingualQa' ? {passed:true,authoritativeEnglishCueCount:1,validTranslationCount:1} : name);
    const evidence={}; for (const [name,file] of Object.entries(files)) evidence[name]={path:path.relative(root,file).replaceAll('\\','/'),sha256:await digestFile(file)};
    const qa={episode:ep,output:evidence.master.path,durationSec:1,videoCodec:'h264',audioCodec:'aac',subtitleQa:{passed:true},subtitleBurn:{mode:'bilingual-en-zhTW'},openingGrammar:{passed:true},evidence};
    await put(path.join(root,'projects',ep,'temp','final-assembly','final-assembly-qa.json'),qa);
    const artifact={path:evidence.master.path,sha256:evidence.master.sha256,sizeBytes:6};
    const state={draftId:ep,series:'ESSY',status:'completed',approvals:{package:{approved:true},qa:{approved:true},finalAssembly:{approved:true,artifact}}};
    await put(path.join(root,'projects','_drafts',ep,'state.yaml'), state);
    run(root,'add','.gitignore','other-episode.txt',`projects/_drafts/${ep}/state.yaml`); run(root,'commit','-m','baseline'); run(root,'push','-u','origin','main');
    await fn({root,remote,files,state,artifact});
  } finally { await rm(base,{recursive:true,force:true}); }
}
const close = (root, u=url) => closeoutEssy({factoryRoot:root,episode:ep,url:u});

test('URL-only closeout commits exact episode records; duplicate is idempotent',()=>fixture(async ({root,remote})=>{
  await put(path.join(root,'unrelated.txt'),'keep');
  await put(path.join(root,'other-episode.txt'),'unrelated work');
  const first=await close(root); assert.equal(first.pushed,true);
  assert.equal(run(root,'rev-parse','HEAD'),run(remote,'rev-parse','refs/heads/main'));
  assert.deepEqual(run(root,'diff-tree','--no-commit-id','--name-only','-r','HEAD').split('\n').sort(),[`projects/${ep}/publication/closeout.json`,`projects/${ep}/publication/publication-record.json`]);
  const pub=JSON.parse(await readFile(path.join(root,'projects',ep,'publication','publication-record.json'),'utf8')).publication;
  assert.equal(pub.verification,'not-verified'); assert.equal('visibility' in pub,false); assert.equal('publishedAt' in pub,false);
  const second=await close(root,'https://www.youtube.com/watch?v=abcdefghijk'); assert.equal(second.commit,first.commit); assert.equal(second.pushed,false);
  assert.equal(await readFile(path.join(root,'unrelated.txt'),'utf8'),'keep');
  assert.equal(await readFile(path.join(root,'other-episode.txt'),'utf8'),'unrelated work');
  assert.equal(run(root,'show','HEAD:other-episode.txt'),'original');
  assert.equal(run(root,'status','--porcelain','--','unrelated.txt'),'?? unrelated.txt');
  await assert.rejects(()=>readFile(path.join(root,'archive','episodes',ep,'archive.json')), /ENOENT/);
}));

test('existing optional publication metadata survives URL-only closeout',()=>fixture(async ({root})=>{
  const record={episode:ep,publication:{schemaVersion:'1.0',platform:'youtube',status:'published',videoId:'abcdefghijk',url:'https://www.youtube.com/watch?v=abcdefghijk',sourceUrl:url,recordedAt:'2026-10-01T00:00:00.000Z',recordedBy:'operator-asserted',verification:'not-verified',visibility:'private',publishedAt:'2026-10-01T00:00:00.000Z'}};
  const file=path.join(root,'projects',ep,'publication','publication-record.json'); await put(file,record);
  run(root,'add',`projects/${ep}/publication/publication-record.json`);run(root,'commit','-m','existing evidence');run(root,'push','origin','main');
  await close(root); assert.deepEqual(JSON.parse(await readFile(file,'utf8')),record);
}));

test('invalid and conflicting URLs never write closeout',()=>fixture(async ({root})=>{
  await assert.rejects(()=>close(root,'https://example.com/no'),/Invalid YouTube/);
  await close(root); await assert.rejects(()=>close(root,'https://youtu.be/zyxwvutsrqp'),/conflicts/);
}));

test('missing approval or changed and missing final evidence are refused',()=>fixture(async ({root,files,state})=>{
  state.approvals.finalAssembly.approved=false;
  const statePath=path.join(root,'projects','_drafts',ep,'state.yaml');await put(statePath,state);
  await assert.rejects(()=>close(root),/final approval/);
  state.approvals.finalAssembly.approved=true;await put(statePath,state);
  await put(files.master,'altered'); await assert.rejects(()=>close(root),/evidence failed|changed/);
  await rm(files.master); await assert.rejects(()=>close(root),/evidence failed|ENOENT/);
}));

test('push failure retains one commit and same-URL retry pushes it',()=>fixture(async ({root,remote})=>{
  run(root,'remote','set-url','--push','origin',path.join(root,'missing-remote.git'));
  await assert.rejects(()=>close(root),/Git push failed/);
  const pending=run(root,'rev-parse','HEAD');
  run(root,'remote','set-url','--push','origin',remote);
  const result=await close(root,'https://youtube.com/watch?v=abcdefghijk');
  assert.equal(result.commit,pending);assert.equal(run(remote,'rev-parse','refs/heads/main'),pending);
}));

test('retry after an uncertain but successful push makes no second commit',()=>fixture(async ({root,remote})=>{
  run(root,'remote','set-url','--push','origin',path.join(root,'missing-remote.git'));
  await assert.rejects(()=>close(root),/Git push failed/);
  const pending=run(root,'rev-parse','HEAD');
  run(root,'remote','set-url','--push','origin',remote); run(root,'push','origin','main');
  const retry=await close(root); assert.equal(retry.commit,pending); assert.equal(retry.pushed,false);
}));

test('remote advance refuses closeout without creating a commit',()=>fixture(async ({root,remote})=>{
  const other=path.join(path.dirname(root),'other'); run(path.dirname(root),'clone','-b','main',remote,other);
  run(other,'config','user.email','test@example.invalid');run(other,'config','user.name','Test');
  await put(path.join(other,'remote-change.txt'),'remote');run(other,'add','remote-change.txt');run(other,'commit','-m','remote change');run(other,'push','origin','main');
  const before=run(root,'rev-parse','HEAD');await assert.rejects(()=>close(root),/Unrelated outgoing|divergence/);
  assert.equal(run(root,'rev-parse','HEAD'),before);
}));

test('an existing closeout lock prevents concurrent runs',()=>fixture(async ({root})=>{
  await put(path.join(root,'.git','essy-closeout.lock'),'held');
  await assert.rejects(()=>close(root),/Another closeout/);
}));

test('live and unknown lock owners are retained, while a confirmed dead owner is recovered',()=>fixture(async ({root})=>{
  const lock=path.join(root,'.git','essy-closeout.lock');
  await put(lock,{pid:process.pid,host:hostname(),token:'live'});
  await assert.rejects(()=>close(root),/owner is active/);
  assert.equal(JSON.parse(await readFile(lock,'utf8')).token,'live');
  await put(lock,{pid:2147483647,host:'different-host',token:'unknown'});
  await assert.rejects(()=>close(root),/cannot be verified/);
  assert.equal(JSON.parse(await readFile(lock,'utf8')).token,'unknown');
  await put(lock,{pid:2147483647,host:hostname(),token:'dead'});
  const result=await close(root); assert.equal(result.pushed,true);
  await assert.rejects(()=>readFile(lock),/ENOENT/);
}));

test('pre-commit failure restores owned files and leaves unrelated staged and unstaged work intact',()=>fixture(async ({root})=>{
  const pub=path.join(root,'projects',ep,'publication','publication-record.json');
  const original={episode:ep,assets:{thumbnail:'keep'}}; await put(pub,original);
  run(root,'add',`projects/${ep}/publication/publication-record.json`);run(root,'commit','-m','existing assets');run(root,'push','origin','main');
  const baseline=await readFile(pub);
  await put(path.join(root,'other-episode.txt'),'unrelated modification');
  const before=run(root,'rev-parse','HEAD');
  await assert.rejects(()=>closeoutEssy({factoryRoot:root,episode:ep,url,testHooks:{afterStage:async()=>{
    await put(path.join(root,'staged.txt'),'unrelated staged');run(root,'add','staged.txt');throw new Error('injected before commit');
  }}}),/injected before commit/);
  assert.deepEqual(await readFile(pub),baseline);
  assert.equal(await readFile(path.join(root,'other-episode.txt'),'utf8'),'unrelated modification');
  assert.equal(run(root,'diff','--cached','--name-only'),'staged.txt');
  assert.equal(run(root,'rev-parse','HEAD'),before);
  await assert.rejects(()=>readFile(path.join(root,'projects',ep,'publication','closeout.json')),/ENOENT/);
  run(root,'restore','--staged','--','staged.txt');
  const result=await close(root); assert.equal(result.pushed,true);
}));

test('partial temporary record is discarded and the same URL retries successfully',()=>fixture(async ({root})=>{
  await assert.rejects(()=>closeoutEssy({factoryRoot:root,episode:ep,url,testHooks:{afterTemporaryWrite:async temp=>{
    const data=await readFile(temp);await writeFile(temp,data.subarray(0,Math.floor(data.length/2)));throw new Error('injected partial write');
  }}}),/injected partial write/);
  assert.equal(run(root,'status','--porcelain','--',`projects/${ep}/publication`),'');
  assert.equal((await close(root)).pushed,true);
}));

test('abrupt termination after staging is recovered on same-URL retry',()=>fixture(async ({root})=>{
  const worker=fileURLToPath(new URL('./fixtures/essy-closeout-crash.mjs',import.meta.url));
  assert.throws(()=>execFileSync(process.execPath,[worker,root],{stdio:'pipe'}),error=>error.status===47);
  assert.notEqual(run(root,'diff','--cached','--name-only'),'');
  const result=await close(root,'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(result.pushed,true);assert.equal(run(root,'rev-list','--count','HEAD'),'2');
}));

test('unsafe recovery preserves unexpected data and later retries the journal',()=>fixture(async ({root})=>{
  const pub=path.join(root,'projects',ep,'publication','publication-record.json'); let generated;
  await assert.rejects(()=>closeoutEssy({factoryRoot:root,episode:ep,url,testHooks:{afterRecordWrite:async target=>{
    if (target.endsWith('publication-record.json')) { generated=await readFile(pub); await writeFile(pub,'external edit'); throw new Error('injected conflict'); }
  }}}),/cannot safely restore files.*Preserve/s);
  assert.equal(await readFile(pub,'utf8'),'external edit');
  await assert.rejects(()=>close(root,'https://youtu.be/zyxwvutsrqp'),/cannot safely restore/);
  await writeFile(pub,generated);
  const result=await close(root);assert.equal(result.pushed,true);
  assert.equal(run(root,'rev-list','--count','HEAD'),'2');
}));

test('failure immediately after commit retries without another commit',()=>fixture(async ({root})=>{
  await assert.rejects(()=>closeoutEssy({factoryRoot:root,episode:ep,url,testHooks:{afterCommit:()=>{throw new Error('injected after commit');}}}),/injected after commit/);
  const commit=run(root,'rev-parse','HEAD');
  assert.equal((await close(root)).commit,commit);
  assert.equal(run(root,'rev-list','--count','HEAD'),'2');
}));

test('unrelated staged changes and target modifications are refused',()=>fixture(async ({root})=>{
  await put(path.join(root,'staged.txt'),'keep');run(root,'add','staged.txt');
  await assert.rejects(()=>close(root),/Staged changes/);
}));

test('unrelated outgoing commit is refused',()=>fixture(async ({root})=>{
  await put(path.join(root,'other.txt'),'keep');run(root,'add','other.txt');run(root,'commit','-m','unrelated');
  await assert.rejects(()=>close(root),/Unrelated outgoing/);
}));

test('modified target record is refused',()=>fixture(async ({root})=>{
  await put(path.join(root,'projects',ep,'publication','publication-record.json'),{});
  await assert.rejects(()=>close(root),/target has local changes/);
}));
