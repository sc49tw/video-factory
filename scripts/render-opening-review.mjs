import {readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {planOpeningInsertion} from './essay-opening-plan.mjs';
import {buildSubtitleTimeline} from './_build-subtitle-timeline.mjs';
import {buildColdOpenTitleCardFilter, buildEndingCardFilter} from './essay-identity-config.mjs';
import {buildAssForceStyle} from './subtitle-config.mjs';

export async function renderOpeningReview({root, episode, identity, input, output, fontPath, ending, run}) {
  const project = path.join(root, 'projects', episode);
  const timeline = JSON.parse(await readFile(path.join(project, 'assembly-timeline.json'), 'utf8'));
  const plan = planOpeningInsertion(identity, timeline);
  const {srtPath, report, cues} = await buildSubtitleTimeline({root, episode, insertion: plan});
  if (!report.passed) throw new Error('Subtitle QA failed');
  if (cues.some(c => c.startSec < plan.startSec + plan.durationSec && c.endSec > plan.startSec)) throw new Error('Subtitle intersects identity');
  const temp = path.join(project, 'temp');
  const rel = file => path.relative(root, file).replaceAll('\\', '/');
  const narrationInputs = timeline.blocks.flatMap(b => ['-i',path.join(project, 'audio', `${b.sentenceId}.mp3`)]);
  const filters = [];
  const cut = plan.shot.absoluteStartSec;
  const base = timeline.plannedDurationSec;
  const end = base + plan.durationSec;
  const total = end + ending.endingHoldSec;
  // Use unused tail of the same approved hook shot, preserving its motion.
  const segments = [
    {file:input,start:0,duration:cut},
    {file:plan.shot.sourcePath,start:0,duration:plan.sourceDuration},
    {file:input,start:plan.startSec,duration:base-plan.startSec},
  ];
  for (const [i, segment] of segments.entries()) {
    segment.output = path.join(temp, `opening-visual-${i}.mp4`);
    await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(segment.start),'-i',segment.file,'-t',String(segment.duration),
      '-an','-vf','scale=960:540:force_original_aspect_ratio=increase,crop=960:540,setsar=1,fps=30',
      '-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',segment.output]);
  }
  const list = path.join(temp,'opening-visual-concat.txt');
  await writeFile(list,segments.map(s=>`file '${path.basename(s.output)}'`).join('\n'));
  filters.push(`[0:v]tpad=stop_mode=clone:stop_duration=${ending.endingHoldSec}[visual]`);
  // Rebuild continuous narration from cached originals, avoiding concat AAC drift.
  timeline.blocks.forEach((block, i) => {
    const duration = block.durationSec + (i === 0 ? plan.durationSec : 0);
    filters.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`);
  });
  filters.push(`${timeline.blocks.map((_,i)=>`[a${i}]`).join('')}concat=n=${timeline.blocks.length}:v=0:a=1,apad,atrim=duration=${total}[audio]`);
  // Convert shared pixel dimensions to libass's default script canvas.
  const styleText = buildAssForceStyle();
  const titleFilters = plan.cards.map(card => buildColdOpenTitleCardFilter({card, fontPath, fontSize: card.kind === 'channel' ? 36 : 24}));
  const endingText = path.join(temp, 'opening-review-ending.txt');
  await writeFile(endingText, ending.text);
  filters.push(`[visual]subtitles=${rel(srtPath)}:force_style='${styleText}',${titleFilters.join(',')},${buildEndingCardFilter({fontPath,textFile:rel(endingText),fontSize:32,baseSec:end})}[video]`);
  const graph = path.join(temp, 'opening-review-filter.txt');
  await writeFile(graph, filters.join(';\n'));
  const stagedOutput = path.join(temp,'opening-review-complete.mp4');
  await run('ffmpeg',['-hide_banner','-loglevel','warning','-y','-filter_complex_threads','1','-f','concat','-safe','0','-i',list,...narrationInputs,
    '-filter_complex_script',graph,'-map','[video]','-map','[audio]','-t',String(total),'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',stagedOutput]);
  await rename(stagedOutput,output);
  const result = {output, opening:plan, durationSec:total, subtitleCount:cues.length, subtitleQaPassed:report.passed, narrationBlocks:timeline.blocks.length};
  await writeFile(path.join(project,'opening-review-render.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
