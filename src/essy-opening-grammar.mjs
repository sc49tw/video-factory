import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {ESSY_SERIES_IDENTITY} from '../scripts/essay-identity-config.mjs';
import {planOpeningInsertion} from '../scripts/essay-opening-plan.mjs';
import {validateEssyOpeningIdentity} from './essy-opening-identity.mjs';

export async function verifyEssyOpeningGrammar({root,episode,identity,timeline,title}) {
  if (!identity) throw new Error('Opening identity is required for new ESSY deliveries.');
  validateEssyOpeningIdentity(identity);
  if (identity.seriesTitle.trim().toUpperCase()!==ESSY_SERIES_IDENTITY.seriesTitle.toUpperCase() || identity.episodeTitle.trim()!==String(title ?? '').trim()) throw new Error('Opening identity titles do not match the approved series and episode titles.');
  if (identity.narrationSuppression?.enabled===false || identity.subtitleSuppression?.enabled===false) throw new Error('Opening insertion requires narration and subtitles suppressed.');
  if (Math.abs(Number(timeline.blocks?.[0]?.startSec ?? 0))>0.001 || !timeline.blocks?.[1]) throw new Error('Opening must start at t=0 and have a body block.');
  const project=path.join(root,'projects',episode);
  const hook=(await readFile(path.join(project,'temp','N001.txt'),'utf8')).trim();
  const questions=identity.openingPlan?.questions;
  const count=questions?.length ?? 3;
  if (questions) {
    const actual=hook.match(/[^?.!]+\?/g) ?? [];
    const normalize=s=>s.trim().replace(/\s+/g,' ');
    if (actual.length < count || questions.some((q,i)=>normalize(q)!==normalize(actual[i]))) throw new Error('Opening questions do not match the approved Opening Plan.');
  }
  const first=JSON.parse(await readFile(path.join(project,'temp',`${timeline.blocks[0].sentenceId}.words.json`),'utf8'));
  const next=JSON.parse(await readFile(path.join(project,'temp',`${timeline.blocks[1].sentenceId}.words.json`),'utf8'));
  if (!first.words?.length || !next.words?.length) throw new Error('Opening word timing is missing.');
  const compact = s => String(s).toLowerCase().replace(/[^a-z0-9']/g,'');
  if (compact(hook) !== compact(first.words.map(w=>w.text).join(' '))) throw new Error('Opening word timing does not match approved narration.');
  const questionEnds=first.words.map((w,i)=>/\?$/.test(w.text ?? '') ? i : -1).filter(i=>i>=0);
  if (questionEnds.length<count) throw new Error('Approved opening question boundaries are missing from authoritative word timing.');
  const prepared={...identity,timing:{...identity.timing,
    pauseBeforeIdentitySec:identity.timing.pauseBeforeIdentitySec ?? 2,
    pauseAfterIdentitySec:identity.timing.pauseAfterIdentitySec ?? 1}};
  const third = questionEnds[count-1];
  const intraBlock = third + 1 < first.words.length;
  if (intraBlock) {
    const lastSpoken = first.words.slice(0,third+1).filter(w=>/[a-z0-9]/i.test(w.text)).at(-1);
    const body = first.words.slice(third+1).find(w=>/[a-z0-9]/i.test(w.text));
    if (!lastSpoken || !body || first.words[third].endSec > body.startSec) throw new Error('Question/body word boundary is invalid.');
    const boundary={questionSpeechEndSec:lastSpoken.endSec, questionMarkerEndSec:first.words[third].endSec, bodyStartSec:body.startSec};
    const plan=planOpeningInsertion(prepared,timeline,{...boundary,questionCount:count});
    if (questions && Math.abs(plan.startSec-identity.timing.startSec)>0.001) throw new Error('Opening timing does not match the approved Opening Plan.');
    return {identity:prepared,plan,boundary,timing:{
      question1To2Sec:questionEnds[1] == null || count < 2 ? null : first.words[questionEnds[0]+1].startSec-first.words[questionEnds[0]].endSec,
      question2To3Sec:questionEnds[2] == null || count < 3 ? null : first.words[questionEnds[1]+1].startSec-first.words[questionEnds[1]].endSec,
      questionToIdentitySec:plan.cards[0].startSec-lastSpoken.endSec,
      identityToNarrationSec:body.startSec+plan.durationSec-plan.cards.at(-1).endSec,
      existingGapSec:body.startSec-lastSpoken.endSec,
    }};
  }
  const plan=planOpeningInsertion(prepared,timeline);
  const last=first.words.at(-1).endSec, nextStart=next.words[0].startSec;
  if (![last,nextStart].every(Number.isFinite)) throw new Error('Opening word timing is invalid.');
  return {identity:prepared, plan, timing:{
    question1To2Sec:questionEnds[1] == null || count < 2 ? null : first.words[questionEnds[0]+1].startSec-first.words[questionEnds[0]].endSec,
    question2To3Sec:questionEnds[2] == null || count < 3 ? null : first.words[questionEnds[1]+1].startSec-first.words[questionEnds[1]].endSec,
    questionToIdentitySec:plan.cards[0].startSec-last,
    identityToNarrationSec:plan.startSec+plan.durationSec-plan.cards.at(-1).endSec+nextStart,
  }};
}
