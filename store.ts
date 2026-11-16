// The forge state: one viewer, their repositories, and everything the REST, GraphQL and MCP
// surfaces share. All three surfaces call the operations here, so an object created through one
// of them is the same object through the others (same numbers, same ids, same store).

import {
  ObjectStore,
  buildCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
  treeFromFlat,
  ZERO_OID,
  type GitObject,
} from './git.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  /** The global REST id (unique across repositories, stable across reads). */
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The head branch tip when the pull request was opened (fallback if the branch goes away). */
  headShaAtCreate: string;
  seq: number;
}

export interface RepoRec {
  /** The numeric database id, assigned in creation order. */
  id: number;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name (refs/heads/..., refs/tags/...) -> object sha. */
  refs: Map<string, string>;
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber: number;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  seq: number;
}

/** The whole forge: the object database plus the repository records. */
export class Forge {
  readonly store = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private clock = Math.floor(Date.now() / 1000);

  /** A strictly increasing timestamp for server-made commits (deterministic order, no wall ties). */
  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  // ---------------------------------------------------------------- repositories

  createRepo(name: string, isPrivate: boolean, description: string): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      seq: this.repoSeq,
    };
    this.nextRepoId += 1;
    this.repoSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  repo(name: string): RepoRec | undefined {
    return this.repos.get(name);
  }

  repoById(id: number): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  // ---------------------------------------------------------------- refs and commits

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The tree sha a branch (or the repo's default branch when `branch` is null) points at. */
  treeOf(repo: RepoRec, branch: string | null): string | null {
    const tip = branch === null ? this.branchTip(repo, repo.defaultBranch) : this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = this.store.get(tip);
    if (commit === undefined || commit.type !== 'commit') return null;
    return parseCommit(commit.data).tree;
  }

  /** Make one commit on a branch from a full flat file map; returns the commit sha. */
  commitFiles(repo: RepoRec, branch: string, flat: Map<string, { sha: string; mode: string }>, message: string): string {
    const tree = treeFromFlat(this.store, flat);
    const parent = this.branchTip(repo, branch);
    const commit = buildCommit({
      tree,
      parents: parent === undefined ? [] : [parent],
      author: `${VIEWER.name} <${VIEWER.email}>`,
      time: this.tick(),
      message,
    });
    const sha = this.store.put('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, sha);
    return sha;
  }

  /** The flat file map at a branch tip (empty when the branch is unborn). */
  flatAt(repo: RepoRec, branch: string): Map<string, { sha: string; mode: string }> {
    const tree = this.treeOf(repo, branch);
    if (tree === null) return new Map();
    return flattenTree(this.store, tree);
  }

  // ---------------------------------------------------------------- issues and comments

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: IssueRec = {
      number,
      id: this.nextIssueId,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: number,
    };
    this.nextIssueId += 1;
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body, seq: issue.comments.length };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    void repo;
    return comment;
  }

  // ---------------------------------------------------------------- pull requests

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRec = {
      number,
      id: this.nextIssueId,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headShaAtCreate: this.branchTip(repo, headRef) ?? ZERO_OID,
      seq: number,
    };
    this.nextIssueId += 1;
    repo.pulls.set(number, pull);
    return pull;
  }

  /** The flat file map at a commit sha (empty map when the commit is unknown). */
  flatAtCommit(commitSha: string): Map<string, { sha: string; mode: string }> {
    const commit = this.store.get(commitSha);
    if (commit === undefined || commit.type !== 'commit') return new Map();
    return flattenTree(this.store, parseCommit(commit.data).tree);
  }

  /** The merge base commit of a pull request's current head and base tips. */
  pullMergeBase(repo: RepoRec, pull: PullRec): string | null {
    const head = this.branchTip(repo, pull.headRef);
    const base = this.branchTip(repo, pull.baseRef);
    if (head === undefined || base === undefined) return null;
    return mergeBase(this.store, head, base);
  }

  /**
   * Three-way merge of the head branch into the base branch at tree level. Answers the merged
   * flat file map, or the path that conflicts. A path conflicts when both sides changed it away
   * from the merge base with different results.
   */
  mergedFlat(repo: RepoRec, pull: PullRec): { flat: Map<string, { sha: string; mode: string }> } | { conflict: string } {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return { conflict: pull.headRef };
    const base = mergeBase(this.store, headTip, baseTip);
    const ancestorFlat = base === null ? new Map<string, { sha: string; mode: string }>() : this.flatAtCommit(base);
    const headFlat = this.flatAtCommit(headTip);
    const ourFlat = this.flatAtCommit(baseTip);
    const paths = new Set<string>([...ancestorFlat.keys(), ...headFlat.keys(), ...ourFlat.keys()]);
    const result = new Map<string, { sha: string; mode: string }>();
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path)?.sha;
      const head = headFlat.get(path)?.sha;
      const ours = ourFlat.get(path)?.sha;
      let chosen: string | undefined;
      if (head === ours) chosen = ours;
      else if (ancestor === ours) chosen = head;
      else if (ancestor === head) chosen = ours;
      else return { conflict: path };
      if (chosen !== undefined) {
        const entry = [headFlat.get(path), ourFlat.get(path), ancestorFlat.get(path)].find((candidate) => candidate?.sha === chosen);
        result.set(path, { sha: chosen, mode: entry?.mode ?? '100644' });
      }
    }
    return { flat: result };
  }

  /** Can this pull request merge cleanly right now? */
  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    return 'flat' in this.mergedFlat(repo, pull);
  }

  /**
   * Merge a pull request into its base branch. Squash makes one commit with the merged tree on
   * top of the base tip; merge makes a two-parent commit. Null when the merge conflicts.
   */
  mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge'): string | null {
    const merged = this.mergedFlat(repo, pull);
    if ('conflict' in merged) return null;
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return null;
    const tree = treeFromFlat(this.store, merged.flat);
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const message =
      method === 'merge'
        ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`
        : `${pull.title} (#${pull.number})${pull.body === '' ? '' : `\n\n${pull.body}`}`;
    const commit = buildCommit({
      tree,
      parents,
      author: `${VIEWER.name} <${VIEWER.email}>`,
      time: this.tick(),
      message,
    });
    const sha = this.store.put('commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    return sha;
  }

  /** The changed files of a pull request: merge base tree against head tree. */
  pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
    const headTip = this.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
    const base = this.pullMergeBase(repo, pull);
    const fromFlat = base === null ? new Map<string, { sha: string; mode: string }>() : this.flatAtCommit(base);
    const toFlat = this.flatAtCommit(headTip);
    return diffFlats(this.store, fromFlat, toFlat);
  }
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a blob's text (a trailing newline does not make an empty last line). */
function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** Longest-common-subsequence length over lines, for small files; -1 when too large to bother. */
function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > 4_000_000) return -1;
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

function linesOf(store: ObjectStore, sha: string | undefined): string[] {
  if (sha === undefined) return [];
  const obj: GitObject | undefined = store.get(sha);
  if (obj === undefined || obj.type !== 'blob') return [];
  const text = obj.data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The file-level diff between two flat tree maps, with per-file line counts. */
export function diffFlats(
  store: ObjectStore,
  fromFlat: ReadonlyMap<string, { sha: string; mode: string }>,
  toFlat: ReadonlyMap<string, { sha: string; mode: string }>,
): FileChange[] {
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path)?.sha;
    const to = toFlat.get(path)?.sha;
    if (from === to) continue;
    const status: FileChange['status'] = from === undefined ? 'added' : to === undefined ? 'removed' : 'modified';
    const oldLines = linesOf(store, from);
    const newLines = linesOf(store, to);
    const shared = lcsLength(oldLines, newLines);
    const additions = shared === -1 ? newLines.length : newLines.length - shared;
    const deletions = shared === -1 ? oldLines.length : oldLines.length - shared;
    changes.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return changes;
}

export function blobText(store: ObjectStore, sha: string): string | null {
  const obj = store.get(sha);
  return obj !== undefined && obj.type === 'blob' ? obj.data.toString('utf8') : null;
}

export { isAncestor, peelToCommit };
export type { GitObject };
