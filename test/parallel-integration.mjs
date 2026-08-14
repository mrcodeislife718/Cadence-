import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { CadenceApp, createParallelServer } from '../src/index.js';

const parallelPath = process.env.PARALLEL_REPO;
if (!parallelPath) throw new Error('PARALLEL_REPO is required');
const parallel = await import(pathToFileURL(path.join(parallelPath, 'src', 'index.js')));
const app = new CadenceApp();
app.get('/parallel', async () => ({ runtime:'parallel', ok:true }));
const server = createParallelServer(app, parallel);
await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
try {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/parallel`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(), { runtime:'parallel', ok:true });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
