import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CadenceSocket } from './modules.js';

export class CadenceServer {
  constructor(app, { host = '127.0.0.1', port = 0 } = {}) {
    this.app = app;
    this.host = host;
    this.port = port;
    this.webSockets = [];
    this.sockets = new Set();
    this.server = http.createServer((req,res)=>this.#handle(req,res));
    this.server.on('connection',(socket)=>{this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));});
    this.server.on('upgrade',(req,socket,head)=>this.#upgrade(req,socket,head));
  }
  websocket(path, handler) { const names=[]; const regex=new RegExp('^'+path.split('/').map((part)=>part.startsWith(':')?(names.push(part.slice(1)),'([^/]+)'):escapeRegex(part)).join('/')+'$'); this.webSockets.push({path,regex,names,handler}); return this; }
  async listen() { await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,this.host,resolve);}); const address=this.server.address(); return {host:this.host,port:address.port,url:`http://${this.host}:${address.port}`}; }
  async close() {
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    if(this.server.listening) await new Promise((resolve)=>this.server.close(resolve));
  }
  async #handle(req,res) {
    try {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const request={method:req.method,url:`http://${req.headers.host??'localhost'}${req.url}`,headers:req.headers,body:Buffer.concat(chunks)};
      const response=await this.app.handle(request);
      res.statusCode=response.status??200;
      for(const [name,value] of Object.entries(response.headers??{}))res.setHeader(name,value);
      const body=response.body;
      if(body?.type==='stream'&&body.iterable){if(body.contentType&&!res.hasHeader('content-type'))res.setHeader('content-type',body.contentType);for await(const chunk of body.iterable)res.write(chunk);res.end();return;}
      if(body==null){res.end();return;}
      if(Buffer.isBuffer(body)||typeof body==='string'){res.end(body);return;}
      if(!res.hasHeader('content-type'))res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
    }catch(error){res.statusCode=500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:'internal_error',message:error.message}));}
  }
  #upgrade(req,socket,head){
    const pathname=new URL(req.url,'http://cadence.local').pathname;
    const route=this.webSockets.map((r)=>({route:r,match:r.regex.exec(pathname)})).find((x)=>x.match);
    if(!route){socket.write('HTTP/1.1 404 Not Found\r\n\r\n');socket.destroy();return;}
    if(String(req.headers.upgrade??'').toLowerCase()!=='websocket'||!req.headers['sec-websocket-key']){socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');socket.destroy();return;}
    const accept=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection=new WebSocketConnection(socket);
    if(head?.length)connection.feed(head);
    const params=Object.fromEntries(route.route.names.map((name,i)=>[name,decodeURIComponent(route.match[i+1])]));
    Promise.resolve(route.route.handler(connection,{request:req,params})).catch((error)=>{connection.emit('error',error);connection.close(1011,'handler error');});
  }
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket){super();this.socket=socket;this.buffer=Buffer.alloc(0);this.closed=false;socket.on('data',(chunk)=>this.feed(chunk));socket.on('close',()=>{this.closed=true;this.emit('close');});socket.on('error',(error)=>this.emit('error',error));}
  feed(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);while(true){const frame=parseFrame(this.buffer);if(!frame)return;this.buffer=this.buffer.subarray(frame.bytes);if(frame.opcode===0x8){this.close(frame.code??1000,frame.reason??'');return;}if(frame.opcode===0x9){this.#sendFrame(0xA,frame.payload);continue;}if(frame.opcode===0x1)this.emit('message',frame.payload.toString('utf8'));else if(frame.opcode===0x2)this.emit('message',frame.payload);}}
  send(data){const opcode=Buffer.isBuffer(data)||data instanceof Uint8Array?0x2:0x1;this.#sendFrame(opcode,Buffer.from(data));}
  close(code=1000,reason=''){if(this.closed)return;const reasonBytes=Buffer.from(reason);const payload=Buffer.alloc(2+reasonBytes.length);payload.writeUInt16BE(code,0);reasonBytes.copy(payload,2);this.#sendFrame(0x8,payload);this.closed=true;this.socket.end();}
  #sendFrame(opcode,payload){if(this.closed)return;this.socket.write(encodeFrame(opcode,payload));}
}

export function createParallelServer(app, parallel) {
  if (!parallel?.createHttpServer) throw new TypeError('Parallel HTTP runtime is required');
  return parallel.createHttpServer((request)=>app.handle(request));
}

function parseFrame(buffer){if(buffer.length<2)return null;const b0=buffer[0],b1=buffer[1];const opcode=b0&0x0f,masked=Boolean(b1&0x80);let length=b1&0x7f,offset=2;if(length===126){if(buffer.length<4)return null;length=buffer.readUInt16BE(2);offset=4;}else if(length===127){if(buffer.length<10)return null;const big=buffer.readBigUInt64BE(2);if(big>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('WebSocket frame too large');length=Number(big);offset=10;}let mask;if(masked){if(buffer.length<offset+4)return null;mask=buffer.subarray(offset,offset+4);offset+=4;}if(buffer.length<offset+length)return null;const payload=Buffer.from(buffer.subarray(offset,offset+length));if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];const frame={opcode,payload,bytes:offset+length};if(opcode===0x8&&payload.length>=2){frame.code=payload.readUInt16BE(0);frame.reason=payload.subarray(2).toString('utf8');}return frame;}
function encodeFrame(opcode,payload){const length=payload.length;let header;if(length<126){header=Buffer.from([0x80|opcode,length]);}else if(length<=0xffff){header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=126;header.writeUInt16BE(length,2);}else{header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(length),2);}return Buffer.concat([header,payload]);}
function escapeRegex(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
