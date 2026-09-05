import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { CadenceApp, CadenceServer } from '../src/index.js';

test('Cadence rejects oversized HTTP bodies before application handling', async (t) => {
  const app = new CadenceApp();
  let handled = false;
  app.post('/upload', async () => { handled = true; return { ok: true }; });
  const server = new CadenceServer(app, { maxBodyBytes: 8 });
  t.after(() => server.close());
  const address = await server.listen();
  const response = await fetch(`${address.url}/upload`, { method: 'POST', body: '0123456789' });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'payload_too_large' });
  assert.equal(handled, false);
});

test('Cadence does not disclose internal exceptions by default', async (t) => {
  const app = new CadenceApp();
  app.get('/explode', async () => { throw new Error('database password leaked here'); });
  const server = new CadenceServer(app);
  t.after(() => server.close());
  const address = await server.listen();
  const response = await fetch(`${address.url}/explode`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal_error' });
});

test('Cadence accepts fragmented masked WebSocket messages and reassembles them', async (t) => {
  const app = new CadenceApp();
  const server = new CadenceServer(app);
  server.websocket('/ws', (socket) => socket.on('message', (message) => socket.send(`echo:${message}`)));
  t.after(() => server.close());
  const address = await server.listen();
  const socket = await openWebSocket(address);
  t.after(() => socket.destroy());
  const reader = createReader(socket);
  socket.write(maskedFrame({ opcode: 0x1, fin: false, payload: Buffer.from('hel') }));
  socket.write(maskedFrame({ opcode: 0x0, fin: true, payload: Buffer.from('lo') }));
  const message = await reader.read(parseServerDataFrame, 2000);
  assert.equal(message, 'echo:hello');
});

test('Cadence closes protocol on unmasked client WebSocket frames', async (t) => {
  const app = new CadenceApp();
  const server = new CadenceServer(app);
  server.websocket('/ws', () => {});
  t.after(() => server.close());
  const address = await server.listen();
  const socket = await openWebSocket(address);
  t.after(() => socket.destroy());
  const reader = createReader(socket);
  socket.write(Buffer.concat([Buffer.from([0x81, 3]), Buffer.from('bad')]));
  const closeCode = await reader.read(parseServerCloseFrame, 2000);
  assert.equal(closeCode, 1002);
});

async function openWebSocket(address) {
  const socket = net.createConnection({ host: address.host, port: address.port });
  await once(socket, 'connect', 2000);
  const reader = createReader(socket);
  const key = crypto.randomBytes(16).toString('base64');
  socket.write(`GET /ws HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const response = await reader.read((buffer) => {
    const end = buffer.indexOf('\r\n\r\n');
    return end >= 0 ? { value: buffer.subarray(0, end + 4).toString('utf8'), consumed: end + 4 } : null;
  }, 2000);
  assert.match(response, /101 Switching Protocols/);
  socket.__cadenceReader = reader;
  return socket;
}

function maskedFrame({ opcode, fin, payload }) {
  const mask = crypto.randomBytes(4);
  if (payload.length >= 126) throw new Error('test helper supports short frames only');
  const header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

function parseServerDataFrame(buffer) {
  const frame = parseServerFrame(buffer);
  if (!frame || frame.opcode !== 0x1) return null;
  return { value: frame.payload.toString('utf8'), consumed: frame.consumed };
}

function parseServerCloseFrame(buffer) {
  const frame = parseServerFrame(buffer);
  if (!frame || frame.opcode !== 0x8 || frame.payload.length < 2) return null;
  return { value: frame.payload.readUInt16BE(0), consumed: frame.consumed };
}

function parseServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) { if (buffer.length < 4) return null; length = buffer.readUInt16BE(2); offset = 4; }
  else if (length === 127) { if (buffer.length < 10) return null; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
  if (buffer.length < offset + length) return null;
  return { opcode, payload: buffer.subarray(offset, offset + length), consumed: offset + length };
}

function createReader(socket) {
  if (socket.__cadenceReader) return socket.__cadenceReader;
  let buffer = Buffer.alloc(0);
  const waiters = [];
  socket.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); drain(); });
  socket.on('error', (error) => { while (waiters.length) waiters.shift().reject(error); });
  function drain() {
    for (let index = 0; index < waiters.length;) {
      const waiter = waiters[index];
      const parsed = waiter.parser(buffer);
      if (!parsed) { index += 1; continue; }
      buffer = buffer.subarray(parsed.consumed);
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed.value);
    }
  }
  const reader = { read(parser, timeout) { return new Promise((resolve, reject) => { const waiter = { parser, resolve, reject, timer: null }; waiter.timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error('timed out waiting for socket data')); }, timeout); waiters.push(waiter); drain(); }); } };
  socket.__cadenceReader = reader;
  return reader;
}

function once(emitter, event, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${event}`)); }, timeout);
    const done = (...args) => { cleanup(); resolve(args); };
    const fail = (error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); emitter.off(event, done); emitter.off('error', fail); };
    emitter.once(event, done); emitter.once('error', fail);
  });
}
