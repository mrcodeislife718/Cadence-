import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export function cookies() {
  return async (ctx, next) => {
    ctx.cookies = parseCookies(ctx.request.headers?.cookie ?? '');
    ctx.setCookie = (name, value, options = {}) => {
      const serialized = serializeCookie(name, value, options);
      const existing = ctx.headers['set-cookie'];
      ctx.headers['set-cookie'] = existing ? [].concat(existing, serialized) : serialized;
    };
    await next();
  };
}

export function sessions({ store = new MemorySessionStore(), cookieName = 'cadence.sid', ttlMs = 86400000 } = {}) {
  return async (ctx, next) => {
    const sid = ctx.cookies?.[cookieName];
    let session = sid ? await store.get(sid) : null;
    let sessionId = sid;
    if (!session) {
      sessionId = crypto.randomUUID();
      session = {};
    }
    ctx.session = session;
    await next();
    await store.set(sessionId, session, ttlMs);
    ctx.setCookie?.(cookieName, sessionId, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: Math.floor(ttlMs / 1000) });
  };
}

export class MemorySessionStore {
  constructor() { this.sessions = new Map(); }
  async get(id) { const entry = this.sessions.get(id); if (!entry) return null; if (entry.expiresAt <= Date.now()) { this.sessions.delete(id); return null; } return structuredClone(entry.value); }
  async set(id, value, ttlMs) { this.sessions.set(id, { value: structuredClone(value), expiresAt: Date.now() + ttlMs }); }
  async delete(id) { return this.sessions.delete(id); }
}

export function auth({ resolveUser, required = false } = {}) {
  if (typeof resolveUser !== 'function') throw new TypeError('auth(resolveUser) requires a resolver');
  return async (ctx, next) => {
    ctx.user = await resolveUser(ctx);
    if (required && !ctx.user) { ctx.status = 401; ctx.body = { error: 'unauthorized' }; return; }
    await next();
  };
}

export function bodyParser({ limit = 1024 * 1024 } = {}) {
  return async (ctx, next) => {
    const body = ctx.request.body;
    if (Buffer.isBuffer(body) && body.length > limit) { ctx.status = 413; ctx.body = { error: 'payload_too_large' }; return; }
    if (typeof body === 'string' && Buffer.byteLength(body) > limit) { ctx.status = 413; ctx.body = { error: 'payload_too_large' }; return; }
    const contentType = String(ctx.request.headers?.['content-type'] ?? '').split(';')[0];
    if (typeof body === 'string' && contentType === 'application/json') {
      try { ctx.request.body = JSON.parse(body); }
      catch { ctx.status = 400; ctx.body = { error: 'invalid_json' }; return; }
    }
    await next();
  };
}

export function multipart({ maxFiles = 10, maxFileSize = 10 * 1024 * 1024 } = {}) {
  return async (ctx, next) => {
    const files = Array.isArray(ctx.request.files) ? ctx.request.files : [];
    if (files.length > maxFiles || files.some((file) => (file.size ?? file.data?.length ?? 0) > maxFileSize)) {
      ctx.status = 413; ctx.body = { error: 'upload_limits_exceeded' }; return;
    }
    ctx.files = files;
    await next();
  };
}

export class CadenceSocket extends EventEmitter {
  constructor(send, close) { super(); this._send = send; this._close = close; this.closed = false; }
  send(data) { if (this.closed) throw new Error('socket is closed'); return this._send(data); }
  close(code = 1000, reason = '') { if (this.closed) return; this.closed = true; this._close?.(code, reason); this.emit('close', { code, reason }); }
}

export function stream(iterable, { contentType = 'application/octet-stream' } = {}) {
  if (!iterable?.[Symbol.asyncIterator] && !iterable?.[Symbol.iterator]) throw new TypeError('stream() requires an iterable');
  return { type: 'stream', contentType, iterable };
}

export function rpc(methods = {}) {
  return async (ctx) => {
    const { method, params = [] } = ctx.request.body ?? {};
    const fn = methods[method];
    if (typeof fn !== 'function') { ctx.status = 404; return { error: 'rpc_method_not_found', method }; }
    try { return { result: await fn(...params, ctx) }; }
    catch (error) { ctx.status = 500; return { error: 'rpc_failed', message: error.message }; }
  };
}

export function openApiFromRouter(router, info = { title: 'Cadence API', version: '0.1.0' }) {
  const paths = {};
  for (const route of router.routes) {
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      operationId: route.operationId ?? `${route.method.toLowerCase()}_${route.path.replace(/[^A-Za-z0-9]+/g, '_')}`,
      parameters: route.names.map((name) => ({ in: 'path', name, required: true, schema: { type: 'string' } })),
      responses: { '200': { description: 'Success' } }
    };
  }
  return { openapi: '3.1.0', info, paths };
}

export function createSyncioRepository(db, collectionName) {
  const collection = db.collection(collectionName);
  return {
    list: () => collection.all(),
    get: (id) => collection.get(id),
    create: (value) => collection.insert(value),
    save: (value) => collection.upsert(value),
    remove: (id) => collection.remove(id),
    watch: (listener) => collection.watch(listener)
  };
}

function parseCookies(header) {
  return Object.fromEntries(String(header).split(';').map((part) => part.trim()).filter(Boolean).map((part) => { const i = part.indexOf('='); return [decodeURIComponent(i < 0 ? part : part.slice(0, i)), decodeURIComponent(i < 0 ? '' : part.slice(i + 1))]; }));
}
function serializeCookie(name, value, options) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}
