import {readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {planOpeningInsertion} from './essay-opening-plan.mjs';
import {buildSubtitleTimeline} from './_build-subtitle-timeline.mjs';
import {buildColdOpenTitleCardFilter, buildEndingCardFilter} from './essay-identity-config.mjs';
import {BILINGUAL_STYLE, buildBilingualSrt, isBilingualEpisode, resolveEpisodeSubtitleConfig} from './_build-bilingual-subtitles.mjs';
import {assForceStyle} from './subtitle-config.mjs';
import {requiresEssyReleaseEvidence} from '../src/essy-release.mjs';
import {verifyEssyOpeningGrammar} from '../src/essy-opening-grammar.mjs';

export async function renderOpeningReview({root, episode, identity, title, input, output, fontPath, ending, run, log = console.log}) {
  const project = path.join(root, 'projects', episode);
  const timeline = JSON.parse(await readFile(path.join(project, 'assembly-timeline.json'), 'utf8'));
  const verified = requiresEssyReleaseEvidence(episode) ? await verifyEssyOpeningGrammar({root,episode,identity,timeline,title}) : null;
  const plan = verified?.plan ?? planOpeningInsertion(identity, timeline);
  if (verified) log(`OPENING grammar timing: ${JSON.stringify(verified.timing)}`);
  const {resolveSubtitleConfig} = await import('./subtitle-config.mjs');
  const subtitleConfig = resolveSubtitleConfig(resolveEpisodeSubtitleConfig(episode));
  const {srtPath, report, cues} = await buildSubtitleTimeline({root, episode, insertion: plan, config: subtitleConfig});
  if (!report.passed) throw new Error('Subtitle QA failed');
  if (cues.some(c => c.startSec < plan.startSec + plan.durationSec && c.endSec > plan.startSec)) throw new Error('Subtitle intersects identity');
  const temp = path.join(project, 'temp');
  const rel = file => path.relative(root, file).replaceAll('\\', '/');
  const manifest=JSON.parse(await readFile(path.join(project,'manifest.json'),'utf8'));
  const narrationInputs = timeline.blocks.flatMap(b => {
    const audio=manifest.audio?.find(a=>a.id===b.sentenceId);
    return ['-i',audio?.path ? path.resolve(root,audio.path) : path.join(project, 'audio', `${b.sentenceId}.mp3`)];
  });
  const filters = [];
  const cut = plan.startSec;
  const base = timeline.plannedDurationSec;
  const end = base + plan.durationSec;
  const total = end + ending.endingHoldSec;
  // ---- Bilingual (English + Traditional Chinese) burn-in ------------------
  // GENERATED from the authoritative English SRT produced above (which already
  // carries the identity insertion), gated for completeness, then burned. Never
  // a hand-maintained side file: a missing or placeholder translation aborts the
  // render instead of reaching the picture.
  let finalSrtPath = srtPath;
  let finalStyleConfig = subtitleConfig;
  if (isBilingualEpisode(episode)) {
    const bilingual = await buildBilingualSrt({
      root, episode, englishSrtPath: srtPath, log,
      outputPath: path.join(temp, `${episode}-subtitles-bilingual.srt`),
    });
    finalSrtPath = bilingual.srtPath;
    finalStyleConfig = {
      ...subtitleConfig,
      STYLE: {...subtitleConfig.STYLE, FONT_SIZE: BILINGUAL_STYLE.FONT_SIZE, MARGIN_V: BILINGUAL_STYLE.MARGIN_V},
      MAX_CHARS: BILINGUAL_STYLE.MAX_CHARS,
    };
  }
  // Use unused tail of the same approved hook shot, preserving its motion.
  const segments = [
    {file:input,start:0,duration:cut},
    plan.intraBlock ? {file:input,start:Math.max(0,cut-1/30),duration:plan.durationSec,hold:true} : {file:plan.shot.sourcePath,start:cut - plan.shot.absoluteStartSec,duration:plan.durationSec},
    {file:input,start:plan.startSec,duration:base-plan.startSec},
  ];
  for (const [i, segment] of segments.entries()) {
    segment.output = path.join(temp, `opening-visual-${i}.mp4`);
    await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-ss',String(segment.start),'-i',segment.file,'-t',String(segment.duration),
      '-an','-vf',`${segment.hold ? `trim=duration=0.034,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${segment.duration},` : ''}scale=960:540:force_original_aspect_ratio=increase,crop=960:540,setsar=1,fps=30`,
      '-c:v','libx264','-preset','veryfast','-crf','18','-pix_fmt','yuv420p',segment.output]);
  }
  const list = path.join(temp,'opening-visual-concat.txt');
  await writeFile(list,segments.map(s=>`file '${path.basename(s.output)}'`).join('\n'));
  filters.push(`[0:v]tpad=stop_mode=clone:stop_duration=${ending.endingHoldSec}[visual]`);
  // Rebuild continuous narration from cached originals, avoiding concat AAC drift.
  timeline.blocks.forEach((block, i) => {
    if (i === 0 && plan.intraBlock) {
      const localCut=plan.startSec-block.startSec;
      filters.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[pre][post]`);
      filters.push(`[pre]atrim=0:${localCut},asetpts=PTS-STARTPTS[head]`);
      filters.push(`[post]atrim=start=${localCut},asetpts=PTS-STARTPTS[tail]`);
      filters.push(`anullsrc=r=48000:cl=stereo:d=${plan.durationSec}[sil]`);
      filters.push(`[head][sil][tail]concat=n=3:v=0:a=1,apad,atrim=duration=${block.durationSec + plan.durationSec}[a${i}]`);
      return;
    }
    const duration = block.durationSec + (i === 0 ? plan.durationSec : 0);
    filters.push(`[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const music = ending.music?.extendedPath;
  filters.push(`${timeline.blocks.map((_,i)=>`[a${i}]`).join('')}concat=n=${timeline.blocks.length}:v=0:a=1,apad,atrim=duration=${total}[narration]`);
  if (music) {
    const gain = Math.pow(10, (ending.music.gainDb ?? -9) / 20);
    filters.push(`[${timeline.blocks.length + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${gain},atrim=duration=${total}[music]`);
    filters.push(`[narration][music]amix=inputs=2:duration=first:normalize=0[audio]`);
  } else filters.push('[narration]anull[audio]');
  // Convert shared pixel dimensions to libass's default script canvas.
  // Shared resolver: the 1080p final master burns the same SRT through the same
  // expression, so review/final subtitle presentation cannot drift.
  const styleText = assForceStyle(finalStyleConfig.STYLE);
  // Write title card texts to files to avoid filtergraph quoting issues.
  const titleCardFilters = [];
  for (const [i, card] of plan.cards.entries()) {
    const textFile = path.join(temp, `opening-title-${i}.txt`);
    await writeFile(textFile, card.text);
    const fontSize = card.kind === 'channel' ? 36 : 24;
    const start = Number(card.startSec ?? 0);
    const end = Number(card.endSec ?? start);
    const fadeIn = Number(card.fadeInDurSec ?? 0.5);
    const fadeOut = Number(card.fadeOutDurSec ?? 0.4);
    const fadeOutStart = Math.max(end - fadeOut, start);
    const alpha =
      `'if(lt(t,${start.toFixed(3)}),0,if(lt(t,${(start + fadeIn).toFixed(3)}),` +
      `(t-${start.toFixed(3)})/${fadeIn.toFixed(3)},if(lt(t,${fadeOutStart.toFixed(3)}),1,` +
      `if(lt(t,${end.toFixed(3)}),(${end.toFixed(3)}-t)/${fadeOut.toFixed(3)},0))))'`;
    titleCardFilters.push(
      `drawtext=fontfile=${fontPath}:textfile=${rel(textFile)}:expansion=none:fontcolor=white:` +
      `fontsize=${fontSize}:borderw=1:bordercolor=black@0.6:shadowcolor=black@0.45:shadowx=1:shadowy=1:` +
      `x=(w-text_w)/2:y=h*0.40:alpha=${alpha}`
    );
  }
  const visualFilters = [`subtitles=${rel(finalSrtPath)}:force_style='${styleText}'`, ...titleCardFilters];
  if (ending.endCard?.source !== 'none') {
    const endingText = path.join(temp, 'opening-review-ending.txt');
    await writeFile(endingText, ending.text);
    visualFilters.push(buildEndingCardFilter({fontPath,textFile:rel(endingText),fontSize:32,baseSec:end}));
  }
  filters.push(`[visual]${visualFilters.join(',')}[video]`);
  const graph = path.join(temp, 'opening-review-filter.txt');
  await writeFile(graph, filters.join(';\n'));
  const stagedOutput = path.join(temp,'opening-review-complete.mp4');
  await run('ffmpeg',['-hide_banner','-loglevel','warning','-y','-filter_complex_threads','1','-f','concat','-safe','0','-i',list,...narrationInputs,...(music ? ['-i',path.resolve(root,music)] : []),
    '-filter_complex_script',graph,'-map','[video]','-map','[audio]','-t',String(total),'-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-movflags','+faststart',stagedOutput]);
  await rename(stagedOutput,output);
  const result = {
    output,
    opening: plan,
    durationSec: total,
    subtitleCount: cues.length,
    subtitleQaPassed: report.passed,
    bilingual: isBilingualEpisode(episode),
    narrationBlocks: timeline.blocks.length,
    masterInput: path.relative(root, input).replaceAll('\\', '/'),
  };
  await writeFile(path.join(project,'opening-review-render.json'),JSON.stringify(result,null,2));
  log(JSON.stringify(result,null,2));
}
