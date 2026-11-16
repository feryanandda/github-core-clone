// The MCP surface: Streamable HTTP JSON-RPC at /mcp. It answers the modern server/discover
// probe (and the legacy initialize handshake), lists a fixed tool set, and runs the tools
// against the same Forge store as REST and GraphQL — an object made here is the same object
// everywhere else.

import { VIEWER, type Forge, type RepoRec } from './store.ts';
import { issueView, pullView, repoView } from './rest.ts';
import { isRecord, sendEmpty, sendJson, type Ctx } from './web.ts';

const SERVER_INFO = { name: 'makefun-github-core-clone', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => Record<string, unknown>;
}

class ToolFailure extends Error {}

function needRepo(forge: Forge, args: Record<string, unknown>): RepoRec {
  const name = args.repo;
  const repo = typeof name === 'string' ? forge.repo(name) : undefined;
  if (repo === undefined) throw new ToolFailure(`repository not found: ${String(args.owner ?? '')}/${String(name ?? '')}`);
  return repo;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (forge, args) => {
      const name = stringArg(args, 'name');
      if (forge.repo(name) !== undefined) throw new ToolFailure(`repository ${name} already exists`);
      const repo = forge.createRepo(name, args.private === true, stringArg(args, 'description'));
      return repoView(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => repoView(needRepo(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const issue = forge.createIssue(repo, stringArg(args, 'title'), stringArg(args, 'body'), []);
      return issueView(repo, issue);
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      issue_number: { type: 'number', description: 'The issue number.' },
    },
    required: ['owner', 'repo', 'issue_number'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = repo.issues.get(number);
      if (issue === undefined) throw new ToolFailure(`issue #${String(number)} not found`);
      return issueView(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const state = stringArg(args, 'state');
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return { issues: issues.map((issue) => issueView(repo, issue)) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const head = stringArg(args, 'head');
      const base = stringArg(args, 'base');
      if (forge.branchTip(repo, head) === undefined || forge.branchTip(repo, base) === undefined) {
        throw new ToolFailure('head or base branch does not exist');
      }
      const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (duplicate) throw new ToolFailure('a pull request already exists for this head and base');
      const pull = forge.createPull(repo, stringArg(args, 'title'), stringArg(args, 'body'), head, base);
      return pullView(forge, repo, pull);
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const state = stringArg(args, 'state');
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      return { pull_requests: pulls.map((pull) => pullView(forge, repo, pull)) };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = needRepo(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolFailure(`pull request #${String(number)} not found`);
      if (pull.state !== 'open') throw new ToolFailure(`pull request #${pull.number} is not open`);
      const sha = forge.mergePull(repo, pull, 'squash');
      if (sha === null) throw new ToolFailure(`pull request #${pull.number} is not mergeable`);
      return pullView(forge, repo, pull);
    },
  },
];

/** The tools/list answer: built once from the constant table, so two calls are byte-identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

function rpcResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(ctx: Ctx, status: number, id: unknown, code: number, message: string): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function callTool(ctx: Ctx, id: unknown, params: Record<string, unknown>): void {
  const name = params.name;
  const tool = typeof name === 'string' ? TOOLS.find((candidate) => candidate.name === name) : undefined;
  if (tool === undefined) {
    rpcError(ctx, 200, id, -32602, `unknown tool: ${String(name)}`);
    return;
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    rpcError(ctx, 200, id, -32602, `missing required argument(s): ${missing.join(', ')}`);
    return;
  }
  try {
    const structured = tool.run(ctx.forge, args);
    rpcResult(ctx, id, {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: false,
    });
  } catch (err) {
    if (err instanceof ToolFailure) {
      rpcResult(ctx, id, { content: [{ type: 'text', text: err.message }], isError: true });
      return;
    }
    throw err;
  }
}

/** Handle one POST /mcp. */
export function handleMcp(ctx: Ctx): void {
  if (!ctx.authed) {
    rpcError(ctx, 401, null, -32001, 'unauthorized');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8')) as unknown;
  } catch {
    rpcError(ctx, 400, null, -32700, 'Parse error');
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    rpcError(ctx, 400, null, -32600, 'Invalid Request');
    return;
  }
  const id = parsed.id;
  const params = isRecord(parsed.params) ? parsed.params : {};
  // A notification carries no id: accept it and answer with an empty success.
  if (id === undefined) {
    sendEmpty(ctx, 202);
    return;
  }
  switch (parsed.method) {
    case 'server/discover':
      rpcResult(ctx, id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
      return;
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = (SUPPORTED_VERSIONS as readonly string[]).includes(offered) ? offered : '2025-11-25';
      rpcResult(ctx, id, { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } });
      return;
    }
    case 'ping':
      rpcResult(ctx, id, {});
      return;
    case 'tools/list':
      rpcResult(ctx, id, TOOLS_LIST_RESULT);
      return;
    case 'tools/call':
      callTool(ctx, id, params);
      return;
    default:
      rpcError(ctx, 200, id, -32601, `method not found: ${parsed.method}`);
      return;
  }
}

export { VIEWER };
