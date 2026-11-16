// The REST v3 surface: /api/v3 root, meta, the viewer, repositories, contents, refs, branches,
// commits, labels, issues, comments and pull requests. Every answer is JSON with a message on
// errors, and every write lands in the shared Forge store the other surfaces read.

import { flattenTree, historyFrom, parseCommit, treeEntriesAt } from './git.ts';
import { VIEWER, type CommentRec, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { BAD_JSON, isRecord, jsonBody, sendEmpty, sendError, sendJson, strField, type Ctx } from './web.ts';

// -------------------------------------------------------------------------------------------------
// Views.
// -------------------------------------------------------------------------------------------------

function userView(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' };
}

export function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

export function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: issue.comments.length,
  };
}

export function commentView(comment: CommentRec): Record<string, unknown> {
  return { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id } };
}

export function pullView(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${VIEWER.login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${VIEWER.login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? forge.pullMergeable(repo, pull) : null,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

// -------------------------------------------------------------------------------------------------
// Pagination.
// -------------------------------------------------------------------------------------------------

interface Page {
  perPage: number;
  page: number;
}

function pageOf(ctx: Ctx): Page {
  const perRaw = Number(ctx.url.searchParams.get('per_page'));
  const pageRaw = Number(ctx.url.searchParams.get('page'));
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(perRaw))) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

/** Slice `items` for the page and set the Link header GitHub-style (absolute, same-origin). */
function paginate<T>(ctx: Ctx, items: readonly T[]): T[] {
  const { perPage, page } = pageOf(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = ctx.req.headers.host ?? 'localhost';
  const base = `http://${host}${ctx.url.pathname}`;
  const withPage = (target: number): string => {
    const params = new URLSearchParams(ctx.url.searchParams);
    params.set('page', String(target));
    params.set('per_page', String(perPage));
    return `${base}?${params.toString()}`;
  };
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < lastPage) links.push(`<${withPage(page + 1)}>; rel="next"`, `<${withPage(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${withPage(1)}>; rel="first"`, `<${withPage(page - 1)}>; rel="prev"`);
  if (links.length > 0) ctx.res.setHeader('link', links.join(', '));
  return slice;
}

// -------------------------------------------------------------------------------------------------
// The router for everything under /api/v3.
// -------------------------------------------------------------------------------------------------

/** Handle one /api/v3 request. The path arrives with the /api/v3 prefix stripped. */
export function handleRest(ctx: Ctx, segments: readonly string[]): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';
  const [first, second] = segments;

  // Public reads: the API root and the meta document (the starter answered the root unauthenticated,
  // and the protocol checks read both shapes).
  if (method === 'GET' && segments.length === 0) {
    sendJson(
      ctx,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }
  if (method === 'GET' && first === 'meta' && segments.length === 1) {
    sendJson(ctx, 200, { installed_version: '1.0.0-makefun-github-core-clone', verifiable_password_authentication: false });
    return;
  }

  if (!ctx.authed) {
    sendError(ctx, 401, 'Bad credentials');
    return;
  }

  if (first === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(ctx, 200, userView());
    return;
  }
  if (first === 'user' && second === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id).map(repoView);
      sendJson(ctx, 200, paginate(ctx, all));
      return;
    }
    if (method === 'POST') {
      createRepo(ctx);
      return;
    }
  }
  if (first === 'repos' && segments.length >= 3) {
    handleRepo(ctx, segments[1]!, segments[2]!, segments.slice(3));
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function createRepo(ctx: Ctx): void {
  const body = jsonBody(ctx);
  if (body === BAD_JSON || !isRecord(body)) {
    sendError(ctx, 400, 'Problems parsing JSON');
    return;
  }
  const name = strField(body, 'name');
  if (name === undefined || name === '' || /[\s/]/.test(name)) {
    sendError(ctx, 422, 'Validation Failed: name is invalid');
    return;
  }
  if (ctx.forge.repo(name) !== undefined) {
    sendError(ctx, 422, 'Validation Failed: name already exists on this account');
    return;
  }
  const repo = ctx.forge.createRepo(name, body.private === true, strField(body, 'description') ?? '');
  if (body.auto_init === true) {
    const blob = ctx.forge.store.put('blob', Buffer.from(`# ${name}\n`, 'utf8'));
    ctx.forge.commitFiles(repo, repo.defaultBranch, new Map([[ 'README.md', { sha: blob, mode: '100644' } ]]), 'Initial commit');
  }
  sendJson(ctx, 201, repoView(repo));
}

// -------------------------------------------------------------------------------------------------
// One repository's subtree.
// -------------------------------------------------------------------------------------------------

function handleRepo(ctx: Ctx, owner: string, name: string, rest: readonly string[]): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';
  if (owner !== VIEWER.login) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const repo = forge.repo(name);
  if (repo === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const [head, ...tail] = rest;

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoView(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON || !isRecord(body)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const description = strField(body, 'description');
      if (description !== undefined) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(ctx, 200, repoView(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.repos.delete(name);
      sendEmpty(ctx, 204);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  switch (head) {
    case 'contents':
      handleContents(ctx, repo, tail.join('/'));
      return;
    case 'git':
      if (tail[0] === 'refs') {
        handleRefs(ctx, repo, tail.slice(1));
        return;
      }
      break;
    case 'branches':
      handleBranches(ctx, repo, tail);
      return;
    case 'commits':
      if (method === 'GET' && tail.length === 0) {
        handleCommits(ctx, repo);
        return;
      }
      break;
    case 'labels':
      handleLabels(ctx, repo, tail);
      return;
    case 'issues':
      handleIssues(ctx, repo, tail);
      return;
    case 'pulls':
      handlePulls(ctx, repo, tail);
      return;
    default:
      break;
  }
  sendError(ctx, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------------
// Contents.
// -------------------------------------------------------------------------------------------------

/** The tree sha a `ref` query value names: a branch, else a commit sha, else the default branch. */
function treeForRef(ctx: Ctx, repo: RepoRec, ref: string | undefined): string | null {
  const forge = ctx.forge;
  if (ref === undefined || ref === '') return forge.treeOf(repo, null);
  const branchTree = forge.treeOf(repo, ref);
  if (branchTree !== null) return branchTree;
  const obj = forge.store.get(ref);
  if (obj !== undefined && obj.type === 'commit') return parseCommit(obj.data).tree;
  return null;
}

function base64Wrapped(data: Buffer): string {
  const raw = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 60) lines.push(raw.slice(i, i + 60));
  return `${lines.join('\n')}\n`;
}

function fileView(path: string, sha: string, data: Buffer): Record<string, unknown> {
  const name = path.split('/').pop() ?? path;
  return { type: 'file', name, path, sha, size: data.length, encoding: 'base64', content: base64Wrapped(data) };
}

function handleContents(ctx: Ctx, repo: RepoRec, path: string): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';

  if (method === 'GET') {
    const tree = treeForRef(ctx, repo, ctx.url.searchParams.get('ref') ?? undefined);
    if (tree === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (path !== '') {
      const flat = flattenTree(forge.store, tree);
      const file = flat.get(path);
      if (file !== undefined) {
        const blob = forge.store.get(file.sha);
        sendJson(ctx, 200, fileView(path, file.sha, blob?.data ?? Buffer.alloc(0)));
        return;
      }
    }
    const entries = treeEntriesAt(forge.store, tree, path);
    if (entries === null) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(
      ctx,
      200,
      entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: path === '' ? entry.name : `${path}/${entry.name}`,
        sha: entry.sha,
      })),
    );
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = jsonBody(ctx);
    if (body === BAD_JSON || !isRecord(body)) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    if (path === '') {
      sendError(ctx, 422, 'Validation Failed: path is required');
      return;
    }
    const branch = strField(body, 'branch') ?? repo.defaultBranch;
    // A write on a branch that does not exist yet starts it from the default branch's tip (the
    // contents route that creates a branch); the default branch itself may be unborn.
    if (forge.branchTip(repo, branch) === undefined && branch !== repo.defaultBranch) {
      const defaultTip = forge.branchTip(repo, repo.defaultBranch);
      if (defaultTip === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
    }
    const flat = forge.flatAt(repo, branch);
    const existing = flat.get(path);
    const message = strField(body, 'message') ?? (method === 'PUT' ? `Update ${path}` : `Delete ${path}`);

    if (method === 'DELETE') {
      if (existing === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (strField(body, 'sha') !== existing.sha) {
        sendError(ctx, 409, 'Conflict: the sha does not match the file');
        return;
      }
      flat.delete(path);
      const commitSha = forge.commitFiles(repo, branch, flat, message);
      sendJson(ctx, 200, { content: null, commit: { sha: commitSha } });
      return;
    }

    const content = strField(body, 'content');
    if (content === undefined) {
      sendError(ctx, 422, 'Validation Failed: content is required');
      return;
    }
    const bytes = Buffer.from(content, 'base64');
    const sha = strField(body, 'sha');
    if (existing !== undefined && sha !== existing.sha) {
      sendError(ctx, 409, 'Conflict: the sha does not match the file');
      return;
    }
    if (existing === undefined && sha !== undefined) {
      sendError(ctx, 422, 'Validation Failed: sha supplied for a file that does not exist');
      return;
    }
    const blobSha = forge.store.put('blob', bytes);
    flat.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
    const commitSha = forge.commitFiles(repo, branch, flat, message);
    sendJson(ctx, existing === undefined ? 201 : 200, {
      content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: bytes.length, encoding: 'base64' },
      commit: { sha: commitSha },
    });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------------
// Refs and branches.
// -------------------------------------------------------------------------------------------------

function refView(forge: Forge, ref: string, sha: string): Record<string, unknown> {
  return { ref, object: { sha, type: forge.store.typeOf(sha) ?? 'commit' } };
}

function handleRefs(ctx: Ctx, repo: RepoRec, tail: readonly string[]): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';
  if (method === 'POST' && tail.length === 0) {
    const body = jsonBody(ctx);
    if (body === BAD_JSON || !isRecord(body)) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const ref = strField(body, 'ref');
    const sha = strField(body, 'sha');
    if (ref === undefined || !ref.startsWith('refs/') || sha === undefined || !forge.store.has(sha)) {
      sendError(ctx, 422, 'Validation Failed: ref and a known sha are required');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(ctx, 422, 'Validation Failed: Reference already exists');
      return;
    }
    repo.refs.set(ref, sha);
    sendJson(ctx, 201, refView(forge, ref, sha));
    return;
  }
  if (method === 'GET') {
    if (tail.length === 0) {
      sendJson(ctx, 200, [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, sha]) => refView(forge, ref, sha)));
      return;
    }
    const wanted = `refs/${tail.join('/')}`;
    const exact = repo.refs.get(wanted);
    if (exact !== undefined) {
      sendJson(ctx, 200, refView(forge, wanted, exact));
      return;
    }
    // A prefix (refs, refs/heads, refs/tags) lists everything under it.
    const listed = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith(`${wanted}/`))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([ref, sha]) => refView(forge, ref, sha));
    if (listed.length > 0) {
      sendJson(ctx, 200, listed);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

function handleBranches(ctx: Ctx, repo: RepoRec, tail: readonly string[]): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';
  if (method !== 'GET') {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(ctx, 200, branches);
    return;
  }
  const branch = tail.join('/');
  const tip = forge.branchTip(repo, branch);
  if (tip === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, { name: branch, commit: { sha: tip }, protected: false });
}

function handleCommits(ctx: Ctx, repo: RepoRec): void {
  const forge = ctx.forge;
  const shaParam = ctx.url.searchParams.get('sha');
  let tip: string | undefined;
  if (shaParam === null || shaParam === '') tip = forge.branchTip(repo, repo.defaultBranch);
  else tip = forge.branchTip(repo, shaParam) ?? (forge.store.typeOf(shaParam) === 'commit' ? shaParam : undefined);
  if (tip === undefined) {
    sendJson(ctx, 200, []);
    return;
  }
  const views = historyFrom(forge.store, tip).map((sha) => {
    const commit = parseCommit(forge.store.get(sha)!.data);
    const ident = /^(.*?) <(.*?)>/.exec(commit.committerLine);
    return {
      sha,
      commit: {
        message: commit.message.replace(/\n+$/, ''),
        author: { name: ident?.[1] ?? '', email: ident?.[2] ?? '', date: new Date(commit.time * 1000).toISOString() },
        committer: { name: ident?.[1] ?? '', email: ident?.[2] ?? '', date: new Date(commit.time * 1000).toISOString() },
        tree: { sha: commit.tree },
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  sendJson(ctx, 200, paginate(ctx, views));
}

// -------------------------------------------------------------------------------------------------
// Labels.
// -------------------------------------------------------------------------------------------------

function handleLabels(ctx: Ctx, repo: RepoRec, tail: readonly string[]): void {
  const method = ctx.req.method ?? 'GET';
  if (method === 'POST' && tail.length === 0) {
    const body = jsonBody(ctx);
    if (body === BAD_JSON || !isRecord(body)) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const name = strField(body, 'name');
    if (name === undefined || name === '') {
      sendError(ctx, 422, 'Validation Failed: name is required');
      return;
    }
    if (repo.labels.has(name)) {
      sendError(ctx, 422, 'Validation Failed: Label already exists');
      return;
    }
    const color = strField(body, 'color') ?? 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(ctx, 201, { name, color, default: false });
    return;
  }
  if (method === 'GET' && tail.length === 0) {
    sendJson(ctx, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------------
// Issues and comments.
// -------------------------------------------------------------------------------------------------

/** The label names a create/update body asks for: strings, or {name} objects. */
function labelNames(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else if (isRecord(entry) && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

function handleIssues(ctx: Ctx, repo: RepoRec, tail: readonly string[]): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';
  const [head, sub] = tail;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(ctx, 200, paginate(ctx, issues.map((issue) => issueView(repo, issue))));
      return;
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON || !isRecord(body)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const title = strField(body, 'title');
      if (title === undefined || title === '') {
        sendError(ctx, 422, 'Validation Failed: title is required');
        return;
      }
      const labels = labelNames(body);
      if (labels === null) {
        sendError(ctx, 422, 'Validation Failed: labels must be names');
        return;
      }
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          sendError(ctx, 422, `Validation Failed: label "${name}" does not exist`);
          return;
        }
      }
      const issue = forge.createIssue(repo, title, strField(body, 'body') ?? '', labels);
      sendJson(ctx, 201, issueView(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number(head);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, 200, issueView(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON || !isRecord(body)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const state = strField(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = strField(body, 'title');
      if (title !== undefined && title !== '') issue.title = title;
      const text = strField(body, 'body');
      if (text !== undefined) issue.body = text;
      const labels = labelNames(body);
      if (labels !== null && body.labels !== undefined) {
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            sendError(ctx, 422, `Validation Failed: label "${name}" does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
      sendJson(ctx, 200, issueView(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail.length === 2 && sub === 'comments') {
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map(commentView));
      return;
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON || !isRecord(body)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const text = strField(body, 'body');
      if (text === undefined) {
        sendError(ctx, 422, 'Validation Failed: body is required');
        return;
      }
      const comment = forge.addComment(repo, issue, text);
      sendJson(ctx, 201, commentView(comment));
      return;
    }
  }
  sendError(ctx, 404, 'Not Found');
}

// -------------------------------------------------------------------------------------------------
// Pull requests.
// -------------------------------------------------------------------------------------------------

/** A head/base value as a branch name: strips an "owner:" prefix when one is present. */
function branchNameOf(value: string): string {
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function handlePulls(ctx: Ctx, repo: RepoRec, tail: readonly string[]): void {
  const forge = ctx.forge;
  const method = ctx.req.method ?? 'GET';
  const [head, sub] = tail;

  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      sendJson(ctx, 200, paginate(ctx, pulls.map((pull) => pullView(forge, repo, pull))));
      return;
    }
    if (method === 'POST') {
      const body = jsonBody(ctx);
      if (body === BAD_JSON || !isRecord(body)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const title = strField(body, 'title');
      const headRef = strField(body, 'head');
      const baseRef = strField(body, 'base');
      if (title === undefined || title === '' || headRef === undefined || baseRef === undefined) {
        sendError(ctx, 422, 'Validation Failed: title, head and base are required');
        return;
      }
      const headBranch = branchNameOf(headRef);
      const baseBranch = branchNameOf(baseRef);
      const headTip = forge.branchTip(repo, headBranch);
      const baseTip = forge.branchTip(repo, baseBranch);
      if (headTip === undefined || baseTip === undefined) {
        sendError(ctx, 422, 'Validation Failed: head or base branch does not exist');
        return;
      }
      if (headBranch === baseBranch) {
        sendError(ctx, 422, 'Validation Failed: head and base are the same branch');
        return;
      }
      const duplicate = [...repo.pulls.values()].some(
        (pull) => pull.state === 'open' && pull.headRef === headBranch && pull.baseRef === baseBranch,
      );
      if (duplicate) {
        sendError(ctx, 422, `Validation Failed: A pull request already exists for ${VIEWER.login}:${headBranch}.`);
        return;
      }
      const pull = forge.createPull(repo, title, strField(body, 'body') ?? '', headBranch, baseBranch);
      sendJson(ctx, 201, pullView(forge, repo, pull));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = Number(head);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail.length === 1 && method === 'GET') {
    sendJson(ctx, 200, pullView(forge, repo, pull));
    return;
  }
  if (tail.length === 2 && sub === 'files' && method === 'GET') {
    sendJson(ctx, 200, forge.pullFiles(repo, pull).map((change) => ({ ...change })));
    return;
  }
  if (tail.length === 2 && sub === 'merge' && method === 'PUT') {
    const body = jsonBody(ctx);
    if (body === BAD_JSON) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    if (pull.state !== 'open' || pull.merged) {
      sendError(ctx, 405, 'Pull Request is not mergeable');
      return;
    }
    const methodWanted = isRecord(body) ? strField(body, 'merge_method') : undefined;
    const sha = forge.mergePull(repo, pull, methodWanted === 'merge' ? 'merge' : 'squash');
    if (sha === null) {
      sendError(ctx, 405, 'Pull Request is not mergeable');
      return;
    }
    sendJson(ctx, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  sendError(ctx, 404, 'Not Found');
}
