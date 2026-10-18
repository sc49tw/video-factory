import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

// Existing delivered episodes retain their historical contract. New ESSY
// deliveries use the bilingual evidence contract from ESSY-0006 onward.
export function requiresEssyReleaseEvidence(episode) {
  const number = /^ESSY-(\d+)$/.exec(episode)?.[1];
  return number != null && Number(number) >= 6;
}

export async function digestFile(file) {
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function finalVersionPaths(root, episode, label) {
  if (!/^v[1-9]\d*$/.test(label)) throw new Error('Final render label must be v followed by a positive version number.');
  return {output:path.join(root,'output',episode,`${episode}-final-${label}.mp4`),
    work:path.join(root,'projects',episode,'temp','final-assembly',label)};
}

export async function assertNewFinalVersion(root, episode, label) {
  const paths=finalVersionPaths(root,episode,label);
  try { await stat(paths.output); } catch (error) { if (error.code === 'ENOENT') return paths; throw error; }
  throw new Error(`Final version already exists: ${paths.output}; choose a new version.`);
}

// This validates the files bound to the renderer's QA, not an AI assertion or
// a conveniently named review MP4. All paths must stay within this episode.
export async function validateEssyReleaseEvidence(root, episode, requestedPath = null, location = null) {
  try {
    const activeProject=path.resolve(root,'projects',episode), activeOutput=path.resolve(root,'output',episode);
    const projectRoot=path.resolve(location?.projectDir ?? activeProject), outRoot=path.resolve(location?.outputDir ?? activeOutput);
    const map=(recorded,active,actual)=>{
      const from=path.resolve(root,recorded), rel=path.relative(active,from);
      if (!rel || rel.startsWith('..'+path.sep) || rel==='..' || path.isAbsolute(rel)) throw new Error('Evidence path escapes its episode.');
      return path.join(actual,rel);
    };
    const qaPath=path.join(projectRoot,'temp','final-assembly','final-assembly-qa.json');
    const qa=JSON.parse(await readFile(qaPath,'utf8'));
    const output=map(qa.output ?? '',activeOutput,outRoot);
    if (path.dirname(output)!==outRoot || !new RegExp(`^${episode}-final-v[1-9]\\d*\\.mp4$`).test(path.basename(output))) throw new Error('QA does not identify a versioned final master.');
    if (requestedPath && output!==map(requestedPath,activeOutput,outRoot)) throw new Error('QA output does not match the selected master.');
    if (qa.episode!==episode || qa.subtitleQa?.passed!==true || qa.openingGrammar?.passed!==true || !(qa.durationSec>0) || !qa.videoCodec || !qa.audioCodec) throw new Error('Final technical, opening, or subtitle QA is missing or failed.');
    const label=/-(v[1-9]\d*)\.mp4$/.exec(output)[1];
    const versionRoot=path.join(projectRoot,'temp','final-assembly',label);
    const legacyBilingual=qa.subtitleBurn?.mode==='bilingual-en-zhTW' && !qa.subtitleDelivery;
    const delivery=legacyBilingual ? {mode:'burn-in',languages:['en','zh-TW']} : qa.subtitleDelivery;
    if (!delivery || !['burn-in','selectable-tracks'].includes(delivery.mode) || !Array.isArray(delivery.languages) || new Set(delivery.languages).size!==delivery.languages.length || delivery.languages.some(l=>!['en','zh-TW'].includes(l))) throw new Error('Subtitle delivery mode or languages are invalid.');
    const omitted=['en','zh-TW'].filter(l=>!delivery.languages.includes(l));
    if (omitted.length) {
      const spec=JSON.parse(await readFile(path.join(projectRoot,'final-assembly.json'),'utf8'));
      const exception=spec.subtitleException;
      const scope=exception?.scope;
      const approval=exception?.approval;
      if (scope?.episode!==episode || scope?.version!==label || !Array.isArray(scope.omittedLanguages) || scope.omittedLanguages.length!==omitted.length || omitted.some(l=>!scope.omittedLanguages.includes(l)) || typeof exception.rationale!=='string' || !exception.rationale.trim() || approval?.approved!==true || approval.by!=='project owner' || typeof approval.date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(approval.date) || !Number.isFinite(Date.parse(approval.date)) || !/^[a-f0-9]{64}$/.test(approval.evidence?.sha256 ?? '') || typeof approval.evidence?.path!=='string') throw new Error('Missing or invalid scoped owner subtitle exception approval.');
      const approvalFile=map(approval.evidence.path,activeProject,projectRoot);
      if (await digestFile(approvalFile)!==approval.evidence.sha256) throw new Error('Subtitle exception approval evidence changed.');
      const record=JSON.parse(await readFile(approvalFile,'utf8'));
      if (record.approved!==true || record.by!==approval.by || record.date!==approval.date || record.rationale!==exception.rationale || record.scope?.episode!==episode || record.scope?.version!==label || !Array.isArray(record.scope?.omittedLanguages) || record.scope.omittedLanguages.length!==omitted.length || omitted.some(l=>!record.scope.omittedLanguages.includes(l))) throw new Error('Subtitle exception approval evidence does not match its scope.');
    }
    const expected={master:outRoot};
    if (delivery.languages.includes('en')) expected.english=versionRoot;
    if (delivery.languages.includes('zh-TW')) expected.translation=versionRoot;
    if (!omitted.length) { expected.bilingualQa=versionRoot; if (legacyBilingual) expected.bilingual=versionRoot; }
    if (!legacyBilingual) for (const language of delivery.languages) expected[`track-${language}`]=versionRoot;
    const resolved={};
    for (const [name,base] of Object.entries(expected)) {
      const entry=qa.evidence?.[name];
      if (!entry || typeof entry.path!=='string' || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error(`Missing ${name} evidence.`);
      const file=name==='master' ? map(entry.path,activeOutput,outRoot) : map(entry.path,activeProject,projectRoot);
      if (!file.startsWith(base+path.sep) || (name==='master' && file!==output)) throw new Error(`Invalid ${name} evidence path.`);
      const info=await stat(file);
      if (!info.isFile() || !info.size || await digestFile(file)!==entry.sha256) throw new Error(`${name} evidence missing or changed.`);
      resolved[name]=file;
    }
    if (!omitted.length) {
      const bilingualQa=JSON.parse(await readFile(resolved.bilingualQa,'utf8'));
      if (bilingualQa.passed!==true || !(bilingualQa.authoritativeEnglishCueCount>0) || bilingualQa.validTranslationCount!==bilingualQa.authoritativeEnglishCueCount) throw new Error('Bilingual translation completeness QA failed.');
    }
    return {passed:true,output,qa};
  } catch(error) { return {passed:false,reason:error.message}; }
}
