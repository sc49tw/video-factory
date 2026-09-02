import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const episode = process.argv[2];
if (!/^ESSY-\d{4}$/.test(episode ?? "")) throw new Error("Usage: node scripts/prepare-essy-real-input.mjs ESSY-0002");
const project = path.join(root, "projects", episode);
const script = await readFile(path.join(project, "script.md"), "utf8");
const selection = JSON.parse(await readFile(path.join(project, "candidate-selection-v2.json"), "utf8"));
const provenance = JSON.parse(await readFile(path.join(project, "sourcing", "downloads", "provenance.json"), "utf8"));
if (selection.summary.selected !== 64 || selection.summary.research !== 0) throw new Error("Selection is not 64 selected / 0 research.");
const selected = new Map(selection.reviews.map((r) => [r.slotId, r]));
const bySlot = new Map(provenance.items.map((item) => [item.slotId, item]));
if (selected.size !== 64 || bySlot.size !== 64) throw new Error("Expected 64 selected slots and 64 provenance items.");
for (const [slotId, review] of selected) {
  const item = bySlot.get(slotId);
  if (!item || item.id !== review.selectedAsset.assetId) throw new Error(`Unresolved selected asset: ${slotId}`);
}
const blocks = [...script.matchAll(/^##\s+(N\d{3})\s*\n([\s\S]*?)(?=^##\s+N\d{3}\s*$|\s*$)/gm)].map((m) => ({id:m[1],text:m[2].trim()}));
if (blocks.length !== 18 || blocks.some((b,i)=>b.id !== `N${String(i+1).padStart(3,"0")}`)) throw new Error("Script must contain N001..N018 exactly once.");
const sourceRoot = path.join(project,"source"); await mkdir(sourceRoot,{recursive:true});
const lesson = {schemaVersion:"1.0",episode,series:"ESSY",subtype:"essay",title:"When the Future Suddenly Becomes Visible",language:"en",renderMode:"essay-narration",voice:{provider:"edge",voice:"en-GB-RyanNeural",rate:"-12%",pitch:"+0Hz",volume:"+0%"},sections:blocks.map((b)=>({id:b.id.toLowerCase(),heading:b.id,narration:[{id:b.id.toLowerCase(),text:b.text,pauseAfterSec:0.6}]}))};
await writeFile(path.join(sourceRoot,"lesson.json"),JSON.stringify(lesson,null,2)+"\n");
const audio=[]; for(const [i,b] of blocks.entries()){const id=`sentence-${String(i+1).padStart(3,"0")}`,file=path.join(project,"audio",`${id}.mp3`);const durationSec=Number(execFileSync("ffprobe",["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",file],{encoding:"utf8"}).trim()); if(!(durationSec>0))throw new Error(`Invalid audio ${id}`);audio.push({id,blockId:b.id.toLowerCase(),path:path.relative(root,file).replaceAll("\\","/"),durationSec, textSha256:createHash("sha256").update(b.text).digest("hex"),speaker:null,tts:{voice:"en-GB-RyanNeural",rate:"-12%",pitch:"+0Hz",volume:"+0%"}})}
const manifest={schemaVersion:"1.0",episode,title:lesson.title,sourceLesson:path.relative(root,path.join(sourceRoot,"lesson.json")).replaceAll("\\","/"),tts:{provider:"edge",voice:"en-GB-RyanNeural",rate:"-12%",pitch:"+0Hz",volume:"+0%"},sentenceCount:18,audio};
await writeFile(path.join(project,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
const visualPlan={schemaVersion:"1.0",episode,strategy:"audio-master-real-assets",shots:audio.map((record,index)=>({sectionId:blocks[index].id,sentenceId:record.id,startSec:0,endSec:record.durationSec+0.6,cues:[]}))};
await writeFile(path.join(project,"visual-plan.json"),JSON.stringify(visualPlan,null,2)+"\n");
console.log(`Prepared ${episode}: blocks=${blocks.length} selected=${selected.size} provenance=${bySlot.size}`);
