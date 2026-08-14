import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { CadenceApp, json, cookies, sessions, auth, bodyParser, stream, rpc, openApiFromRouter, CadenceServer } from '../src/index.js';

test('middleware, route params, validation, sessions, and auth compose', async () => {
  const app = new CadenceApp();
  app.use(cookies());
  app.use(sessions({ ttlMs: 10000 }));
  app.use(auth({ resolveUser: async () => ({ id:'u1' }), required:true }));
  app.get('/users/:id', async (ctx) => ({ id:ctx.params.id, user:ctx.user.id, visits:(ctx.session.visits=(ctx.session.visits??0)+1) }));
  const response = await app.handle({ method:'GET', url:'http://x/users/42', headers:{} });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id:'42', user:'u1', visits:1 });
  assert.match(response.headers['set-cookie'], /cadence\.sid=/);
});

test('body parsing, JSON validation, RPC, streaming, and OpenAPI contracts work', async () => {
  const app = new CadenceApp();
  app.use(bodyParser());
  app.post('/echo', json((value) => value?.name ? { ok:true, value } : { ok:false, issues:['name required'] }), async (ctx) => ctx.state.input);
  let response = await app.handle({ method:'POST', url:'http://x/echo', headers:{'content-type':'application/json'}, body:'{"name":"Cadence"}' });
  assert.equal(response.body.name, 'Cadence');
  response = await app.handle({ method:'POST', url:'http://x/echo', headers:{'content-type':'application/json'}, body:'{}' });
  assert.equal(response.status, 400);
  const rpcHandler = rpc({ add:(a,b)=>a+b });
  const ctx={request:{body:{method:'add',params:[2,3]}},status:200};
  assert.deepEqual(await rpcHandler(ctx), {result:5});
  assert.equal(stream(['a','b']).type, 'stream');
  const spec = openApiFromRouter(app.router);
  assert.ok(spec.paths['/echo'].post);
});

test('Cadence serves real HTTP requests', async () => {
  const app = new CadenceApp();
  app.get('/health', async () => ({ ok:true }));
  const service = new CadenceServer(app);
  const address = await service.listen();
  const response = await fetch(`${address.url}/health`);
  assert.deepEqual(await response.json(), { ok:true });
  await service.close();
});

test('Cadence WebSocket upgrade and text frames work over a real TCP connection', async () => {
  const app = new CadenceApp();
  const service = new CadenceServer(app);
  service.websocket('/ws/:room', (socket, ctx) => {
    socket.on('message', (message) => socket.send(`${ctx.params.room}:${message}`));
  });
  const address = await service.listen();
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.createConnection({ host:address.host, port:address.port });
  let buffer = Buffer.alloc(0);
  const frames = [];
  socket.on('data', (chunk) => { buffer=Buffer.concat([buffer,chunk]); const split=buffer.indexOf('\r\n\r\n'); if(split>=0&&!frames.handshake){frames.handshake=buffer.subarray(0,split+4).toString('utf8');buffer=buffer.subarray(split+4);} const frame=parseServerFrame(buffer); if(frame){frames.push(frame.text);buffer=buffer.subarray(frame.bytes);} });
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  socket.write(`GET /ws/dev HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await waitFor(()=>frames.handshake?.includes('101 Switching Protocols'));
  socket.write(clientTextFrame('hello'));
  await waitFor(()=>frames.includes('dev:hello'));
  assert.ok(frames.includes('dev:hello'));
  socket.destroy(); await service.close();
});

function clientTextFrame(text){const payload=Buffer.from(text);const mask=Buffer.from([1,2,3,4]);const header=Buffer.from([0x81,0x80|payload.length]);const masked=Buffer.from(payload);for(let i=0;i<masked.length;i++)masked[i]^=mask[i%4];return Buffer.concat([header,mask,masked]);}
function parseServerFrame(buffer){if(buffer.length<2)return null;const length=buffer[1]&0x7f;if(length>=126||buffer.length<2+length)return null;return{text:buffer.subarray(2,2+length).toString('utf8'),bytes:2+length};}
async function waitFor(predicate,timeout=2000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw new Error('timed out waiting for socket event');await new Promise(r=>setTimeout(r,10));}}
