import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CadenceApp, CadenceServer, cookies, sessions, FileSessionStore, multipart } from '../src/index.js';

async function tempDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-prod-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function start(app, t, options = {}) {
  const server = new CadenceServer(app, options);
  const address = await server.listen();
  t.after(() => server.close());
  return { server, address };
}

test('FileSessionStore survives a server/store restart and detects tampering', async (t) => {
  const root = await tempDir(t);
  const sessionDir = path.join(root, 'sessions');

  const app1 = new CadenceApp();
  app1.use(cookies()).use(sessions({ store: new FileSessionStore({ directory: sessionDir }), ttlMs: 60_000 }));
  app1.post('/counter', async (ctx) => {
    ctx.session.count = (ctx.session.count ?? 0) + 1;
    return { count: ctx.session.count, sessionId: ctx.sessionId };
  });
  const firstServer = new CadenceServer(app1);
  const firstAddress = await firstServer.listen();
  const first = await fetch(`${firstAddress.url}/counter`, { method: 'POST' });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.count, 1);
  const cookie = first.headers.get('set-cookie').split(';')[0];
  await firstServer.close();

  const app2 = new CadenceApp();
  app2.use(cookies()).use(sessions({ store: new FileSessionStore({ directory: sessionDir }), ttlMs: 60_000 }));
  app2.post('/counter', async (ctx) => {
    ctx.session.count = (ctx.session.count ?? 0) + 1;
    return { count: ctx.session.count, sessionId: ctx.sessionId };
  });
  const { address } = await start(app2, t);
  const second = await fetch(`${address.url}/counter`, { method: 'POST', headers: { cookie } });
  assert.equal(second.status, 200);
  const secondBody = await second.json();
  assert.equal(secondBody.count, 2);
  assert.equal(secondBody.sessionId, firstBody.sessionId);

  const files = (await fs.readdir(sessionDir)).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const sessionFile = path.join(sessionDir, files[0]);
  const envelope = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
  envelope.value.count = 999;
  await fs.writeFile(sessionFile, JSON.stringify(envelope));
  const store = new FileSessionStore({ directory: sessionDir });
  await assert.rejects(() => store.get(firstBody.sessionId), /integrity check failed/);
});

test('session regeneration rotates identifiers and destruction expires the cookie', async (t) => {
  const root = await tempDir(t);
  const app = new CadenceApp();
  app.use(cookies()).use(sessions({ store: new FileSessionStore({ directory: path.join(root, 'sessions') }), ttlMs: 60_000 }));
  app.post('/login', async (ctx) => {
    const before = ctx.sessionId;
    await ctx.regenerateSession();
    ctx.session.user = '42';
    return { before, after: ctx.sessionId };
  });
  app.post('/logout', async (ctx) => { await ctx.destroySession(); return { ok: true }; });
  const { address } = await start(app, t);
  const login = await fetch(`${address.url}/login`, { method: 'POST' });
  const body = await login.json();
  assert.notEqual(body.before, body.after);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const logout = await fetch(`${address.url}/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('Cadence parses real multipart/form-data and durably stores bounded uploads', async (t) => {
  const root = await tempDir(t);
  const uploadDir = path.join(root, 'uploads');
  const app = new CadenceApp();
  app.use(multipart({ uploadDir, maxFiles: 2, maxFileSize: 1024, maxFields: 4 }));
  app.post('/upload', async (ctx) => {
    const file = ctx.files[0];
    return {
      title: ctx.fields.title,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      content: await fs.readFile(file.path, 'utf8')
    };
  });
  const { address } = await start(app, t, { maxBodyBytes: 32 * 1024 });
  const form = new FormData();
  form.set('title', 'evidence');
  form.set('file', new Blob(['production upload'], { type: 'text/plain' }), 'proof.txt');
  const response = await fetch(`${address.url}/upload`, { method: 'POST', body: form });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    title: 'evidence', filename: 'proof.txt', contentType: 'text/plain', size: 17, content: 'production upload'
  });
  const stored = await fs.readdir(uploadDir);
  assert.equal(stored.length, 1);
  assert.match(stored[0], /-proof\.txt$/);
});

test('multipart limits reject oversized files through a real HTTP request', async (t) => {
  const app = new CadenceApp();
  app.use(multipart({ maxFiles: 1, maxFileSize: 4 }));
  app.post('/upload', async () => ({ ok: true }));
  const { address } = await start(app, t, { maxBodyBytes: 4096 });
  const form = new FormData();
  form.set('file', new Blob(['too-large']), 'large.txt');
  const response = await fetch(`${address.url}/upload`, { method: 'POST', body: form });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'upload_limits_exceeded', limit: 'maxFileSize' });
});
