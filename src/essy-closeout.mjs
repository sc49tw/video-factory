import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, writeFile, mkdir, lstat, stat, open, unlink, rename} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {readDraftState} from './draft-workflow.mjs';
import {readWorkflow} from './workflow.mjs';
import {parseYouTubeUrl, readPublicationRecord, recordPublicationEvidence, resolveEpisodeLocation, validateEssyCompletion, validatePublicationRecord} from './publication.mjs';
import {digestFile} from './essy-release.mjs';

const exec = promisify(execFile);
const subject = episode => `chore(${episode}): record publication closeout`;
const pathsFor = episode => [`projects/${episode}/publication/closeout.json`, `projects/${episode}/publication/publication-record.json`];

async function git(root, ...args) {
  try {
    return (await exec('git', args, {cwd: root, maxBuffer: 8 * 1024 * 1024, env: {...process.env, GIT_TERMINAL_PROMPT: '0'}})).stdout.trim();
  } catch (error) {
    throw new Error(`Git ${args[0]} failed: ${(error.stderr || error.message).trim()}`, {cause: error});
  }
}

async function assertNoSymlinks(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink not allowed: ${relative}`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
}

async function readOptional(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function bytes(file) {
  try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const encode = value => value === null ? null : value.toString('base64');
const decode = value => value === null ? null : Buffer.from(value, 'base64');
const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);

async function saveRecovery(file, journal) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const data = JSON.stringify(journal);
  const envelope = JSON.stringify({data, sha256:createHash('sha256').update(data).digest('hex')});
  try { await writeFile(temp, envelope, {flag:'wx'}); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}

async function acquireLock(lock) {
  const owner = {pid:process.pid, host:hostname(), token:randomUUID()};
  try {
    const handle = await open(lock, 'wx');
    try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
    return owner;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const reclaim = `${lock}.reclaim`;
  let guard;
  try { guard = await open(reclaim, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another closeout lock recovery is in progress; investigate the reclaim lock.'); throw error; }
  try {
    let existing;
    try { existing = JSON.parse(await readFile(lock, 'utf8')); }
    catch { throw new Error('Another closeout may be running; lock owner is unknown. Investigate the lock before removing it.'); }
    if (existing.host !== hostname() || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || typeof existing.token !== 'string') throw new Error('Another closeout may be running; lock owner cannot be verified. Investigate the lock before removing it.');
    try { process.kill(existing.pid, 0); throw new Error('Another closeout is running; its lock owner is active.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    // Recheck identity while holding the reclaim guard; age alone is never used.
    if (JSON.stringify(existing) !== JSON.stringify(JSON.parse(await readFile(lock, 'utf8')))) throw new Error('Closeout lock changed during recovery; investigate it.');
    await unlink(lock);
    const handle = await open(lock, 'wx');
    try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
    return owner;
  } finally { await guard.close(); await unlink(reclaim); }
}

async function releaseLock(lock, owner) {
  const existing = await readOptional(lock);
  if (existing?.token !== owner.token || existing?.pid !== owner.pid) throw new Error('Closeout lock ownership changed; investigate the lock.');
  await unlink(lock);
}

// Recovery is deliberately limited to the two known closeout files and their index entries.
async function recover(root, file, episode, videoId) {
  const targets = pathsFor(episode);
  const manual = `Closeout recovery cannot safely restore files. Preserve the working tree and index; inspect ${file} and ${targets.join(', ')} before retrying.`;
  let envelope, journal;
  try {
    envelope = await readOptional(file);
    if (!envelope) return;
    if (typeof envelope.data !== 'string' || envelope.sha256 !== createHash('sha256').update(envelope.data).digest('hex')) throw new Error('Corrupt recovery data');
    journal = JSON.parse(envelope.data);
  } catch { throw new Error(manual); }
  if (journal.version !== 1 || journal.episode !== episode || journal.videoId !== videoId || !Array.isArray(journal.files) || journal.files.length !== 2 || journal.files.some((entry, i) => entry.path !== targets[i])) throw new Error(manual);
  for (const entry of journal.files) {
    if (!entry.temp) continue;
    if (path.posix.dirname(entry.temp) !== path.posix.dirname(entry.path) || !/^\.essy-closeout-[0-9a-f-]+\.tmp$/.test(path.posix.basename(entry.temp))) throw new Error(manual);
    const data = await bytes(path.join(root, entry.temp)), expected = decode(entry.expected);
    if (data !== null && (!expected || data.length > expected.length || !data.equals(expected.subarray(0, data.length)))) throw new Error(manual);
  }
  const head = await git(root, 'rev-parse', 'HEAD');
  if (head !== journal.head) {
    if (await git(root, 'rev-parse', `${head}^`) !== journal.head || await git(root, 'log', '-1', '--format=%s', head) !== subject(episode)) throw new Error(manual);
    const changed = (await git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', head)).split('\n').filter(Boolean);
    if (!changed.includes(targets[0]) || changed.some(p => !targets.includes(p))) throw new Error(manual);
    for (const entry of journal.files) {
      if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all', '--', entry.path)) throw new Error(manual);
      const current = await bytes(path.join(root, entry.path));
      if (!equal(current, decode(entry.expected ?? entry.original))) throw new Error(manual);
    }
  } else {
    for (const entry of journal.files) {
      await assertNoSymlinks(root, entry.path);
      const current = await bytes(path.join(root, entry.path));
      if (!equal(current, decode(entry.original)) && (entry.expected === null || !equal(current, decode(entry.expected)))) throw new Error(manual);
      if (await git(root, 'diff', '--cached', '--name-only', '--', entry.path)) {
        if (entry.expected === null) throw new Error(manual);
        const staged = (await exec('git', ['show', `:${entry.path}`], {cwd:root, encoding:'buffer'})).stdout;
        if (!staged.equals(decode(entry.expected))) throw new Error(manual);
      }
    }
    for (const entry of journal.files) {
      if (await git(root, 'diff', '--cached', '--name-only', '--', entry.path)) await git(root, 'restore', '--staged', '--', entry.path);
      const target = path.join(root, entry.path), current = await bytes(target), original = decode(entry.original);
      if (!equal(current, original)) {
        if (entry.expected === null || !equal(current, decode(entry.expected))) throw new Error(manual);
        if (original === null) await unlink(target); else await writeFile(target, original);
      }
    }
  }
  for (const entry of journal.files) {
    if (!entry.temp) continue;
    const temp = path.join(root, entry.temp), data = await bytes(temp), expected = decode(entry.expected);
    if (data !== null) {
      if (!expected || data.length > expected.length || !data.equals(expected.subarray(0, data.length))) throw new Error(manual);
      await unlink(temp);
    }
  }
  await unlink(file);
}

async function approvedArtifact(root, episode) {
  const draft = await readDraftState(root, episode);
  let artifact, authority;
  if (draft) {
    if (draft.series !== 'ESSY' || draft.status !== 'completed' || draft.approvals?.finalAssembly?.approved !== true || draft.approvals?.qa?.approved !== true || draft.approvals?.package?.approved !== true) throw new Error('Completed ESSY with PACKAGE, QA and final approval is required.');
    artifact = draft.approvals.finalAssembly.artifact;
    authority = `projects/_drafts/${episode}/state.yaml`;
  } else {
    const workflow = await readWorkflow(root, episode);
    if (!workflow || workflow.status !== 'completed' || workflow.approvals?.finalQa !== true) throw new Error('Completed ESSY with final approval is required.');
    artifact = workflow.approvals.finalAssemblyArtifact;
    authority = `projects/${episode}/workflow.json`;
  }
  if (!artifact?.path || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) throw new Error('Approved final artifact identity is incomplete.');
  await assertNoSymlinks(root, authority);
  const authorityTracked = await git(root, 'ls-files', '--', authority);
  if (authorityTracked !== authority || await git(root, 'status', '--porcelain=v1', '--', authority)) throw new Error('Approval authority must be tracked and unchanged.');
  const verified = await validateEssyCompletion(root, episode, artifact.path);
  const info = await stat(verified.output);
  if (info.size !== artifact.sizeBytes || await digestFile(verified.output) !== artifact.sha256) throw new Error('Approved final artifact has changed.');
  return {path: artifact.path, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes};
}

function sameCloseout(record, episode, videoId, artifact) {
  return record?.schemaVersion === '1.0' && record.episode === episode && record.videoId === videoId && record.publicationRecord === `projects/${episode}/publication/publication-record.json` && record.finalArtifact?.path === artifact.path && record.finalArtifact?.sha256 === artifact.sha256 && record.finalArtifact?.sizeBytes === artifact.sizeBytes;
}

async function verifyRetryCommit(root, episode, remote, head, record, publication, videoId, artifact) {
  const commits = (await git(root, 'rev-list', '--count', `${remote}..${head}`));
  if (commits !== '1' || await git(root, 'rev-parse', `${head}^`) !== remote || await git(root, 'log', '-1', '--format=%s', head) !== subject(episode)) throw new Error('Unrelated outgoing commits or remote divergence; closeout stopped.');
  const changed = (await git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', head)).split('\n').filter(Boolean).sort();
  const allowed = pathsFor(episode);
  if (!changed.includes(allowed[0]) || changed.some(file => !allowed.includes(file))) throw new Error('Outgoing commit contains unrelated files.');
  if (!sameCloseout(record, episode, videoId, artifact) || publication?.publication?.videoId !== videoId) throw new Error('Outgoing closeout does not match the requested URL or artifact.');
  const validation = validatePublicationRecord(publication, {episode});
  if (!validation.passed || (publication.publication.masterPath && publication.publication.masterPath !== artifact.path)) throw new Error('Outgoing publication evidence is invalid or references a different artifact.');
}

/** Record operator-provided evidence and synchronize only this episode's closeout.
 * A push failure leaves the single closeout commit in place for a safe retry. */
export async function closeoutEssy({factoryRoot, episode, url, testHooks = {}}) {
  const root = path.resolve(factoryRoot);
  if (!/^ESSY-\d{4}$/.test(episode ?? '')) throw new Error('A valid ESSY episode ID is required.');
  const parsed = parseYouTubeUrl(url);
  if (!parsed.passed) throw new Error(`Invalid YouTube URL: ${parsed.reasons.join('; ')}`);
  const lock = path.resolve(root, await git(root, 'rev-parse', '--git-path', 'essy-closeout.lock'));
  const recovery = path.resolve(root, await git(root, 'rev-parse', '--git-path', 'essy-closeout-recovery.json'));
  const owner = await acquireLock(lock);
  try {
    await recover(root, recovery, episode, parsed.videoId);
    return await runCloseout({factoryRoot:root, episode, url, recovery, testHooks});
  } finally { await releaseLock(lock, owner); }
}

async function runCloseout({factoryRoot, episode, url, recovery, testHooks}) {
  if (!/^ESSY-\d{4}$/.test(episode ?? '')) throw new Error('A valid ESSY episode ID is required.');
  const parsed = parseYouTubeUrl(url);
  if (!parsed.passed) throw new Error(`Invalid YouTube URL: ${parsed.reasons.join('; ')}`);
  const root = path.resolve(factoryRoot);
  if (await git(root, 'rev-parse', '--show-toplevel') !== root.replaceAll('\\', '/')) {
    // Git returns slash-separated Windows paths; path.resolve handles both.
    if (path.resolve(await git(root, 'rev-parse', '--show-toplevel')) !== root) throw new Error('Closeout must run at repository root.');
  }
  if (await git(root, 'branch', '--show-current') !== 'main') throw new Error('Closeout requires main.');
  if (await git(root, 'diff', '--cached', '--name-only')) throw new Error('Staged changes must be cleared before closeout.');
  const location = await resolveEpisodeLocation(root, episode);
  if (location.archived) throw new Error('Closeout does not modify archived episodes.');
  const targets = pathsFor(episode);
  for (const target of targets) {
    await assertNoSymlinks(root, target);
    if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all', '--', target)) throw new Error(`Closeout target has local changes: ${target}`);
  }
  const artifact = await approvedArtifact(root, episode);
  const closeoutPath = path.join(root, targets[0]);
  const pubPath = path.join(root, targets[1]);
  let closeout = await readOptional(closeoutPath);
  let publication = await readPublicationRecord(pubPath);
  if (closeout && !sameCloseout(closeout, episode, parsed.videoId, artifact)) throw new Error('Existing closeout conflicts with URL or final artifact.');
  if (publication?.publication && publication.publication.videoId !== parsed.videoId) throw new Error('Existing publication URL conflicts with requested URL.');
  if (publication?.publication) {
    const validation = validatePublicationRecord(publication, {episode});
    if (!validation.passed) throw new Error(`Existing publication evidence is invalid: ${validation.reasons.join('; ')}`);
    if (publication.publication.masterPath && publication.publication.masterPath !== artifact.path) throw new Error('Existing publication refers to a different final artifact.');
  }
  await git(root, 'fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main');
  const remote = await git(root, 'rev-parse', 'refs/remotes/origin/main');
  let head = await git(root, 'rev-parse', 'HEAD');
  if (head !== remote) {
    await verifyRetryCommit(root, episode, remote, head, closeout, publication, parsed.videoId, artifact);
  } else if (!closeout) {
    const journal = {version:1, episode, videoId:parsed.videoId, head, files:[]};
    for (const target of targets) journal.files.push({path:target, original:encode(await bytes(path.join(root, target))), expected:null, temp:null});
    await saveRecovery(recovery, journal);
    const atomicWrite = async (target, contents) => {
      const entry = journal.files.find(item => path.resolve(root, item.path) === path.resolve(target));
      if (!entry) throw new Error('Publication recorder selected an unexpected target.');
      entry.expected = encode(Buffer.from(contents));
      entry.temp = `${path.posix.dirname(entry.path)}/.essy-closeout-${randomUUID()}.tmp`;
      await saveRecovery(recovery, journal);
      await mkdir(path.dirname(target), {recursive:true});
      const temp = path.join(root, entry.temp);
      await writeFile(temp, contents, {flag:'wx'});
      await testHooks.afterTemporaryWrite?.(temp, entry.path);
      if (!equal(await bytes(target), decode(entry.original))) throw new Error(`Closeout target changed during operation: ${entry.path}`);
      await rename(temp, target);
      await testHooks.afterRecordWrite?.(entry.path);
    };
    try {
      const existing = publication?.publication;
      await recordPublicationEvidence({factoryRoot: root, episode, url, publishedAt: existing?.publishedAt ?? null, visibility: existing?.visibility ?? null, writeRecord:atomicWrite});
      closeout = {schemaVersion:'1.0', episode, videoId:parsed.videoId, publicationRecord:targets[1], finalArtifact:artifact};
      await atomicWrite(closeoutPath, `${JSON.stringify(closeout, null, 2)}\n`);
      await git(root, 'add', '--', ...targets);
      await testHooks.afterStage?.();
      const staged = (await git(root, 'diff', '--cached', '--name-only')).split('\n').filter(Boolean).sort();
      if (!staged.includes(targets[0]) || staged.some(file => !targets.includes(file))) throw new Error('Unexpected staged files; no commit made.');
      await git(root, 'diff', '--cached', '--check');
      await git(root, 'commit', '-m', subject(episode));
      await testHooks.afterCommit?.();
      head = await git(root, 'rev-parse', 'HEAD');
      closeout = await readOptional(closeoutPath);
      publication = await readPublicationRecord(pubPath);
      await verifyRetryCommit(root, episode, remote, head, closeout, publication, parsed.videoId, artifact);
      await unlink(recovery);
    } catch (error) {
      try { await recover(root, recovery, episode, parsed.videoId); }
      catch (recoveryError) { throw new Error(`${error.message}\n${recoveryError.message}`, {cause:error}); }
      throw error;
    }
  } else if (!publication?.publication || publication.publication.videoId !== parsed.videoId) {
    throw new Error('Existing closeout has no matching publication record.');
  }
  // Revalidate immediately before any network write; never force push.
  await approvedArtifact(root, episode);
  if (await git(root, 'branch', '--show-current') !== 'main' || await git(root, 'rev-parse', 'HEAD') !== head || await git(root, 'diff', '--cached', '--name-only')) throw new Error('Git state changed during closeout; no push attempted.');
  for (const target of targets) if (await git(root, 'status', '--porcelain=v1', '--untracked-files=all', '--', target)) throw new Error(`Closeout target changed during operation: ${target}`);
  if (head !== remote) await git(root, 'push', 'origin', 'HEAD:refs/heads/main');
  const remoteLine = await git(root, 'ls-remote', '--heads', 'origin', 'refs/heads/main');
  if (remoteLine.split(/\s+/)[0] !== head) throw new Error('Remote HEAD did not confirm closeout; retry with the same URL.');
  return {episode, videoId:parsed.videoId, commit:head, pushed:head !== remote, verification:publication?.publication?.verification ?? 'not-verified'};
}
