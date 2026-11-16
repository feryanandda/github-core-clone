// The git object layer: an in-memory content-addressed store, tree/commit/tag codecs, packfile
// read/write and the reachability walks the fetch side needs. No git binary, no filesystem: every
// object lives in one Map keyed by its SHA-1, exactly like a bare repository's object database.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_IDS: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object database: sha -> object, with a first-seen sequence for stable orderings. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();
  private readonly seqOf = new Map<string, number>();
  private nextSeq = 0;

  put(type: ObjType, data: Buffer): string {
    const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
    const sha = sha1Hex(Buffer.concat([header, data]));
    if (!this.objects.has(sha)) {
      this.objects.set(sha, { type, data });
      this.seqOf.set(sha, this.nextSeq);
      this.nextSeq += 1;
    }
    return sha;
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  typeOf(sha: string): ObjType | undefined {
    return this.objects.get(sha)?.type;
  }

  /** The order this object first entered the store (ties histories when timestamps agree). */
  seq(sha: string): number {
    return this.seqOf.get(sha) ?? 0;
  }
}

// -------------------------------------------------------------------------------------------------
// Commit / tree / tag codecs.
// -------------------------------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  /** The committer timestamp (seconds), 0 when the line carries none. */
  time: number;
  message: string;
}

function parseIdent(line: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(line);
  return match === null ? 0 : Number(match[1]);
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, time: parseIdent(committerLine), message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  author: string;
  time: number;
  message: string;
}): Buffer {
  const ident = `${input.author} ${input.time} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('latin1', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree order: names sort as bytes, directories as if they ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into path -> {sha, mode} for blobs (mode '40000' entries are descended into). */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> blob map; returns the root tree sha. */
export function treeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { sha: string; mode: string }>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, blob] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const dir = parts[i]!;
      let next = node.dirs.get(dir);
      if (next === undefined) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(dir, next);
      }
      node = next;
    }
    node.files.push({ mode: blob.mode, name: parts[parts.length - 1]!, sha: blob.sha });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}

/** The immediate entries of the tree at `path` ('' = root), or null when the path is no directory. */
export function treeEntriesAt(store: ObjectStore, treeSha: string, path: string): TreeEntry[] | null {
  let current = treeSha;
  if (path === '') {
    const obj = store.get(current);
    return obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : null;
  }
  for (const part of path.split('/')) {
    const obj = store.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === part);
    if (entry === undefined) return null;
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  const obj = store.get(current);
  return obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : null;
}

/** Follow tag objects to the first non-tag object; null when the chain breaks. */
export function peelTag(store: ObjectStore, sha: string): string | null {
  let current = sha;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = store.get(current);
    if (obj === undefined) return null;
    if (obj.type !== 'tag') return current;
    const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (match === null) return null;
    current = match[1]!;
  }
  return null;
}

/** The commit a ref value ultimately names (through tags), or null. */
export function peelToCommit(store: ObjectStore, sha: string): string | null {
  const peeled = peelTag(store, sha);
  if (peeled === null) return null;
  return store.typeOf(peeled) === 'commit' ? peeled : null;
}

/** Every commit reachable from `tips` (inclusive), following parents. */
export function commitClosure(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(sha);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** Is `ancestor` reachable from `descendant` (inclusive) through commit parents? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return commitClosure(store, [descendant]).has(ancestor);
}

/** A common ancestor of two commits (the merge base), or null when the histories never meet. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = commitClosure(store, [a]);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestorsOfA.has(sha)) return sha;
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Ancestors of `tip` in an order with children before parents (for commit listings). */
export function historyFrom(store: ObjectStore, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (sha: string): void => {
    if (seen.has(sha)) return;
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') return;
    seen.add(sha);
    order.push(sha);
    const parents = [...parseCommit(obj.data).parents].sort((x, y) => store.seq(y) - store.seq(x));
    for (const parent of parents) visit(parent);
  };
  visit(tip);
  return order;
}

// -------------------------------------------------------------------------------------------------
// Packfiles.
// -------------------------------------------------------------------------------------------------

function packObjectHeader(type: ObjType, size: number): Buffer {
  const id = TYPE_IDS[type];
  const bytes: number[] = [];
  let first = (id << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize the named objects as a version-2 packfile with no deltas, trailer checksum included. */
export function writePack(store: ObjectStore, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) continue;
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Apply a git delta buffer to a base object, producing the result bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const cmd = delta[pos]!;
    pos += 1;
    if ((cmd & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if ((cmd & (1 << bit)) !== 0) { offset |= delta[pos]! << (8 * bit); pos += 1; }
      for (let bit = 0; bit < 3; bit += 1) if ((cmd & (0x10 << bit)) !== 0) { size |= delta[pos]! << (8 * bit); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (cmd !== 0) {
      out.push(delta.subarray(pos, pos + cmd));
      produced += cmd;
      pos += cmd;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

/**
 * Inflate exactly one zlib stream starting at `offset`: the smallest prefix that inflates cleanly
 * is the stream's end (inflateSync ignores trailing bytes, and any shorter prefix truncates the
 * stream and throws), so a binary search finds where the next object begins.
 */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const whole = inflateSync(buf.subarray(offset));
  let lo = offset + 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const probe = inflateSync(buf.subarray(offset, mid));
      ok = probe.length === whole.length;
    } catch {
      ok = false;
    }
    if (ok) hi = mid;
    else lo = mid + 1;
  }
  return { data: whole, next: lo };
}

/**
 * Read a packfile at `offset`, storing every object (deltas resolved against the store or earlier
 * pack entries). Returns the object count and the offset just past the trailer checksum.
 */
export function readPack(store: ObjectStore, buf: Buffer, offset: number): { count: number; next: number } {
  if (buf.toString('latin1', offset, offset + 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(offset + 4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = buf.readUInt32BE(offset + 8);
  let pos = offset + 12;
  const packStart = offset + 12;
  const byOffset = new Map<number, string>();
  for (let index = 0; index < count; index += 1) {
    const objectStart = pos;
    let byte = buf[pos]!;
    pos += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[pos]!;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | null = null;
    let baseOffset = -1;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset varint back to the base object's start.
      let back = buf[pos]!;
      pos += 1;
      let value = back & 0x7f;
      while ((back & 0x80) !== 0) {
        back = buf[pos]!;
        pos += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = objectStart - value;
      baseSha = byOffset.get(baseOffset) ?? null;
      if (baseSha === null) throw new Error('OFS_DELTA base is not in this pack');
    } else if (typeId === 7) {
      // REF_DELTA: the base object's sha, in the store or earlier in this pack.
      baseSha = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { data, next } = inflateOne(buf, pos);
    pos = next;
    if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, inflated ${data.length}`);
    if (typeId === 6 || typeId === 7) {
      const base = store.get(baseSha!);
      if (base === undefined) throw new Error('delta base object is missing');
      const resolved = applyDelta(base.data, data);
      const sha = store.put(base.type, resolved);
      byOffset.set(objectStart, sha);
    } else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const sha = store.put(type, data);
      byOffset.set(objectStart, sha);
    }
    void packStart;
  }
  // The trailer is the pack's SHA-1; the objects are already stored, so just step past it.
  return { count, next: pos + 20 };
}
