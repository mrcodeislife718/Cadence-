import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

export function sessions({ store = new MemorySessionStore(), cookieName = 'cadence.sid', ttlMs = 86400000, cookie = {} } = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError('session ttlMs must be a positive integer');
  return async (ctx, next) => {
    const sid = ctx.cookies?.[cookieName];
    let session = sid ? await store.get(sid) : null;
    let sessionId = sid;
    let destroyed = false;
    let rotated = false;
    if (!session) {
      sessionId = crypto.randomUUID();
      session = {};
    }
    ctx.session = session;
    ctx.sessionId = sessionId;
    ctx.regenerateSession = async () => {
      if (sessionId) await store.delete(sessionId);
      sessionId = crypto.randomUUID();
      ctx.sessionId = sessionId;
      rotated = true;
      return sessionId;
    };
    ctx.destroySession = async () => {
      destroyed = true;
      if (sessionId) await store.delete(sessionId);
      ctx.session = {};
    };
    await next();
    if (destroyed) {
      ctx.setCookie?.(cookieName, '', { ...cookie, httpOnly: true, sameSite: cookie.sameSite ?? 'Lax', path: cookie.path ?? '/', maxAge: 0 });
      return;
    }
    await store.set(sessionId, ctx.session, ttlMs);
    ctx.setCookie?.(cookieName, sessionId, {
      ...cookie,
      httpOnly: cookie.httpOnly !== false,
      sameSite: cookie.sameSite ?? 'Lax',
      path: cookie.path ?? '/',
      maxAge: Math.floor(ttlMs / 1000)
    });
    if (rotated) ctx.headers['cache-control'] ??= 'no-store';
  };
}

export class MemorySessionStore {
  constructor() { this.sessions = new Map(); }
  async get(id) { const entry = this.sessions.get(id); if (!entry) return null; if (entry.expiresAt <= Date.now()) { this.sessions.delete(id); return null; } return structuredClone(entry.value); }
  async set(id, value, ttlMs) { this.sessions.set(id, { value: structuredClone(value), expiresAt: Date.now() + ttlMs }); }
  async delete(id) { return this.sessions.delete(id); }
}

export class FileSessionStore {
  constructor({ directory = path.join(os.tmpdir(), 'cadence-sessions'), fsync = true } = {}) {
    this.directory = path.resolve(directory);
    this.fsync = Boolean(fsync);
    this.ready = null;
  }
  async #ensure() { this.ready ??= fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.ready; }
  #file(id) {
    if (typeof id !== 'string' || !id) throw new TypeError('session id must be a non-empty string');
    return path.join(this.directory, `${crypto.createHash('sha256').update(id).digest('hex')}.json`);
  }
  async get(id) {
    await this.#ensure();
    const file = this.#file(id);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const envelope = JSON.parse(raw);
      if (!Number.isFinite(envelope.expiresAt) || envelope.expiresAt <= Date.now()) { await fs.rm(file, { force: true }); return null; }
      const expected = digestSession(envelope.value, envelope.expiresAt);
      if (envelope.digest !== expected) throw new Error('session integrity check failed');
      return structuredClone(envelope.value);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  async set(id, value, ttlMs) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new TypeError('session ttlMs must be a positive integer');
    await this.#ensure();
    const file = this.#file(id);
    const expiresAt = Date.now() + ttlMs;
    const envelope = { version: 1, expiresAt, value: structuredClone(value) };
    envelope.digest = digestSession(envelope.value, expiresAt);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(envelope), 'utf8');
      if (this.fsync) await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temp, file);
    if (this.fsync) {
      const dir = await fs.open(this.directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return true;
  }
  async delete(id) { await this.#ensure(); await fs.rm(this.#file(id), { force: true }); return true; }
  async sweep(now = Date.now()) {
    await this.#ensure();
    let removed = 0;
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.directory, entry.name);
      try {
        const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!Number.isFinite(envelope.expiresAt) || envelope.expiresAt <= now) { await fs.rm(file, { force: true }); removed += 1; }
      } catch { /* Corrupt files remain observable to get(); sweep does not silently destroy evidence. */ }
    }
    return removed;
  }
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
    const contentType = String(ctx.request.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if ((typeof body === 'string' || Buffer.isBuffer(body)) && contentType === 'application/json') {
      try { ctx.request.body = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : body); }
      catch { ctx.status = 400; ctx.body = { error: 'invalid_json' }; return; }
    }
    if ((typeof body === 'string' || Buffer.isBuffer(body)) && contentType === 'application/x-www-form-urlencoded') {
      const params = new URLSearchParams(Buffer.isBuffer(body) ? body.toString('utf8') : body);
      ctx.request.body = Object.fromEntries(params.entries());
    }
    await next();
  };
}

export function multipart({
  maxFiles = 10,
  maxFileSize = 10 * 1024 * 1024,
  maxFields = 100,
  maxFieldBytes = 1024 * 1024,
  uploadDir = null
} = {}) {
  return async (ctx, next) => {
    const contentType = String(ctx.request.headers?.['content-type'] ?? '');
    if (!/^multipart\/form-data\b/i.test(contentType)) { await next(); return; }
    if (!Buffer.isBuffer(ctx.request.body)) { ctx.status = 400; ctx.body = { error: 'multipart_body_required' }; return; }
    const boundary = multipartBoundary(contentType);
    if (!boundary) { ctx.status = 400; ctx.body = { error: 'multipart_boundary_missing' }; return; }
    let parsed;
    try {
      parsed = await parseMultipart(ctx.request.body, boundary, { maxFiles, maxFileSize, maxFields, maxFieldBytes, uploadDir });
    } catch (error) {
      if (error instanceof MultipartLimitError) { ctx.status = 413; ctx.body = { error: 'upload_limits_exceeded', limit: error.limit }; return; }
      ctx.status = 400; ctx.body = { error: 'invalid_multipart', message: error.message }; return;
    }
    ctx.files = parsed.files;
    ctx.fields = parsed.fields;
    ctx.request.files = parsed.files;
    ctx.request.body = parsed.fields;
    await next();
  };
}

export class MultipartLimitError extends Error {
  constructor(limit) { super(`multipart limit exceeded: ${limit}`); this.name = 'MultipartLimitError'; this.limit = limit; }
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
    if (!Array.isArray(params)) { ctx.status = 400; return { error: 'rpc_invalid_params' }; }
    try { return { result: await fn(...params, ctx) }; }
    catch (error) { ctx.status = 500; return { error: 'rpc_failed', message: error.message }; }
  };
}

export function openApiFromRouter(router, info = { title: 'Cadence API', version: '0.1.0' }) {
  const paths = {};
  for (const route of router.routes) {
    const routePath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    paths[routePath] ??= {};
    paths[routePath][route.method.toLowerCase()] = {
      operationId: route.operationId ?? `${route.method.toLowerCase()}_${route.path.replace(/[^A-Za-z0-9]+/g, '_')}`,
      summary: route.summary ?? undefined,
      tags: route.tags ?? undefined,
      parameters: route.names.map((name) => ({ in: 'path', name, required: true, schema: { type: 'string' } })),
      requestBody: route.requestSchema ? { required: true, content: { 'application/json': { schema: route.requestSchema } } } : undefined,
      responses: route.responses ?? { '200': { description: 'Success' } }
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

async function parseMultipart(buffer, boundary, limits) {
  const delimiter = Buffer.from(`--${boundary}`);
  const files = [];
  const fields = {};
  let fieldsCount = 0;
  let cursor = buffer.indexOf(delimiter);
  if (cursor < 0) throw new Error('multipart boundary not found');
  cursor += delimiter.length;

  while (cursor < buffer.length) {
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) break;
    if (buffer.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) cursor += 2;
    const next = buffer.indexOf(delimiter, cursor);
    if (next < 0) throw new Error('unterminated multipart body');
    let part = buffer.subarray(cursor, next);
    if (part.length >= 2 && part.subarray(part.length - 2).equals(Buffer.from('\r\n'))) part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) throw new Error('multipart part missing header separator');
    const headerText = part.subarray(0, headerEnd).toString('utf8');
    const content = part.subarray(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = parseDisposition(headers['content-disposition']);
    if (!disposition.name) throw new Error('multipart part missing name');

    if (disposition.filename != null) {
      if (files.length >= limits.maxFiles) throw new MultipartLimitError('maxFiles');
      if (content.length > limits.maxFileSize) throw new MultipartLimitError('maxFileSize');
      const filename = path.basename(disposition.filename).replace(/[\u0000-\u001f\u007f]/g, '_');
      const file = { fieldName: disposition.name, filename, contentType: headers['content-type'] ?? 'application/octet-stream', size: content.length };
      if (limits.uploadDir) {
        const directory = path.resolve(limits.uploadDir);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const storedName = `${crypto.randomUUID()}-${filename || 'upload.bin'}`;
        const storedPath = path.join(directory, storedName);
        const handle = await fs.open(storedPath, 'wx', 0o600);
        try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
        file.path = storedPath;
      } else file.data = Buffer.from(content);
      files.push(file);
    } else {
      fieldsCount += 1;
      if (fieldsCount > limits.maxFields) throw new MultipartLimitError('maxFields');
      if (content.length > limits.maxFieldBytes) throw new MultipartLimitError('maxFieldBytes');
      const value = content.toString('utf8');
      if (Object.hasOwn(fields, disposition.name)) fields[disposition.name] = [].concat(fields[disposition.name], value);
      else fields[disposition.name] = value;
    }
    cursor = next + delimiter.length;
  }
  return { files, fields };
}

function multipartBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const value = match?.[1] ?? match?.[2] ?? null;
  if (!value || value.length > 200 || /[\r\n]/.test(value)) return null;
  return value;
}
function parsePartHeaders(text) {
  const headers = {};
  for (const line of text.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('invalid multipart header');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (Object.hasOwn(headers, name)) throw new Error(`duplicate multipart header: ${name}`);
    headers[name] = value;
  }
  return headers;
}
function parseDisposition(value = '') {
  if (!/^form-data\b/i.test(value)) return {};
  const result = {};
  for (const match of value.matchAll(/;\s*([A-Za-z0-9_-]+)=(?:"((?:\\.|[^"])*)"|([^;\s]+))/g)) {
    const raw = match[2] ?? match[3] ?? '';
    result[match[1].toLowerCase()] = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return result;
}
function digestSession(value, expiresAt) { return crypto.createHash('sha256').update(JSON.stringify({ expiresAt, value })).digest('hex'); }
function parseCookies(header) {
  return Object.fromEntries(String(header).split(';').map((part) => part.trim()).filter(Boolean).map((part) => { const i = part.indexOf('='); return [decodeURIComponent(i < 0 ? part : part.slice(0, i)), decodeURIComponent(i < 0 ? '' : part.slice(i + 1))]; }));
}
function serializeCookie(name, value, options) {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new TypeError('invalid cookie name');
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) {
    const normalized = String(options.sameSite).toLowerCase();
    if (!['strict','lax','none'].includes(normalized)) throw new TypeError('SameSite must be Strict, Lax, or None');
    if (normalized === 'none' && !options.secure) throw new TypeError('SameSite=None cookies must be Secure');
    parts.push(`SameSite=${normalized[0].toUpperCase()}${normalized.slice(1)}`);
  }
  return parts.join('; ');
}
