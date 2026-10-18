// Editorial previews are review aids, never an approval or a release artifact.
export function assertEditorialPreviewAllowed(state) {
  if (String(state?.series ?? '').toUpperCase() !== 'ESSY') throw new Error('Editorial preview requires an ESSY draft.');
  if (state.approvals?.english?.approved !== true) throw new Error('Editorial preview requires approved English.');
  if (state.approvals?.scenes?.approved !== true) throw new Error('Editorial preview requires approved scenes.');
  if (state.prepare?.completed !== true) throw new Error('Editorial preview requires completed PREPARE.');
  if (['archived', 'completed'].includes(state.status)) throw new Error('Editorial preview requires an active draft.');
}

// Candidates are selected by the editor for a provisional preview; no
// candidate-level approval or production asset map is implied.
export function validateEditorialShotPlan(shots, totalSec) {
  if (!Array.isArray(shots) || !shots.length || !(totalSec > 0)) throw new Error('Editorial preview needs shots and canonical narration duration.');
  let end=0;
  for (const shot of shots) {
    if (!/^N\d{3}-S\d+$/.test(shot.slotId ?? '') || !/^[\w-]+$/.test(String(shot.mediaId ?? '')) || typeof shot.input !== 'string' || !shot.input.trim()) throw new Error('Each editorial shot needs a slot, source ID, and input path.');
    if (!Number.isFinite(shot.startSec) || !Number.isFinite(shot.durationSec) || shot.durationSec<=0 || Math.abs(shot.startSec-end)>0.04) throw new Error(`Editorial shot timeline is not contiguous at ${shot.slotId}.`);
    end=shot.startSec+shot.durationSec;
  }
  if (Math.abs(end-totalSec)>0.05) throw new Error('Editorial timeline must cover the complete canonical narration.');
  return true;
}
