// The server: one HTTP router over the four surfaces — git smart HTTP, REST v3, GraphQL v4 and
// MCP — all sharing one Forge store. main.ts owns the lifecycle (bind, register, wait for done);
// this file is the whole forge.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGit } from './httpgit.ts';
import { handleGraphQL } from './gql.ts';
import { handleMcp } from './mcp.ts';
import { decodeSegment, sendJson, type Ctx } from './web.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `makefun-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Read a request body whole; oversized bodies are drained and answered as empty. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        oversized = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(oversized ? Buffer.alloc(0) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      res.setHeader('x-github-request-id', nextRequestId());
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
        const body = await readBody(req);
        const authorization = req.headers.authorization ?? '';
        const ctx: Ctx = {
          forge,
          req,
          res,
          url,
          path: segments.join('/'),
          body,
          authed: token === '' || authorization === `Bearer ${token}`,
        };
        const method = req.method ?? 'GET';

        if (method === 'GET' && url.pathname === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'v3') {
          handleRest(ctx, segments.slice(2));
          return;
        }
        if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
          if (method === 'POST') handleGraphQL(ctx);
          else sendJson(ctx, 404, { message: 'Not Found' });
          return;
        }
        if (segments[0] === 'mcp' && segments.length === 1) {
          if (method === 'POST') handleMcp(ctx);
          else if (method === 'DELETE') {
            res.writeHead(200, { 'content-length': 0 });
            res.end();
          } else sendJson(ctx, 404, { message: 'Not Found' });
          return;
        }
        if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
          handleGit(ctx, segments);
          return;
        }
        sendJson(ctx, 404, { message: 'Not Found' });
      } catch (err) {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        if (!res.headersSent) sendJson({ forge, req, res, url: new URL('http://entry/'), path: '', body: Buffer.alloc(0), authed: false }, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
