// The small HTTP plumbing every surface shares: one request context, JSON answers with the
// headers the protocol checks look for, and body parsing that never throws into the server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The request path, percent-decoded per segment and rejoined (git paths keep their shape). */
  path: string;
  body: Buffer;
  /** Whether the request carries the trial's bearer token (or no token is configured). */
  authed: boolean;
}

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body; the request-id header was already set by the router. */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  ctx.res.end(text);
}

/** Answer with raw bytes under an explicit content type. */
export function sendBody(ctx: Ctx, status: number, contentType: string, body: Buffer, headers: Readonly<Record<string, string>> = {}): void {
  ctx.res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  ctx.res.end(body);
}

/** Answer with no body at all (204s and MCP notifications). */
export function sendEmpty(ctx: Ctx, status: number): void {
  ctx.res.writeHead(status, { 'content-length': 0 });
  ctx.res.end();
}

/** GitHub's error shape: a JSON object with a non-empty string message. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/**
 * The request's JSON body: the parsed value, `{}` for an empty body, or the symbol BAD_JSON
 * when a non-empty body does not parse (the protocol check expects a 400 for that).
 */
export const BAD_JSON: unique symbol = Symbol('bad-json');

export function jsonBody(ctx: Ctx): unknown {
  const text = ctx.body.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return BAD_JSON;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A string field of a JSON body, or undefined when absent or not a string. */
export function strField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Decode one URL path segment without ever throwing on a stray '%'. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
