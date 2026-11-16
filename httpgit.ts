// The git smart-HTTP surface: ref advertisements, protocol-v2 ls-refs and fetch, protocol-v0
// fetch, and receive-pack pushes with report-status. Objects move as plain (undeltified)
// packfiles; the store does the reachability math.

import {
  commitClosure,
  isAncestor,
  parseCommit,
  peelTag,
  peelToCommit,
  readPack,
  writePack,
  ZERO_OID,
  type ObjectStore,
} from './git.ts';
import { VIEWER, type Forge, type RepoRec } from './store.ts';
import { sendBody, sendError, type Ctx } from './web.ts';

const AGENT = 'makefun-git/1.0';

// -------------------------------------------------------------------------------------------------
// pkt-lines.
// -------------------------------------------------------------------------------------------------

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');

interface PktRead {
  lines: Buffer[];
  /** What ended the run: a flush packet, a delim packet, or the end of the buffer. */
  terminator: 'flush' | 'delim' | 'eof';
  next: number;
}

/** Read pkt-lines from `offset` until a flush, a delim, or the buffer's end. */
function readPkts(buf: Buffer, offset: number): PktRead {
  const lines: Buffer[] = [];
  let pos = offset;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('latin1', pos, pos + 4);
    if (header === '0000') return { lines, terminator: 'flush', next: pos + 4 };
    if (header === '0001') return { lines, terminator: 'delim', next: pos + 4 };
    if (header === '0002') return { lines, terminator: 'delim', next: pos + 4 };
    const length = Number.parseInt(header, 16);
    if (!Number.isFinite(length) || length < 4 || pos + length > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  return { lines, terminator: 'eof', next: pos };
}

function lineText(line: Buffer): string {
  const text = line.toString('utf8');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Chunk bytes into sideband band-1 packets (payloads stay well under the 64 KiB pkt cap). */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < data.length; i += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), data.subarray(i, i + CHUNK)])));
  }
  if (data.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------------
// Entry point.
// -------------------------------------------------------------------------------------------------

/** Handle one git request: /{owner}/{repo}.git/info/refs|git-upload-pack|git-receive-pack. */
export function handleGit(ctx: Ctx, segments: readonly string[]): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';
  const [owner, repoSegment, ...rest] = segments;
  if (!ctx.authed) {
    sendBody(ctx, 401, 'text/plain; charset=utf-8', Buffer.from('unauthorized\n'));
    return;
  }
  const repoName = repoSegment !== undefined && repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : '';
  const repo = owner === VIEWER.login && repoName !== '' ? forge.repo(repoName) : undefined;
  if (repo === undefined) {
    sendBody(ctx, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n'));
    return;
  }
  const tail = rest.join('/');

  if (method === 'GET' && tail === 'info/refs') {
    advertise(ctx, repo, ctx.url.searchParams.get('service') ?? '');
    return;
  }
  if (method === 'POST' && tail === 'git-upload-pack') {
    uploadPack(ctx, repo);
    return;
  }
  if (method === 'POST' && tail === 'git-receive-pack') {
    receivePack(ctx, repo);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------------
// Advertisements.
// -------------------------------------------------------------------------------------------------

/** The ref lines of an advertisement (no capabilities suffix), HEAD first, refs sorted. */
function advertisedRefs(forge: Forge, repo: RepoRec): { lines: string[]; headTip: string | undefined } {
  const headTip = forge.branchTip(repo, repo.defaultBranch);
  const lines: string[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    lines.push(`${oid} ${name}`);
    if (forge.store.typeOf(oid) === 'tag') {
      const peeled = peelTag(forge.store, oid);
      if (peeled !== null && peeled !== oid) lines.push(`${peeled} ${name}^{}`);
    }
  }
  return { lines, headTip };
}

function advertise(ctx: Ctx, repo: RepoRec, service: string): void {
  const forge = ctx.forge;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendBody(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n'));
    return;
  }
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const parts = [
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow\n'),
      pkt('object-format=sha1\n'),
      FLUSH,
    ];
    sendBody(ctx, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
    return;
  }
  const { lines, headTip } = advertisedRefs(forge, repo);
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    if (headTip !== undefined) parts.push(pkt(`${headTip} HEAD\0${caps}\n`));
    lines.forEach((line, index) => {
      parts.push(pkt(headTip === undefined && index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
    });
  }
  parts.push(FLUSH);
  sendBody(ctx, 200, `application/x-git-${service.slice(4)}-advertisement`, Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------------
// upload-pack: ls-refs and fetch.
// -------------------------------------------------------------------------------------------------

function uploadPack(ctx: Ctx, repo: RepoRec): void {
  const forge = ctx.forge;
  const body = ctx.body;
  const wantsV2 = (ctx.req.headers['git-protocol'] ?? '').includes('version=2') || body.toString('latin1', 0, 64).includes('command=');
  if (!wantsV2) {
    fetchV0(ctx, repo, parseV0Request(body));
    return;
  }
  // Protocol v2: a capability section, a delim, then argument lines up to the flush.
  const first = readPkts(body, 0);
  let command = '';
  for (const line of first.lines) {
    const text = lineText(line);
    if (text.startsWith('command=')) command = text.slice('command='.length);
  }
  let args: Buffer[] = [];
  if (first.terminator === 'delim') {
    args = readPkts(body, first.next).lines;
  }
  const argTexts = args.map(lineText);
  if (command === 'ls-refs') {
    lsRefs(ctx, repo, argTexts);
    return;
  }
  if (command === 'fetch') {
    fetchV2(ctx, repo, parseFetchArgs(argTexts));
    return;
  }
  sendBody(ctx, 400, 'text/plain; charset=utf-8', Buffer.from('unknown command\n'));
}

function lsRefs(ctx: Ctx, repo: RepoRec, args: readonly string[]): void {
  const forge = ctx.forge;
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const lines: string[] = [];
  const headTip = forge.branchTip(repo, repo.defaultBranch);
  if (prefixes.length === 0) {
    if (headTip !== undefined) {
      lines.push(symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}` : `${headTip} HEAD`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    } else if (symrefs) {
      lines.push(`${ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel && forge.store.typeOf(oid) === 'tag') {
      const peeled = peelTag(forge.store, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pkt(`${line}\n`));
  parts.push(FLUSH);
  sendBody(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(argTexts: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const text of argTexts) {
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const value = Number(text.slice(7).trim());
      if (Number.isFinite(value) && value > 0) args.depth = Math.trunc(value);
    } else if (text === 'done') args.done = true;
  }
  return args;
}

function parseV0Request(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let offset = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    const run = readPkts(body, offset);
    for (const line of run.lines) {
      const text = lineText(line);
      // The first want line may carry capabilities after a NUL.
      const clean = text.split('\0')[0]!;
      if (clean.startsWith('want ')) args.wants.push(clean.slice(5).trim());
      else if (clean.startsWith('have ')) args.haves.push(clean.slice(5).trim());
      else if (clean.startsWith('shallow ')) args.shallow.push(clean.slice(8).trim());
      else if (clean.startsWith('deepen ')) {
        const value = Number(clean.slice(7).trim());
        if (Number.isFinite(value) && value > 0) args.depth = Math.trunc(value);
      } else if (clean === 'done') args.done = true;
    }
    offset = run.next;
    if (run.terminator !== 'flush' || offset >= body.length) break;
  }
  return args;
}

// -------------------------------------------------------------------------------------------------
// Fetch planning: which objects the pack holds, and the shallow bookkeeping around it.
// -------------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

function treeClosure(store: ObjectStore, commitSha: string, into: Set<string>): void {
  const commit = store.get(commitSha);
  if (commit === undefined || commit.type !== 'commit') return;
  const stack = [parseCommit(commit.data).tree];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (into.has(sha)) continue;
    const obj = store.get(sha);
    if (obj === undefined) continue;
    into.add(sha);
    if (obj.type === 'tree') {
      const text = obj.data;
      let pos = 0;
      while (pos < text.length) {
        const space = text.indexOf(0x20, pos);
        const nul = text.indexOf(0x00, space);
        stack.push(text.toString('hex', nul + 1, nul + 21));
        pos = nul + 21;
      }
    }
  }
}

function planFetch(forge: Forge, repo: RepoRec, args: FetchArgs): FetchPlan {
  const store = forge.store;
  void repo;
  const shallowSet = new Set(args.shallow);
  // What the client provably holds: the closure of its haves, not crossing its shallow boundary.
  const knownCommits = new Set<string>();
  {
    const stack = [...args.haves];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (knownCommits.has(sha)) continue;
      const commit = peelToCommit(store, sha) ?? sha;
      if (store.typeOf(commit) !== 'commit' || knownCommits.has(commit)) continue;
      knownCommits.add(commit);
      if (!shallowSet.has(commit)) {
        for (const parent of parseCommit(store.get(commit)!.data).parents) stack.push(parent);
      }
    }
  }
  const knownObjects = new Set<string>(knownCommits);
  for (const commit of knownCommits) treeClosure(store, commit, knownObjects);

  // The wants, by generation from the tips (generation 0 = the tips themselves).
  const generation = new Map<string, number>();
  const wantObjects = new Set<string>();
  {
    const queue: Array<{ sha: string; gen: number }> = [];
    for (const want of args.wants) {
      const obj = store.get(want);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        // Walk the tag chain, sending the tag objects; the target commit is a tip.
        let current = want;
        for (let depth = 0; depth < 16; depth += 1) {
          const tagObj = store.get(current);
          if (tagObj === undefined || tagObj.type !== 'tag') break;
          wantObjects.add(current);
          const match = /^object ([0-9a-f]{40})$/m.exec(tagObj.data.toString('utf8'));
          if (match === null) break;
          current = match[1]!;
        }
        const commit = peelToCommit(store, want);
        if (commit !== null) queue.push({ sha: commit, gen: 0 });
      } else if (obj.type === 'commit') {
        queue.push({ sha: want, gen: 0 });
      } else {
        wantObjects.add(want);
      }
    }
    while (queue.length > 0) {
      const { sha, gen } = queue.shift()!;
      const previous = generation.get(sha);
      if (previous !== undefined && previous <= gen) continue;
      if (args.depth !== null && gen >= args.depth) continue;
      generation.set(sha, gen);
      for (const parent of parseCommit(store.get(sha)!.data).parents) queue.push({ sha: parent, gen: gen + 1 });
    }
  }

  const sendCommits = new Set<string>();
  for (const sha of generation.keys()) if (!knownCommits.has(sha)) sendCommits.add(sha);
  const sendObjects = new Set<string>();
  for (const sha of sendCommits) {
    sendObjects.add(sha);
    treeClosure(store, sha, sendObjects);
  }
  for (const sha of wantObjects) sendObjects.add(sha);
  for (const sha of knownObjects) sendObjects.delete(sha);
  // A commit being sent keeps itself even when a shared tree object was deleted above.
  for (const sha of sendCommits) sendObjects.add(sha);

  // Shallow bookkeeping: a sent commit whose parent stays behind is the new boundary; a client
  // boundary commit whose parents all arrive (or were already there) stops being shallow.
  const shallow: string[] = [];
  for (const sha of sendCommits) {
    const parents = parseCommit(store.get(sha)!.data).parents;
    if (parents.some((parent) => !sendCommits.has(parent) && !knownCommits.has(parent))) shallow.push(sha);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    const obj = store.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.every((parent) => sendCommits.has(parent) || knownCommits.has(parent))) unshallow.push(boundary);
  }

  const acks: string[] = [];
  for (const have of args.haves) if (store.has(have) && !acks.includes(have)) acks.push(have);
  return { objects: [...sendObjects], shallow, unshallow, acks };
}

/** Identical fetches (the bench's concurrent clones) reuse one built pack. */
const packCache = new Map<string, Buffer>();

function packFor(store: ObjectStore, objects: readonly string[]): Buffer {
  const key = objects.join(' ');
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(store, objects);
  if (packCache.size >= 32) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

function fetchV2(ctx: Ctx, repo: RepoRec, args: FetchArgs): void {
  const plan = planFetch(ctx.forge, repo, args);
  const pack = packFor(ctx.forge.store, plan.objects);
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  if (plan.acks.length === 0) parts.push(pkt('NAK\n'));
  else for (const ack of plan.acks) parts.push(pkt(`ACK ${ack}\n`));
  if (args.done && plan.acks.length > 0) parts.push(pkt('ready\n'));
  parts.push(DELIM);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sideband(pack));
  parts.push(FLUSH);
  sendBody(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

function fetchV0(ctx: Ctx, repo: RepoRec, args: FetchArgs): void {
  const plan = planFetch(ctx.forge, repo, args);
  const pack = packFor(ctx.forge.store, plan.objects);
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) {
    parts.push(pkt('NAK\n'));
  } else {
    plan.acks.forEach((ack, index) => {
      parts.push(pkt(index === plan.acks.length - 1 ? `ACK ${ack}\n` : `ACK ${ack} common\n`));
    });
  }
  for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  parts.push(sideband(pack));
  parts.push(FLUSH);
  sendBody(ctx, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------------
// receive-pack.
// -------------------------------------------------------------------------------------------------

interface PushCommand {
  from: string;
  to: string;
  ref: string;
}

function receivePack(ctx: Ctx, repo: RepoRec): void {
  const forge = ctx.forge;
  const body = ctx.body;
  const first = readPkts(body, 0);
  const commands: PushCommand[] = [];
  let capabilities = '';
  first.lines.forEach((line, index) => {
    let text = lineText(line);
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        capabilities = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const fields = text.split(' ');
    if (fields.length === 3) commands.push({ from: fields[0]!, to: fields[1]!, ref: fields[2]! });
  });

  let unpackError: string | null = null;
  const rest = body.subarray(first.next);
  if (rest.length >= 4 && rest.toString('latin1', 0, 4) === 'PACK') {
    try {
      readPack(forge.store, body, first.next);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyPush(forge, repo, command));
  }

  const reportStatus = capabilities.includes('report-status');
  const useSideband = capabilities.includes('side-band-64k');
  if (!reportStatus) {
    sendBody(ctx, 200, 'application/x-git-receive-pack-result', Buffer.alloc(0));
    return;
  }
  const reportParts: Buffer[] = [pkt(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`)];
  for (const result of results) {
    reportParts.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportParts.push(FLUSH);
  const report = Buffer.concat(reportParts);
  sendBody(ctx, 200, 'application/x-git-receive-pack-result', useSideband ? Buffer.concat([sideband(report), FLUSH]) : report);
}

function applyPush(forge: Forge, repo: RepoRec, command: PushCommand): { ref: string; ok: boolean; reason?: string } {
  const store = forge.store;
  const { from, to, ref } = command;
  if (to === ZERO_OID) {
    // A delete: removing a ref that is already gone is still a successful delete here.
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  if (!store.has(to)) return { ref, ok: false, reason: 'missing object' };
  const current = repo.refs.get(ref);
  if (from === ZERO_OID) {
    if (current !== undefined) return { ref, ok: false, reason: 'reference already exists' };
    repo.refs.set(ref, to);
    return { ref, ok: true };
  }
  if (current !== from) return { ref, ok: false, reason: 'reference is elsewhere' };
  const fromCommit = peelToCommit(store, from);
  const toCommit = peelToCommit(store, to);
  if (fromCommit !== null && toCommit !== null && fromCommit !== toCommit && !isAncestor(store, fromCommit, toCommit)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, to);
  return { ref, ok: true };
}

export { commitClosure };
