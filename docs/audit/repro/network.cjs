'use strict';

// Offline audit harness: executes the repository's unmodified CommonJS source
// with stubbed external modules and sockets. No real credentials or network.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../..');
const constants = {
  Status: { IDLE: 0, READY: 1, RECONNECTING: 2, DISCONNECTED: 3, IDENTIFYING: 4, WAITING_FOR_GUILDS: 5 },
  Events: { DEBUG: 'debug', ERROR: 'error', SHARD_RECONNECTING: 'shardReconnecting', SHARD_ERROR: 'shardError' },
  ShardEvents: { READY: 'ready', RESUMED: 'resumed', CLOSE: 'close', ALL_READY: 'allReady', INVALID_SESSION: 'invalidSession', DESTROYED: 'destroyed' },
  Opcodes: { IDENTIFY: 2, RESUME: 6, INVALID_SESSION: 9, HEARTBEAT: 1 },
  WSEvents: { READY: 'READY', RESUMED: 'RESUMED', GUILD_CREATE: 'GUILD_CREATE' },
  WSCodes: { 1000: 'WS_CLOSE_REQUESTED', 1011: 'INTERNAL_ERROR', 4004: 'TOKEN_INVALID' },
  ciphers: [], UserAgent: 'offline-audit',
};
const socketAdapter = { WebSocket: {}, OPEN: 1, CLOSED: 3, pack: JSON.stringify };
function load(relative, stubs = {}, globals = {}) {
  const filename = path.join(root, relative);
  const mod = { exports: {} };
  const requireStub = name => {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    if (name.endsWith('/Constants')) return constants;
    if (name.endsWith('/Util')) return { checkUndiciProxyAgent: x => x.uri ? x : null, makeError: e => e };
    if (name === 'zlib-sync') throw new Error('optional module absent');
    if (name.startsWith('node:')) return require(name);
    throw new Error(`Missing stub for ${name} in ${relative}`);
  };
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
    { console, Buffer, AbortController, URLSearchParams, clearTimeout, ...globals }, { filename })(requireStub, mod, mod.exports);
  return mod.exports;
}

async function main() {
  const WebSocketShard = load('src/client/websocket/WebSocketShard.js', { '../../WebSocket': socketAdapter, '../../util/Intents': class {} });
  const debug = [];
  const manager = { client: { token: 'FAKE_TOKEN_ONLY', options: { ws: { properties: {} } } }, debug: msg => debug.push(msg), handlePacket() {} };
  const shard = new WebSocketShard(manager, 0);
  shard.connection = { readyState: 1, send() {} };
  shard.identifyNew();
  assert(debug.some(msg => msg.includes('FAKE_TOKEN_ONLY')));
  clearTimeout(shard.ratelimit.timer);
  console.log('CONFIRMED: gateway debug contains full token');

  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.closed = false; sockets.push(this); }
    close() { this.closed = true; }
    send() {}
  }
  const RemoteAuth = load('src/util/RemoteAuth.js', {
    ws: FakeSocket, undici: { fetch() { throw new Error('network prohibited'); } },
    './Options': { createDefault: () => ({ ws: { properties: {} } }) },
  });
  const auth = new RemoteAuth();
  let closedEvent = false;
  auth.on('closed', () => { closedEvent = true; });
  await auth.connect();
  auth.destroy();
  assert.equal(sockets[0].closed, false);
  assert.equal(closedEvent, false);
  console.log('CONFIRMED: RemoteAuth.destroy leaves private socket open and never emits closed');

  const auth2 = new RemoteAuth();
  let qrSettled = false;
  auth2.connect({ login() { return Promise.resolve(); } }).then(() => { qrSettled = true; }, () => { qrSettled = true; });
  sockets[1].emit('message', JSON.stringify({ op: 'cancel' }));
  await Promise.resolve();
  assert.equal(qrSettled, false);
  console.log('CONFIRMED: QR cancellation leaves login promise pending');

  const dispatchers = [];
  class Dispatcher { constructor(originOrConfig) { this.config = originOrConfig; } }
  const APIRequest = load('src/rest/APIRequest.js', { undici: { Client: Dispatcher, ProxyAgent: Dispatcher, buildConnector: x => x, FormData: class {} } });
  function fakeRest(uri) {
    return { client: { options: { http: { headers: {}, agent: { uri }, api: 'https://discord.com/api', version: 9 }, ws: { properties: {} }, restRequestTimeout: 1000 } },
      getAuth: () => 'FAKE_TOKEN_ONLY', fetch: async (url, opts) => { dispatchers.push(opts.dispatcher); return { ok: true }; } };
  }
  await new APIRequest(fakeRest('http://proxy-a.invalid'), 'get', '/one', {}).make();
  await new APIRequest(fakeRest('http://proxy-b.invalid'), 'get', '/two', {}).make();
  assert.equal(dispatchers[0], dispatchers[1]);
  assert.equal(dispatchers[1].config.uri, 'http://proxy-a.invalid');
  console.log('CONFIRMED: second client uses first client proxy');

  let bodySignal;
  const restSlow = fakeRest('http://unused.invalid');
  restSlow.client.options.restRequestTimeout = 5;
  restSlow.fetch = async (url, opts) => { bodySignal = opts.signal; return { json: async () => new Promise(resolve => setTimeout(() => resolve({}), 30)) }; };
  const slowResponse = await new APIRequest(restSlow, 'get', '/slow', {}).make();
  await slowResponse.json();
  assert.equal(bodySignal.aborted, false);
  console.log('CONFIRMED: restRequestTimeout is cleared before reading response body');

  const HTTPError = load('src/rest/HTTPError.js');
  const DiscordAPIError = load('src/rest/DiscordAPIError.js');
  const RequestHandler = load('src/rest/RequestHandler.js', {
    '@sapphire/async-queue': { AsyncQueue: class {} }, './HTTPError': HTTPError, './DiscordAPIError': DiscordAPIError, './RateLimitError': class extends Error {},
  });
  const restManager = { client: { token: 'FAKE_TOKEN_ONLY', options: { retryLimit: 1, captchaRetryLimit: 3, captchaSolver: async () => 'FAKE_CAPTCHA', restTimeOffset: 0 }, listenerCount: () => 0, emit() {} }, globalLimit: Infinity };
  const handler = new RequestHandler(restManager);
  let makeCount = 0;
  const request = { method: 'get', path: '/audit', route: '/audit', options: {}, retries: 0,
    make: async () => {
      makeCount++;
      if (makeCount <= 2) return { ok: false, status: 400, headers: { get: k => k === 'content-type' ? 'application/json' : null }, json: async () => ({ captcha_service: 'hcaptcha', captcha_key: ['captcha-required'] }) };
      if (makeCount <= 6) throw new Error('simulated network error');
      return { ok: true, headers: { get: k => k === 'content-type' ? 'application/json' : null }, json: async () => ({ success: true }) };
    },
  };
  await handler.execute(request);
  assert.equal(request.retries, 6);
  assert.equal(makeCount, 7);
  console.log('CONFIRMED: retryLimit=1 permits 4 network retries after 2 captcha retries (unbounded if failures persist)');

  let sends = 0;
  const readyShard = new WebSocketShard({ ...manager, debug() {} }, 0);
  readyShard.connection = { readyState: 1, send() { sends++; } };
  readyShard.status = constants.Status.READY;
  readyShard.sessionId = 'FAKE_SESSION';
  readyShard.onPacket({ op: constants.Opcodes.INVALID_SESSION, d: false });
  assert.equal(sends, 0);
  assert.equal(readyShard.status, constants.Status.RECONNECTING);
  assert.equal(readyShard.connection.readyState, 1);
  console.log('CONFIRMED: non-resumable invalid session leaves live ready connection idle, without new identify');

  // Drive manager lifecycle with a stub shard: no sockets are opened.
  class TestShard extends EventEmitter {
    constructor() { super(); this.id = 0; this.status = constants.Status.READY; }
    connect() { return Promise.resolve(); }
    destroy() {}
  }
  const WebSocketManager = load('src/client/websocket/WebSocketManager.js', {
    '@discordjs/collection': { Collection: Map }, 'discord-api-types/v10': { RPCErrorCodes: {} },
    './WebSocketShard': TestShard, './handlers': {}, '../../errors': { Error },
    '../../util/EventBatcher': { EventBatcher: class { destroy() {} } },
  });
  const lifecycleClient = new EventEmitter();
  lifecycleClient.options = { shards: [0] };
  const lifecycleManager = new WebSocketManager(lifecycleClient);
  const lifecycleShard = new TestShard();
  lifecycleManager.checkShardsReady = () => {};
  lifecycleManager.shardQueue.add(lifecycleShard);
  await lifecycleManager.createShards();
  lifecycleManager.status = constants.Status.READY;
  lifecycleShard.onPacket = WebSocketShard.prototype.onPacket;
  lifecycleShard.debug = () => {};
  lifecycleShard.manager = lifecycleManager;
  lifecycleShard.sessionId = 'FAKE_SESSION';
  lifecycleShard.sequence = -1;
  lifecycleShard.onPacket({ op: constants.Opcodes.INVALID_SESSION, d: false });
  assert.equal(lifecycleManager.shardQueue.size, 0);
  console.log('CONFIRMED: manager does not schedule reconnection on invalid session after READY');
  lifecycleManager.destroy();
  let managerRespawns = 0;
  lifecycleManager.createShards = async () => { managerRespawns++; return true; };
  lifecycleShard.emit(constants.ShardEvents.CLOSE, { code: 4009 });
  await Promise.resolve();
  assert.equal(lifecycleManager.destroyed, true);
  assert.equal(managerRespawns, 1);
  console.log('CONFIRMED: non-1000 close resurrects a destroyed WebSocketManager');

  const accepted = { id: 'group-new' };
  const fakeClient = { fetchInvite: async () => ({ channelId: accepted.id }), channels: { cache: new Map() }, guilds: { cache: new Map() }, sessionId: 'FAKE_SESSION', emit() {},
    api: { invites() { return { post: async () => { fakeClient.channels.cache.set(accepted.id, accepted); return { channel: accepted }; } }; } } };
  const clientSource = fs.readFileSync(path.join(root, 'src/client/Client.js'), 'utf8');
  const methodSource = clientSource.slice(clientSource.indexOf('  async acceptInvite('), clientSource.indexOf('  redeemNitro('));
  const acceptInvite = vm.runInNewContext(`({${methodSource}}).acceptInvite`, { DataResolver: { resolveInviteCode: x => x }, Error, Events: constants.Events });
  const acceptedResult = await acceptInvite.call(fakeClient, 'offline-invite');
  assert.equal(acceptedResult, true);
  console.log('CONFIRMED: newly accepted group DM invite resolves boolean instead of channel');

  const relationshipUpdate = load('src/client/websocket/handlers/RELATIONSHIP_UPDATE.js');
  const relationshipClient = { relationships: { cache: new Map(), sinceCache: new Map(), friendNicknames: new Map([['u1', 'Old nickname']]) }, emit() {} };
  relationshipUpdate(relationshipClient, { d: { id: 'u1', nickname: null } });
  assert.equal(relationshipClient.relationships.friendNicknames.get('u1'), 'Old nickname');
  console.log('CONFIRMED: null nickname update leaves stale cached nickname');

  const Shard = load('src/sharding/Shard.js', { '../errors': { Error } });
  const child = new EventEmitter();
  child.send = (msg, cb) => cb();
  const ipcShard = new Shard({ mode: 'process', totalShards: 1, respawn: false }, 0);
  ipcShard.process = child;
  let fetchSettled = false;
  ipcShard.fetchClientValue('user.id').then(() => { fetchSettled = true; }, () => { fetchSettled = true; });
  ipcShard._handleExit(false);
  await Promise.resolve();
  assert.equal(fetchSettled, false);
  assert.equal(child.listenerCount('message'), 1);
  console.log('CONFIRMED: child exit leaves fetch promise and message listener pending');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
