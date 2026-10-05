'use strict';

// Offline probes: no Discord requests, real workers, or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const process = require('node:process');
const vm = require('node:vm');
const workspace = path.resolve(__dirname, '../../..');
const sourceRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.join(workspace, '.tmp/reference-youtsuho');

function load(relative, stubs = {}, globals = {}) {
  const filename = path.join(sourceRoot, relative);
  const localRequire = createRequire(filename);
  const moduleObject = { exports: {} };
  const requireStub = name => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name);
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
    { console, Buffer, clearTimeout, __dirname: path.dirname(filename), ...globals }, { filename })(requireStub, moduleObject, moduleObject.exports);
  return moduleObject.exports;
}

const fakeTimers = { setTimeout: () => ({ unref() { return this; } }) };
class FakeWorker extends EventEmitter {
  postMessage(task) { this.lastTask = task; }
  async terminate() { return 0; }
}

async function main() {
  const { WorkerPool } = load('src/util/WorkerManager.js', {
    'node:worker_threads': { Worker: FakeWorker },
    'node:timers': fakeTimers,
  });
  const pool = new WorkerPool({ size: 1, taskTimeout: 10 });
  let settled = false;
  const result = pool.execute('json_parse', '{"ok":true}').then(
    () => { settled = true; },
    error => { settled = true; return error.message; },
  );
  const worker = pool.workers[0].worker;
  worker.emit('message', { id: worker.lastTask.id, success: true, data: { ok: true } });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(pool.pendingTasks.size, 1);
  pool._handleTaskTimeout(worker.lastTask.id);
  assert.match(await result, /timeout/);
  await pool.destroy();
  console.log('CONFIRMED: fork worker result is ignored; successful task rejects on timeout');

  const { EventBatcher } = load('src/util/EventBatcher.js', { 'node:timers': fakeTimers });
  const client = new EventEmitter();
  client.options = {};
  const batcher = new EventBatcher(client);
  let handled = 0;
  let emitted = 0;
  client.on('MESSAGE_REACTION_ADD', () => { emitted++; });
  const handlers = { MESSAGE_REACTION_ADD: () => { handled++; } };
  const Manager = load('src/client/websocket/WebSocketManager.js', { './handlers': handlers });
  const manager = Object.create(Manager.prototype);
  manager.client = client;
  manager.status = require(path.join(sourceRoot, 'src/util/Constants')).Status.READY;
  manager.packetQueue = [];
  manager.eventBatcher = batcher;
  manager.handlePacket({ t: 'MESSAGE_REACTION_ADD', d: { user_id: 'offline-user' } }, { id: 0 });
  batcher.flush();
  assert.equal(emitted, 1);
  assert.equal(handled, 0);
  batcher.destroy();
  console.log('CONFIRMED: fork default event batching drops reaction packet handler and cache update');

  const messages = [];
  const parentPort = { on(event, listener) { this.listener = listener; }, postMessage(message) { messages.push(message); } };
  const { OperationTypes } = require(path.join(sourceRoot, 'src/util/WorkerManager'));
  load('src/util/default-worker.js', { 'node:worker_threads': { parentPort }, './WorkerManager': { OperationTypes } });
  await parentPort.listener({ id: 1, type: OperationTypes.ENCRYPTION, data: 'offline', options: {} });
  assert.equal(messages[0].success, false);
  assert.match(messages[0].error, /createCipher/);
  console.log('CONFIRMED: fork encryption worker calls removed crypto.createCipher on Node 24');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
