import {writeFile} from 'node:fs/promises';
import path from 'node:path';

// Compose the two untouched source sections around a still of the last frame.
// Each segment has identical codec parameters for concat-demuxer timestamps.
export async function renderOpeningVisualHold({run, source, inPointSec=0, cutSec, sourceDurationSec, holdSec, width, height, fps, work, output}) {
  if (!(cutSec > 0 && cutSec < sourceDurationSec && holdSec > 0)) throw new Error('Invalid visual hold boundary.');
  const still=path.join(work,'opening-hold-frame.png');
  const parts=['opening-head.mp4','opening-hold.mp4','opening-tail.mp4'].map(n=>path.join(work,n));
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(Math.max(inPointSec,inPointSec+cutSec-1/fps)),'-i',source,'-frames:v','1',still]);
  const vf=`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`;
  const encode=async (inputArgs,duration,out)=>run('ffmpeg',['-hide_banner','-loglevel','error','-y',...inputArgs,'-t',String(duration),'-vf',vf,'-an','-c:v','libx264','-preset','ultrafast','-crf','18','-pix_fmt','yuv420p',out]);
  await encode(['-ss',String(inPointSec),'-i',source],cutSec,parts[0]);
  await encode(['-loop','1','-framerate',String(fps),'-i',still],holdSec,parts[1]);
  await encode(['-ss',String(inPointSec+cutSec),'-i',source],sourceDurationSec-cutSec,parts[2]);
  const list=path.join(work,'opening-hold-concat.txt');
  await writeFile(list,parts.map(p=>`file '${path.basename(p)}'`).join('\n'));
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',list,'-c','copy',output]);
  return output;
}
