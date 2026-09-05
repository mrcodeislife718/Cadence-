import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export class CadenceServer {
  constructor(app, {
    host = '127.0.0.1',
    port = 0,
    maxBodyBytes = 1024 * 1024,
    exposeErrors = false,
    requestTimeoutMs = 30_000,
    headersTimeoutMs = 60_000,
    keepAliveTimeoutMs = 5_000,
    maxWebSocketFrameBytes = 1024 * 1024,
    maxWebSocketMessageBytes = 4 * 1024 * 1024
  } = {}) {
    this.app = app;
    this.host = host;
    this.port = port;
    this.maxBodyBytes = positiveInteger(maxBodyBytes, 'maxBodyBytes');
    this.exposeErrors = Boolean(exposeErrors);
    this.maxWebSocketFrameBytes = positiveInteger(maxWebSocketFrameBytes, 'maxWebSocketFrameBytes');
    this.maxWebSocketMessageBytes = positiveInteger(maxWebSocketMessageBytes, 'maxWebSocketMessageBytes');
    this.webSockets = [];
    this.sockets = new Set();
    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.server.requestTimeout = positiveInteger(requestTimeoutMs, 'requestTimeoutMs');
    this.server.headersTimeout = positiveInteger(headersTimeoutMs, 'headersTimeoutMs');
    this.server.keepAliveTimeout = positiveInteger(keepAliveTimeoutMs, 'keepAliveTimeoutMs');
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    this.server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
  }

  websocket(routePath, handler) {
    if (typeof handler !== 'function') throw new TypeError('WebSocket handler must be a function');
    const names = [];
    const regex = new RegExp('^' + routePath.split('/').map((part) => part.startsWith(':') ? (names.push(part.slice(1)), '([^/]+)') : escapeRegex(part)).join('/') + '$');
    this.webSockets.push({ path: routePath, regex, names, handler });
    return this;
  }

  async listen() {
    if (this.server.listening) return this.address();
    await new Promise((resolve, reject) => {
      const onError = (error) => { cleanup(); reject(error); };
      const onListening = () => { cleanup(); resolve(); };
      const cleanup = () => { this.server.off('error', onError); this.server.off('listening', onListening); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    return this.address();
  }

  address() {
    const address = this.server.address();
    return typeof address === 'object' && address ? { host: this.host, port: address.port, url: `http://${this.host}:${address.port}` } : null;
  }

  async close() {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    if (this.server.listening) await new Promise((resolve) => this.server.close(resolve));
  }

  async #handle(req, res) {
    try {
      const contentLength = parseContentLength(req.headers['content-length']);
      if (contentLength != null && contentLength > this.maxBodyBytes) return writeJson(res, 413, { error: 'payload_too_large' });
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          req.destroy();
          return writeJson(res, 413, { error: 'payload_too_large' });
        }
        chunks.push(chunk);
      }
      const request = { method: req.method, url: `http://${req.headers.host ?? 'localhost'}${req.url}`, headers: req.headers, body: Buffer.concat(chunks) };
      const response = await this.app.handle(request);
      res.statusCode = response.status ?? 200;
      for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value);
      const body = response.body;
      if (body?.type === 'stream' && body.iterable) {
        if (body.contentType && !res.hasHeader('content-type')) res.setHeader('content-type', body.contentType);
        for await (const chunk of body.iterable) {
          if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
        }
        res.end();
        return;
      }
      if (body == null) { res.end(); return; }
      if (Buffer.isBuffer(body) || typeof body === 'string') { res.end(body); return; }
      if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    } catch (error) {
      if (res.headersSent) { res.destroy(error); return; }
      writeJson(res, 500, this.exposeErrors ? { error: 'internal_error', message: error?.message ?? String(error) } : { error: 'internal_error' });
    }
  }

  #upgrade(req, socket, head) {
    try {
      const pathname = new URL(req.url, 'http://cadence.local').pathname;
      const matchInfo = this.webSockets.map((route) => ({ route, match: route.regex.exec(pathname) })).find((entry) => entry.match);
      if (!matchInfo) return rejectUpgrade(socket, 404, 'Not Found');
      const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
      const connection = String(req.headers.connection ?? '').toLowerCase().split(',').map((value) => value.trim());
      const key = req.headers['sec-websocket-key'];
      const version = String(req.headers['sec-websocket-version'] ?? '');
      if (upgrade !== 'websocket' || !connection.includes('upgrade') || version !== '13' || !validWebSocketKey(key)) return rejectUpgrade(socket, 400, 'Bad Request');
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const connectionObject = new WebSocketConnection(socket, { maxFrameBytes: this.maxWebSocketFrameBytes, maxMessageBytes: this.maxWebSocketMessageBytes });
      if (head?.length) connectionObject.feed(head);
      const params = Object.fromEntries(matchInfo.route.names.map((name, index) => [name, decodeURIComponent(matchInfo.match[index + 1])]));
      Promise.resolve(matchInfo.route.handler(connectionObject, { request: req, params })).catch((error) => {
        connectionObject.reportError(error);
        connectionObject.close(1011, 'handler error');
      });
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
    }
  }
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxFrameBytes = 1024 * 1024, maxMessageBytes = 4 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.maxFrameBytes = positiveInteger(maxFrameBytes, 'maxFrameBytes');
    this.maxMessageBytes = positiveInteger(maxMessageBytes, 'maxMessageBytes');
    this.fragment = null;
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('close', () => { this.closed = true; this.emit('close'); });
    socket.on('error', (error) => this.reportError(error));
  }

  reportError(error) {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  feed(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const frame = parseFrame(this.buffer, { maxFrameBytes: this.maxFrameBytes });
        if (!frame) return;
        this.buffer = this.buffer.subarray(frame.bytes);
        this.#handleFrame(frame);
        if (this.closed) return;
      }
    } catch (error) {
      this.reportError(error);
      this.close(error instanceof WebSocketLimitError ? 1009 : 1002, error instanceof WebSocketLimitError ? 'message too large' : 'protocol error');
    }
  }

  #handleFrame(frame) {
    if (frame.opcode === 0x8) {
      if (frame.payload.length === 1) throw new WebSocketProtocolError('invalid close payload');
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
      const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
      if (!validCloseCode(code)) throw new WebSocketProtocolError('invalid close code');
      this.#sendClose(code, reason);
      this.closed = true;
      this.socket.end();
      return;
    }
    if (frame.opcode === 0x9) { this.#sendFrame(0xA, frame.payload); return; }
    if (frame.opcode === 0xA) { this.emit('pong', frame.payload); return; }
    if (frame.opcode === 0x0) {
      if (!this.fragment) throw new WebSocketProtocolError('unexpected continuation frame');
      this.#appendFragment(frame.payload);
      if (frame.fin) this.#completeFragment();
      return;
    }
    if (frame.opcode !== 0x1 && frame.opcode !== 0x2) throw new WebSocketProtocolError('unsupported data opcode');
    if (this.fragment) throw new WebSocketProtocolError('new data frame before fragmented message completed');
    if (frame.fin) { this.#emitMessage(frame.opcode, frame.payload); return; }
    this.fragment = { opcode: frame.opcode, chunks: [], bytes: 0 };
    this.#appendFragment(frame.payload);
  }

  #appendFragment(payload) {
    this.fragment.bytes += payload.length;
    if (this.fragment.bytes > this.maxMessageBytes) throw new WebSocketLimitError('WebSocket message exceeds maximum size');
    this.fragment.chunks.push(payload);
  }

  #completeFragment() {
    const fragment = this.fragment;
    this.fragment = null;
    this.#emitMessage(fragment.opcode, Buffer.concat(fragment.chunks, fragment.bytes));
  }

  #emitMessage(opcode, payload) {
    if (payload.length > this.maxMessageBytes) throw new WebSocketLimitError('WebSocket message exceeds maximum size');
    this.emit('message', opcode === 0x1 ? payload.toString('utf8') : payload);
  }

  send(data) {
    if (this.closed) throw new Error('WebSocket is closed');
    const opcode = Buffer.isBuffer(data) || data instanceof Uint8Array ? 0x2 : 0x1;
    const payload = Buffer.from(data);
    if (payload.length > this.maxMessageBytes) throw new WebSocketLimitError('WebSocket message exceeds maximum size');
    this.#sendFrame(opcode, payload);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!validCloseCode(code)) throw new RangeError(`invalid WebSocket close code: ${code}`);
    const reasonBytes = Buffer.from(reason);
    if (reasonBytes.length > 123) throw new RangeError('WebSocket close reason exceeds 123 bytes');
    this.#sendClose(code, reason);
    this.closed = true;
    this.socket.end();
  }

  #sendClose(code, reason) {
    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.#sendFrame(0x8, payload);
  }

  #sendFrame(opcode, payload) {
    if (this.closed) return;
    this.socket.write(encodeFrame(opcode, payload));
  }
}

export class WebSocketProtocolError extends Error {}
export class WebSocketLimitError extends Error {}

export function createParallelServer(app, parallel) {
  if (!parallel?.createHttpServer) throw new TypeError('Parallel HTTP runtime is required');
  return parallel.createHttpServer((request) => app.handle(request));
}

function parseFrame(buffer, { maxFrameBytes }) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0], b1 = buffer[1];
  const fin = Boolean(b0 & 0x80);
  const rsv = b0 & 0x70;
  const opcode = b0 & 0x0f;
  const masked = Boolean(b1 & 0x80);
  if (rsv !== 0) throw new WebSocketProtocolError('RSV bits require negotiated extensions');
  if (!masked) throw new WebSocketProtocolError('client frames must be masked');
  const control = opcode >= 0x8;
  if (control && !fin) throw new WebSocketProtocolError('control frames cannot be fragmented');
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
    if (length < 126) throw new WebSocketProtocolError('non-minimal WebSocket length encoding');
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const big = buffer.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WebSocketLimitError('WebSocket frame too large');
    length = Number(big);
    offset = 10;
    if (length <= 0xffff) throw new WebSocketProtocolError('non-minimal WebSocket length encoding');
  }
  if (control && length > 125) throw new WebSocketProtocolError('control frame payload exceeds 125 bytes');
  if (length > maxFrameBytes) throw new WebSocketLimitError('WebSocket frame exceeds maximum size');
  if (buffer.length < offset + 4) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  return { fin, opcode, payload, bytes: offset + length };
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function writeJson(res, status, body) {
  if (res.destroyed) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseContentLength(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid content-length');
  return number;
}

function validWebSocketKey(value) {
  if (typeof value !== 'string') return false;
  try { return Buffer.from(value, 'base64').length === 16; } catch { return false; }
}

function validCloseCode(code) {
  return Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999));
}

function rejectUpgrade(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
