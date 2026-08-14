import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { CadenceApp, json, cookies, sessions, auth, bodyParser, multipart, stream, rpc, openApiFromRouter, CadenceServer } from '../src/index.js';

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

test('Cadence serves real HTTP requests', async (t) => {
  const app = new CadenceApp();
  app.get('/health', async () => ({ ok:true }));
  const service = new CadenceServer(app);
  t.after(() => service.close());
  const address = await service.listen();
  const response = await fetch(`${address.url}/health`);
  assert.deepEqual(await response.json(), { ok:true });
});

test('Cadence WebSocket upgrade and text frames work over a real TCP connection', async (t) => {
  const app = new CadenceApp();
  const service = new CadenceServer(app);
  t.after(() => service.close());
  service.websocket('/ws/:room', (socket, ctx) => {
    socket.on('message', (message) => socket.send(`${ctx.params.room}:${message}`));
  });
  const address = await service.listen();
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.createConnection({ host:address.host, port:address.port });
  t.after(() => socket.destroy());
  const received = createSocketReader(socket);
  await onceWithTimeout(socket, 'connect', 2000);
  socket.write(`GET /ws/dev HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const handshake = await received.readUntil((buffer) => {
    const index = buffer.indexOf('\r\n\r\n');
    return index >= 0 ? { value:buffer.subarray(0,index+4).toString('utf8'), consumed:index+4 } : null;
  }, 2000);
  assert.match(handshake, /101 Switching Protocols/);
  socket.write(clientTextFrame('hello'));
  const message = await received.readUntil(parseServerFrame, 2000);
  assert.equal(message, 'dev:hello');
});

test('Cadence failure paths short circuit auth, payload, upload, validation and RPC errors', async () => {
  const app = new CadenceApp();
  app.use(bodyParser({ limit:8 }));
  app.post('/protected', auth({ resolveUser:async()=>null, required:true }), async () => ({ unreachable:true }));
  app.post('/upload', multipart({ maxFiles:1, maxFileSize:4 }), async (ctx) => ({ count:ctx.files.length }));
  app.post('/rpc', rpc({ explode:() => { throw new Error('boom'); } }));
  app.post('/validated', json((value) => value?.ok ? {ok:true,value} : {ok:false,issues:['ok required']}), async (ctx)=>ctx.state.input);

  let response = await app.handle({method:'POST',url:'http://x/protected',headers:{},body:''});
  assert.equal(response.status,401); assert.deepEqual(response.body,{error:'unauthorized'});
  response = await app.handle({method:'POST',url:'http://x/validated',headers:{'content-type':'application/json'},body:'{"bad":true}'});
  assert.equal(response.status,413);
  response = await app.handle({method:'POST',url:'http://x/upload',headers:{},files:[{size:5}],body:''});
  assert.equal(response.status,413); assert.deepEqual(response.body,{error:'upload_limits_exceeded'});

  const rpcApp = new CadenceApp(); rpcApp.use(bodyParser()); rpcApp.post('/rpc', rpc({ explode:() => { throw new Error('boom'); } }));
  response = await rpcApp.handle({method:'POST',url:'http://x/rpc',headers:{'content-type':'application/json'},body:'{"method":"explode"}'});
  assert.equal(response.status,500); assert.deepEqual(response.body,{error:'rpc_failed',message:'boom'});
  response = await rpcApp.handle({method:'POST',url:'http://x/rpc',headers:{'content-type':'application/json'},body:'{"method":"missing"}'});
  assert.equal(response.status,404); assert.deepEqual(response.body,{error:'rpc_method_not_found',method:'missing'});
});

function clientTextFrame(text){const payload=Buffer.from(text);const mask=Buffer.from([1,2,3,4]);const header=Buffer.from([0x81,0x80|payload.length]);const masked=Buffer.from(payload);for(let i=0;i<masked.length;i++)masked[i]^=mask[i%4];return Buffer.concat([header,mask,masked]);}
function parseServerFrame(buffer){if(buffer.length<2)return null;let length=buffer[1]&0x7f;let offset=2;if(length===126){if(buffer.length<4)return null;length=buffer.readUInt16BE(2);offset=4;}if(length===127)return null;if(buffer.length<offset+length)return null;return{value:buffer.subarray(offset,offset+length).toString('utf8'),consumed:offset+length};}
function createSocketReader(socket){let buffer=Buffer.alloc(0);const waiters=[];socket.on('data',(chunk)=>{buffer=Buffer.concat([buffer,chunk]);drain();});socket.on('error',(error)=>{while(waiters.length)waiters.shift().reject(error);});function drain(){for(let i=0;i<waiters.length;){const waiter=waiters[i];const parsed=waiter.parser(buffer);if(!parsed){i++;continue;}buffer=buffer.subarray(parsed.consumed);waiters.splice(i,1);clearTimeout(waiter.timer);waiter.resolve(parsed.value);}}return{readUntil(parser,timeout){return new Promise((resolve,reject)=>{const waiter={parser,resolve,reject,timer:null};waiter.timer=setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error('timed out waiting for socket data'));},timeout);waiters.push(waiter);drain();});}};}
function onceWithTimeout(emitter,event,timeout){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(new Error(`timed out waiting for ${event}`));},timeout);const done=(value)=>{cleanup();resolve(value);};const failed=(error)=>{cleanup();reject(error);};const cleanup=()=>{clearTimeout(timer);emitter.off(event,done);emitter.off('error',failed);};emitter.once(event,done);emitter.once('error',failed);});}
