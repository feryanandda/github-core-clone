// The GraphQL v4 surface: a small parser and executor for the subset gh and the suite speak —
// operations with variables, aliases, input objects, enums, inline fragments, batched documents
// and the __type introspection probes — resolved against the same Forge store as REST and MCP.

import { VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { isRecord, jsonBody, sendJson, BAD_JSON, type Ctx } from './web.ts';

// -------------------------------------------------------------------------------------------------
// Global ids: opaque, stable, and decodable by node(id:) and the mutation inputs.
// -------------------------------------------------------------------------------------------------

function gid(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function parseGid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

function issueGid(repo: RepoRec, issue: IssueRec): string {
  return gid('Issue', repo.id, issue.number);
}

function pullGid(repo: RepoRec, pull: PullRec): string {
  return gid('PullRequest', repo.id, pull.number);
}

// -------------------------------------------------------------------------------------------------
// Lexer and parser for the GraphQL subset.
// -------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const value = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
          j += 2;
          if (esc === 'u') {
            value = value.slice(0, -1) + String.fromCharCode(Number.parseInt(input.slice(j, j + 4), 16));
            j += 4;
          }
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      const raw = input.slice(i, j);
      const value = Number(raw);
      tokens.push(raw.includes('.') || /[eE]/.test(raw) ? { kind: 'float', value } : { kind: 'int', value });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'scalar'; value: unknown }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}' in the GraphQL document`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in the GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation') {
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: keyword, name, selections: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition '${keyword}' in the GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    switch (token.kind) {
      case 'punct':
        if (token.value === '$') return { kind: 'var', name: this.expectName() };
        if (token.value === '[') {
          const items: ValueNode[] = [];
          while (!this.skipPunct(']')) items.push(this.parseValue());
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: ValueNode }> = [];
          while (!this.skipPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields.push({ name, value: this.parseValue() });
          }
          return { kind: 'object', fields };
        }
        break;
      case 'int':
      case 'float':
      case 'string':
        return { kind: 'scalar', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'scalar', value: true };
        if (token.value === 'false') return { kind: 'scalar', value: false };
        if (token.value === 'null') return { kind: 'scalar', value: null };
        return { kind: 'scalar', value: token.value };
      default:
        break;
    }
    throw new Error('unexpected value in the GraphQL document');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | undefined;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      let args = new Map<string, ValueNode>();
      if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
      this.skipDirectives();
      let sub: SelectionNode[] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '{') sub = this.parseSelectionSet();
      selections.push({ kind: 'field', field: { alias, name, args, selections: sub } });
    }
    return selections;
  }
}

// -------------------------------------------------------------------------------------------------
// The schema: type field lists (what __type reports) and the enum values.
// -------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests',
    'createdAt', 'updatedAt',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'repository', 'comments',
    'labels', 'createdAt', 'updatedAt', 'closedAt',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName',
    'baseRefName', 'mergeable', 'files', 'repository', 'author', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  LabelConnection: ['nodes', 'totalCount'],
  Label: ['name', 'color'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// -------------------------------------------------------------------------------------------------
// Execution.
// -------------------------------------------------------------------------------------------------

interface GObj {
  __type: string;
  value: unknown;
}

function tag(__type: string, value: unknown): GObj {
  return { __type, value };
}

interface PagePayload {
  nodes: GObj[];
  hasNext: boolean;
  endCursor: string | null;
  total: number;
}

class GqlError extends Error {}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'scalar':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function evalArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of field.args) out[name] = evalValue(node, variables);
  return out;
}

const FIXED_TIME = '2026-01-01T00:00:00Z';

function repoG(repo: RepoRec): GObj {
  return tag('Repository', repo);
}

function issueG(repo: RepoRec, issue: IssueRec): GObj {
  return tag('Issue', { repo, issue });
}

function pullG(repo: RepoRec, pull: PullRec): GObj {
  return tag('PullRequest', { repo, pull });
}

function cursorFor(kind: string, repo: RepoRec, number: number): string {
  return Buffer.from(`cursor:${repo.id}:${kind}:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(kind: string, repo: RepoRec, cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const parts = Buffer.from(cursor, 'base64').toString('utf8').split(':');
    if (parts[0] !== 'cursor' || Number(parts[1]) !== repo.id || parts[2] !== kind) return null;
    const number = Number(parts[3]);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

interface ConnectionSpec<T> {
  items: T[];
  kind: string;
  repo: RepoRec;
  numberOf: (item: T) => number;
  wrap: (item: T) => GObj;
  args: Record<string, unknown>;
}

/** Slice a connection page out of an ordered item list using the suite's cursor shape. */
function paginate<T>(spec: ConnectionSpec<T>): PagePayload {
  const first = typeof spec.args.first === 'number' ? Math.max(0, Math.trunc(spec.args.first)) : spec.items.length;
  let start = 0;
  const afterNumber = numberFromCursor(spec.kind, spec.repo, spec.args.after);
  if (afterNumber !== null) {
    const index = spec.items.findIndex((item) => spec.numberOf(item) === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const slice = spec.items.slice(start, start + first);
  const last = slice[slice.length - 1];
  return {
    nodes: slice.map(spec.wrap),
    hasNext: start + slice.length < spec.items.length,
    endCursor: last === undefined ? null : cursorFor(spec.kind, spec.repo, spec.numberOf(last)),
    total: spec.items.length,
  };
}

function pageG(__type: string, page: PagePayload): GObj {
  return tag(__type, page);
}

function findIssue(forge: Forge, parts: string[]): { repo: RepoRec; issue: IssueRec } | null {
  const repo = forge.repoById(Number(parts[1]));
  const issue = repo?.issues.get(Number(parts[2]));
  return repo !== undefined && issue !== undefined ? { repo, issue } : null;
}

function findPull(forge: Forge, parts: string[]): { repo: RepoRec; pull: PullRec } | null {
  const repo = forge.repoById(Number(parts[1]));
  const pull = repo?.pulls.get(Number(parts[2]));
  return repo !== undefined && pull !== undefined ? { repo, pull } : null;
}

/** Resolve one field on one tagged object. Throws GqlError for mutation failures. */
function resolveField(ctx: ExecCtx, obj: GObj, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const value = obj.value;
  switch (obj.__type) {
    case 'Query': {
      if (field === 'viewer') return tag('User', null);
      if (field === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof name !== 'string' || owner !== VIEWER.login) return null;
        const repo = forge.repo(name);
        return repo === undefined ? null : repoG(repo);
      }
      if (field === 'node') {
        const id = args.id;
        if (typeof id !== 'string') return null;
        const parts = parseGid(id);
        if (parts === null) return null;
        if (parts[0] === 'Repository') {
          const repo = forge.repoById(Number(parts[1]));
          return repo === undefined ? null : repoG(repo);
        }
        if (parts[0] === 'Issue') {
          const found = findIssue(forge, parts);
          return found === null ? null : issueG(found.repo, found.issue);
        }
        if (parts[0] === 'PullRequest') {
          const found = findPull(forge, parts);
          return found === null ? null : pullG(found.repo, found.pull);
        }
        if (parts[0] === 'User') return tag('User', null);
        return null;
      }
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (name in TYPE_FIELDS || name in ENUM_VALUES) return tag('__Type', name);
        return null;
      }
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const parts = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
        const repo = parts !== null && parts[0] === 'Repository' ? forge.repoById(Number(parts[1])) : undefined;
        if (repo === undefined) throw new GqlError('repository not found for createIssue');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = forge.createIssue(repo, title, body, []);
        return tag('CreateIssuePayload', issueG(repo, issue));
      }
      if (field === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const parts = typeof input.issueId === 'string' ? parseGid(input.issueId) : null;
        const found = parts !== null && parts[0] === 'Issue' ? findIssue(forge, parts) : null;
        if (found === null) throw new GqlError('issue not found for closeIssue');
        found.issue.state = 'closed';
        return tag('CloseIssuePayload', issueG(found.repo, found.issue));
      }
      if (field === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const parts = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
        const repo = parts !== null && parts[0] === 'Repository' ? forge.repoById(Number(parts[1])) : undefined;
        if (repo === undefined) throw new GqlError('repository not found for createPullRequest');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (forge.branchTip(repo, head) === undefined || forge.branchTip(repo, base) === undefined) {
          throw new GqlError('head or base branch does not exist');
        }
        const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (duplicate) throw new GqlError('a pull request already exists for this head and base');
        const title = typeof input.title === 'string' ? input.title : '';
        const body = typeof input.body === 'string' ? input.body : '';
        const pull = forge.createPull(repo, title, body, head, base);
        return tag('CreatePullRequestPayload', pullG(repo, pull));
      }
      if (field === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const parts = typeof input.pullRequestId === 'string' ? parseGid(input.pullRequestId) : null;
        const found = parts !== null && parts[0] === 'PullRequest' ? findPull(forge, parts) : null;
        if (found === null) throw new GqlError('pull request not found for mergePullRequest');
        if (found.pull.state !== 'open') throw new GqlError('pull request is not open');
        const method = input.mergeMethod === 'MERGE' ? 'merge' : 'squash';
        const sha = forge.mergePull(found.repo, found.pull, method);
        if (sha === null) throw new GqlError('pull request is not mergeable');
        return tag('MergePullRequestPayload', pullG(found.repo, found.pull));
      }
      if (field === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const parts = typeof input.subjectId === 'string' ? parseGid(input.subjectId) : null;
        const found = parts !== null && parts[0] === 'Issue' ? findIssue(forge, parts) : null;
        if (found === null) throw new GqlError('subject not found for addComment');
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = forge.addComment(found.repo, found.issue, body);
        const node = tag('IssueComment', { repo: found.repo, issue: found.issue, comment });
        return tag('AddCommentPayload', tag('IssueCommentEdge', node));
      }
      break;
    }
    case 'User': {
      if (field === 'login') return VIEWER.login;
      if (field === 'name') return VIEWER.name;
      if (field === 'id') return gid('User', VIEWER.id);
      if (field === 'databaseId') return VIEWER.id;
      break;
    }
    case 'Repository': {
      const repo = value as RepoRec;
      switch (field) {
        case 'id': return gid('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${VIEWER.login}/${repo.name}`;
        case 'owner': return tag('User', null);
        case 'defaultBranchRef': return tag('Ref', repo.defaultBranch);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'isPrivate': return repo.isPrivate;
        case 'description': return repo.description;
        case 'createdAt': case 'updatedAt': return FIXED_TIME;
        case 'issue': {
          const number = args.number;
          const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
          return issue === undefined ? null : issueG(repo, issue);
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            items = items.filter((issue) => wanted.has(issue.state));
          }
          let descending = false;
          if (isRecord(args.orderBy) && args.orderBy.direction === 'DESC') descending = true;
          items.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
          return pageG('IssueConnection', paginate({ items, kind: 'issue', repo, numberOf: (issue) => issue.number, wrap: (issue) => issueG(repo, issue), args }));
        }
        case 'pullRequest': {
          const number = args.number;
          const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
          return pull === undefined ? null : pullG(repo, pull);
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()];
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = new Set(states.map((state) => String(state)));
            items = items.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          items.sort((a, b) => b.number - a.number);
          return pageG('PullRequestConnection', paginate({ items, kind: 'pull', repo, numberOf: (pull) => pull.number, wrap: (pull) => pullG(repo, pull), args }));
        }
        default: break;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = value as { repo: RepoRec; issue: IssueRec };
      switch (field) {
        case 'id': return issueGid(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body': return issue.body;
        case 'author': return tag('User', null);
        case 'repository': return repoG(repo);
        case 'createdAt': case 'updatedAt': return FIXED_TIME;
        case 'closedAt': return issue.state === 'closed' ? FIXED_TIME : null;
        case 'comments': {
          const items = issue.comments;
          const page: PagePayload = {
            nodes: items.map((comment) => tag('IssueComment', { repo, issue, comment })),
            hasNext: false,
            endCursor: null,
            total: items.length,
          };
          return pageG('IssueCommentConnection', page);
        }
        case 'labels': {
          const nodes = issue.labels.map((name) => tag('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed' }));
          return tag('LabelConnection', { nodes, total: nodes.length });
        }
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = value as { repo: RepoRec; pull: PullRec };
      switch (field) {
        case 'id': return pullGid(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return pull.state === 'open' ? (forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
        case 'repository': return repoG(repo);
        case 'author': return tag('User', null);
        case 'createdAt': case 'updatedAt': return FIXED_TIME;
        case 'files': {
          const changes = forge.pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
          const slice = changes.slice(0, first);
          const page: PagePayload = {
            nodes: slice.map((change) => tag('PullRequestChangedFile', change)),
            hasNext: slice.length < changes.length,
            endCursor: null,
            total: changes.length,
          };
          return pageG('PullRequestChangedFileConnection', page);
        }
        default: break;
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return value as string;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'IssueCommentConnection': {
      const page = value as PagePayload;
      if (field === 'nodes') return page.nodes;
      if (field === 'totalCount') return page.total;
      if (field === 'pageInfo') {
        return tag('PageInfo', { hasNextPage: page.hasNext, hasPreviousPage: false, startCursor: page.endCursor, endCursor: page.endCursor });
      }
      break;
    }
    case 'LabelConnection': {
      const payload = value as { nodes: GObj[]; total: number };
      if (field === 'nodes') return payload.nodes;
      if (field === 'totalCount') return payload.total;
      break;
    }
    case 'Label': {
      const label = value as { name: string; color: string };
      if (field === 'name') return label.name;
      if (field === 'color') return label.color;
      break;
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field in info) return info[field as keyof typeof info];
      break;
    }
    case 'PullRequestChangedFile': {
      const change = value as { filename: string; additions: number; deletions: number; status: string };
      if (field === 'path') return change.filename;
      if (field === 'additions') return change.additions;
      if (field === 'deletions') return change.deletions;
      if (field === 'changeType') return change.status.toUpperCase();
      break;
    }
    case 'IssueComment': {
      const { repo, issue, comment } = value as { repo: RepoRec; issue: IssueRec; comment: { id: number; body: string } };
      if (field === 'id') return gid('IssueComment', repo.id, issue.number, comment.id);
      if (field === 'body') return comment.body;
      if (field === 'author') return tag('User', null);
      if (field === 'createdAt') return FIXED_TIME;
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return value as GObj;
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return value as GObj;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return value as GObj;
      break;
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return value as GObj;
      if (field === 'cursor') return '';
      break;
    }
    case '__Type': {
      const name = value as string;
      if (field === 'name') return name;
      if (field === 'kind') return name in ENUM_VALUES ? 'ENUM' : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name];
        return fields === undefined ? null : fields.map((fieldName) => tag('__Field', fieldName));
      }
      if (field === 'enumValues') {
        const values = ENUM_VALUES[name];
        return values === undefined ? null : values.map((enumName) => tag('__EnumValue', enumName));
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return value as string;
      if (field === 'description') return null;
      break;
    }
    default:
      break;
  }
  return undefined;
}

const ROOT_TYPES: Readonly<Record<string, string>> = { query: 'Query', mutation: 'Mutation' };

function executeSelectionSet(ctx: ExecCtx, obj: GObj, selections: readonly SelectionNode[], path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === obj.__type) Object.assign(out, executeSelectionSet(ctx, obj, selection.selections, path));
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === obj.__type) {
        Object.assign(out, executeSelectionSet(ctx, obj, fragment.selections, path));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = obj.__type;
      continue;
    }
    const knownFields = TYPE_FIELDS[obj.__type] ?? (obj.__type === 'Query' || obj.__type === 'Mutation' ? TYPE_FIELDS[obj.__type] : undefined);
    const isMeta = (obj.__type === 'Query' && (field.name === '__type' || field.name === '__schema'));
    if (!isMeta && knownFields !== undefined && !knownFields.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${obj.__type}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    let raw: unknown;
    try {
      raw = resolveField(ctx, obj, field.name, evalArgs(field, ctx.variables));
    } catch (err) {
      if (err instanceof GqlError) {
        ctx.errors.push({ message: err.message, path: [...path, key] });
        out[key] = null;
        continue;
      }
      throw err;
    }
    if (raw === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${obj.__type}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, raw, field.selections, [...path, key]);
  }
  return out;
}

function completeValue(ctx: ExecCtx, raw: unknown, selections: readonly SelectionNode[], path: Array<string | number>): unknown {
  if (raw === null) return null;
  if (Array.isArray(raw)) return raw.map((item, index) => completeValue(ctx, item, selections, [...path, index]));
  if (isRecord(raw) && typeof raw.__type === 'string' && 'value' in raw) {
    if (selections.length === 0) return null;
    return executeSelectionSet(ctx, raw as unknown as GObj, selections, path);
  }
  return raw;
}

interface GqlOutcome {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string; path: Array<string | number> }>;
}

function executeOperation(forge: Forge, document: DocumentNode, operationName: string | undefined, variables: Record<string, unknown>): GqlOutcome {
  const operation =
    document.operations.find((candidate) => operationName !== undefined && candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in the document', path: [] }] };
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const root = tag(ROOT_TYPES[operation.type]!, null);
  const data = executeSelectionSet(ctx, root, operation.selections, []);
  return { data, errors: ctx.errors };
}

/** Handle one POST /api/graphql: one operation object, or an array of them (batching). */
export function handleGraphQL(ctx: Ctx): void {
  if (!ctx.authed) {
    sendJson(ctx, 401, { message: 'Bad credentials' });
    return;
  }
  const body = jsonBody(ctx);
  if (body === BAD_JSON) {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (!isRecord(entry) || typeof entry.query !== 'string') {
      return { errors: [{ message: 'a GraphQL operation needs a query string' }] };
    }
    try {
      const document = new Parser(lex(entry.query)).parseDocument();
      const variables = isRecord(entry.variables) ? entry.variables : {};
      const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
      const outcome = executeOperation(ctx.forge, document, operationName, variables);
      const envelope: Record<string, unknown> = { data: outcome.data };
      if (outcome.errors.length > 0) envelope.errors = outcome.errors;
      return envelope;
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map(runOne));
    return;
  }
  sendJson(ctx, 200, runOne(body));
}
