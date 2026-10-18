// Provisional viewing aid. It creates no package or approval and burns a
// permanent review label. Source and narration are never edited in place.
import {execFileSync} from 'node:child_process';
import {access, mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {assertEditorialPreviewAllowed, validateEditorialShotPlan} from '../src/essy-editorial-preview.mjs';

const [episode,planArg,version]=process.argv.slice(2), root=process.cwd();
if (!/^ESSY-\d+$/.test(episode ?? '') || !planArg || !/^v[1-9]\d*$/.test(version ?? '')) throw new Error('Usage: node scripts/render-essy-editorial-preview.mjs ESSY-0006 <shot-plan.json> v1');
const inside=(p)=>{const absolute=path.resolve(root,p);if (!absolute.startsWith(root+path.sep)) throw new Error(`Path outside repository: ${p}`);return absolute;};
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const state=await read(path.join(root,'projects','_drafts',episode,'state.yaml'));
assertEditorialPreviewAllowed(state);
const manifest=await read(path.join(root,'projects',episode,'manifest.json'));
const plan=await read(inside(planArg));
const shots=Array.isArray(plan)?plan:plan.shots;
const total=(manifest.audio ?? []).reduce((sum,a)=>sum+Number(a.durationSec),0);
validateEditorialShotPlan(shots,total);
const output=path.join(root,'output',episode,'editorial',`${episode}-editorial-${version}.mp4`);
const work=path.join(root,'projects',episode,'temp','editorial',version);
try {await access(output); throw new Error(`Editorial version already exists: ${output}`);} catch(e) {if(e.code!=='ENOENT') throw e;}
await mkdir(path.dirname(output),{recursive:true}); await mkdir(work,{recursive:true});
const run=args=>execFileSync('ffmpeg',['-y','-hide_banner','-loglevel','error',...args],{stdio:'inherit'});
const list=[];
for(const [index,shot] of shots.entries()) {
  const src=inside(shot.input), info=await stat(src);
  if(!info.isFile() || !info.size) throw new Error(`Missing source ${shot.input}`);
  const available=Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',src],{encoding:'utf8'}));
  if (!Number.isFinite(available) || available+0.001<shot.durationSec) throw new Error(`Insufficient footage for ${shot.slotId}.`);
  const file=path.join(work,`${String(index+1).padStart(3,'0')}.mp4`);
  const label=`${shot.slotId}   SOURCE ${shot.mediaId}`;
  run(['-i',src,'-t',String(shot.durationSec),'-vf',`scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='${label}':x=20:y=20:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.8,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='EDITORIAL PREVIEW / NOT FOR RELEASE':x=20:y=55:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.8`, '-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',file]);
  list.push(`file '${file.replaceAll('\\','/')}'`);
}
const videoList=path.join(work,'video.txt'),audioList=path.join(work,'narration.txt');
await writeFile(videoList,list.join('\n')+'\n');
await writeFile(audioList,manifest.audio.map(a=>`file '${inside(a.path).replaceAll('\\','/')}'`).join('\n')+'\n');
// Refuse a race that created the target while segments were rendering.
run(['-f','concat','-safe','0','-i',videoList,'-f','concat','-safe','0','-i',audioList,'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-b:a','128k','-movflags','+faststart',path.join(work,'complete.mp4')]);
const {copyFile,constants}=await import('node:fs/promises').then(async fs=>({...fs,constants:(await import('node:fs')).constants}));
await copyFile(path.join(work,'complete.mp4'),output,constants.COPYFILE_EXCL);
console.log(`Editorial preview (not release): ${output}`);
