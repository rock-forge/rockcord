'use strict';

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { setTimeout, clearTimeout, clearInterval } = require('node:timers');
const vm = require('node:vm');
const { Response } = require('undici');
require('../src');
const ClientVoiceManager = require('../src/client/voice/ClientVoiceManager');
const WebSocketManager = require('../src/client/websocket/WebSocketManager');
const WebSocketShard = require('../src/client/websocket/WebSocketShard');
const APIRequest = require('../src/rest/APIRequest');
const RESTManager = require('../src/rest/RESTManager');
const RequestHandler = require('../src/rest/RequestHandler');
const { Status, Opcodes, ShardEvents } = require('../src/util/Constants');
const Options = require('../src/util/Options');
const redact = require('../src/util/Redact');

test('voice server diagnostics omit the token while forwarding it to the connection', () => {
  const client = new EventEmitter();
  const voice = new ClientVoiceManager(client);
  const logs = [];
  client.on('debug', message => logs.push(message));
  let forwarded;
  voice.connection = {
    setTokenAndEndpoint: token => {
      forwarded = token;
    },
  };
  voice.onVoiceServer({ guild_id: '123', token: 'FAKE_VOICE_SECRET', endpoint: 'voice.example' });
  assert.equal(forwarded, 'FAKE_VOICE_SECRET');
  assert.ok(logs.every(message => !message.includes('FAKE_VOICE_SECRET')));
});

function manager() {
  const client = new EventEmitter();
  client.options = Options.createDefault();
  client.token = 'FAKE_ACCOUNT_TOKEN';
  return new RESTManager(client);
}

test('dispatchers belong to one client and match the configured API origin', () => {
  const a = manager();
  const b = manager();
  const first = a.getDispatcher('http://127.0.0.1:3000/api/v9');
  assert.equal(a.getDispatcher('http://127.0.0.1:3000/other'), first);
  assert.notEqual(b.getDispatcher('http://127.0.0.1:3000/api'), first);
  assert.notEqual(a.getDispatcher('http://127.0.0.1:3001/api'), first);
  a.destroy();
  b.destroy();
  assert.equal(a.dispatchers.size, 0);
  assert.throws(() => a.getDispatcher('https://discord.com'), /destroyed/);
});

test('REST deadline covers a stalled response body and releases the route queue', async () => {
  const server = createServer((_, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const rest = manager();
  rest.client.options.http.api = `http://127.0.0.1:${server.address().port}`;
  rest.client.options.restRequestTimeout = 100;
  rest.client.options.retryLimit = 0;
  try {
    await assert.rejects(rest.request('get', '/slow', { route: '/slow' }), /abort/i);
    assert.equal(rest.controllers.size, 0);
    assert.equal(rest.handlers.get('/slow').queue.remaining, 0);
  } finally {
    rest.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('transport failures remain bounded after CAPTCHA; solved context survives retry and diagnostics redact secrets', async () => {
  const rest = manager();
  rest.client.options.retryLimit = 1;
  rest.client.options.captchaRetryLimit = 3;
  rest.client.options.captchaSolver = async () => ({ token: 'FAKE_CAPTCHA_TOKEN' });
  const diagnostics = [];
  rest.client.on('debug', data => diagnostics.push(data));
  rest.client.on('apiRequest', data => diagnostics.push(data));
  const argumentsSeen = [];
  let calls = 0;
  const request = {
    method: 'post',
    path: '/test',
    route: '/test',
    retries: 0,
    options: { mfaToken: 'FAKE_MFA_TOKEN', data: { password: 'FAKE_PASSWORD' } },
    make: async (...args) => {
      argumentsSeen.push(args);
      if (++calls <= 2) {
        return Response.json(
          { captcha_service: 'hcaptcha', captcha_key: ['captcha-required'], captcha_rqtoken: 'FAKE_RQTOKEN' },
          { status: 400 },
        );
      }
      throw new Error('simulated network error');
    },
  };
  try {
    await assert.rejects(new RequestHandler(rest).execute(request), /simulated network/);
    assert.equal(calls, 4);
    assert.equal(request.captchaRetries, 2);
    assert.equal(request.transportRetries, 1);
    assert.deepEqual(argumentsSeen[3], ['FAKE_CAPTCHA_TOKEN', 'FAKE_RQTOKEN']);
    const debug = JSON.stringify(diagnostics);
    for (const secret of ['FAKE_CAPTCHA_TOKEN', 'FAKE_RQTOKEN', 'FAKE_MFA_TOKEN', 'FAKE_PASSWORD']) {
      assert.equal(debug.includes(secret), false, secret);
    }
    assert.equal(request.options.mfaToken, 'FAKE_MFA_TOKEN');
  } finally {
    rest.destroy();
  }
});

test('API request buffering preserves success, empty responses and auth:false', async () => {
  const rest = manager();
  rest.client.token = null;
  rest.fetch = async (_, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return Response.json({ success: true });
  };
  try {
    const response = await new APIRequest(rest, 'get', '/test', { auth: false }).make();
    assert.deepEqual(await response.json(), { success: true });
    rest.fetch = async () => new Response(null, { status: 204 });
    assert.equal((await new APIRequest(rest, 'get', '/empty', { auth: false }).make()).status, 204);
  } finally {
    rest.destroy();
  }
});

test('redaction copies data without changing the wire payload', () => {
  const original = { d: { token: 'fake', secret_key: [1, 2], user_id: 'u' } };
  assert.deepEqual(redact(original), { d: { token: '[REDACTED]', secret_key: '[REDACTED]', user_id: 'u' } });
  assert.equal(original.d.token, 'fake');
});

test('gateway diagnostics do not expose IDENTIFY/RESUME tokens', () => {
  const diagnostics = [];
  const sent = [];
  const shard = new WebSocketShard(
    {
      client: { token: 'FAKE_GATEWAY_TOKEN', options: { ws: { properties: {} } } },
      debug: data => diagnostics.push(data),
    },
    0,
  );
  shard.connection = { readyState: 1, send: data => sent.push(data) };
  shard.identifyNew();
  shard.sessionId = 'FAKE_SESSION';
  shard.identifyResume();
  clearTimeout(shard.ratelimit.timer);
  assert.equal(
    diagnostics.some(data => data.includes('FAKE_GATEWAY_TOKEN')),
    false,
  );
  assert.equal(sent.length, 2);
});

test('invalid sessions close for recovery; destroyed managers never reconnect', async () => {
  const client = new EventEmitter();
  client.options = { shards: [0], closeTimeout: 100 };
  const manager = new WebSocketManager(client);
  const shard = new WebSocketShard(manager, 0);
  let recovered = false;
  shard.status = Status.READY;
  shard.sessionId = 'old';
  shard.destroy = options => {
    recovered = options.reset && options.closeCode === 4000;
  };
  shard.onPacket({ op: Opcodes.INVALID_SESSION, d: false });
  assert.equal(recovered, true);
  assert.equal(shard.sessionId, null);
  manager.destroyed = true;
  assert.equal(await manager.reconnect(), false);
  assert.equal(await manager.createShards(), false);
  shard.emit(ShardEvents.CLOSE, { code: 4009 });
});

function loadAuth() {
  const sockets = [];
  class Socket extends EventEmitter {
    constructor() {
      super();
      this.closed = false;
      sockets.push(this);
    }
    close() {
      this.closed = true;
    }
    send() {}
  }
  const filename = path.resolve(__dirname, '../src/util/RemoteAuth.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      Buffer,
      AbortController,
      setTimeout,
      clearTimeout,
      clearInterval,
      require: id => (id === 'ws' ? Socket : localRequire(id)),
    },
    { filename },
  );
  return { Auth: module.exports, sockets };
}

test('QR cancellation, socket close, error and explicit destroy settle pending login exactly once', async () => {
  for (const reason of ['cancel', 'close', 'error', 'destroy']) {
    const { Auth, sockets } = loadAuth();
    const auth = new Auth();
    let closed = 0;
    auth.on('closed', () => {
      closed++;
    });
    const pending = auth.connect({ login: async () => assert.fail('must not log in') });
    const rejected = assert.rejects(pending, /cancelled|closed|offline/);
    if (reason === 'cancel') sockets[0].emit('message', JSON.stringify({ op: 'cancel' }));
    else if (reason === 'error') sockets[0].emit('error', new Error('offline'));
    else if (reason === 'close') sockets[0].emit('close');
    else auth.destroy();
    await rejected;
    auth.destroy();
    assert.equal(sockets[0].closed, true);
    assert.equal(closed, 1);
    assert.equal(auth.listenerCount('finish'), 0);
    assert.equal(auth.listenerCount('error'), 0);
  }
});

test('late events from a replaced QR socket cannot cancel the new login', async () => {
  const { Auth, sockets } = loadAuth();
  const auth = new Auth();
  const first = auth.connect({ login: async () => assert.fail('must not log in') });
  const rejected = assert.rejects(first, /closed/);
  const second = auth.connect({ login: async () => assert.fail('must not log in') });
  const secondRejected = assert.rejects(second, /cancelled/);
  await rejected;
  sockets[0].emit('close');
  sockets[0].emit('error', new Error('stale socket error'));
  sockets[0].emit('message', JSON.stringify({ op: 'cancel' }));
  assert.equal(sockets[1].closed, false);
  sockets[1].emit('message', JSON.stringify({ op: 'cancel' }));
  await secondRejected;
});

test('concurrent gateway creation shares one operation and allows a later operation', async () => {
  const client = new EventEmitter();
  client.options = { shards: [0] };
  const gateway = new WebSocketManager(client);
  let release;
  let calls = 0;
  gateway._createShards = () => {
    calls++;
    return new Promise(resolve => {
      release = resolve;
    });
  };
  const first = gateway.createShards();
  assert.equal(gateway.createShards(), first);
  assert.equal(calls, 1);
  release(true);
  assert.equal(await first, true);
  const second = gateway.createShards();
  assert.equal(calls, 2);
  release(true);
  await second;
  gateway.destroy();
});

test('destroy aborts rate-limit waits and releases queued requests without sending them', async () => {
  for (const global of [false, true]) {
    const rest = manager();
    const handler = new RequestHandler(rest);
    if (global) {
      rest.globalRemaining = 0;
      rest.globalReset = Date.now() + 60_000;
    } else {
      handler.remaining = 0;
      handler.reset = Date.now() + 60_000;
    }
    const request = { method: 'get', path: '/wait', route: '/wait', make: () => assert.fail('must not send') };
    const first = handler.push(request);
    const second = handler.push({ ...request });
    const rejected = Promise.all([assert.rejects(first, /abort|destroyed/i), assert.rejects(second, /destroyed/i)]);
    await Promise.resolve();
    rest.destroy();
    await rejected;
    assert.equal(handler.queue.remaining, 0);
    assert.equal(rest.globalDelay, null);
  }
});
