'use strict';

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { setImmediate } = require('node:timers/promises');
const vm = require('node:vm');
const { fixture } = require('./helpers.cjs');
const api = require('../src');
const Util = api.Util;
const VoiceWebSocket = require('../src/client/voice/networking/VoiceWebSocket');
const MessagePayload = require('../src/structures/MessagePayload');

test('every declared public class/function has a defined package entrypoint export', () => {
  const ts = require('typescript');
  const source = readFileSync(path.resolve(__dirname, '../typings/index.d.ts'), 'utf8');
  const declarations = ts.createSourceFile('index.d.ts', source, ts.ScriptTarget.Latest, true);
  const missing = declarations.statements
    .filter(
      node =>
        (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)) &&
        node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword),
    )
    .map(node => node.name.text)
    .filter(name => typeof api[name] !== 'function');
  assert.deepEqual(missing, []);
  assert.equal(
    Object.entries(api).some(([, value]) => value === undefined),
    false,
  );
});

function load(relative, substitutions = {}, globals = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      Buffer,
      clearTimeout,
      performance,
      require: id => (Object.hasOwn(substitutions, id) ? substitutions[id] : localRequire(id)),
      ...globals,
    },
    { filename },
  );
  return module.exports;
}

test('upload size is exact and edit combines retained attachments with uploaded descriptors', async () => {
  const { client, channel, raw } = fixture();
  const retained = '100000000000000009';
  channel.messages._add({ ...raw, attachments: [{ id: retained, filename: 'old.txt', size: 3 }] });
  let body;
  client.api = {
    channels: {
      [channel.id]: {
        attachments: {
          post: async ({ data }) => {
            assert.equal(data.files[0].file_size, 4);
            return { attachments: [{ id: '0', upload_url: 'http://unused.invalid', upload_filename: 'uploaded' }] };
          },
        },
        messages: {
          [raw.id]: {
            patch: async ({ data }) => {
              body = data;
              return raw;
            },
          },
        },
      },
    },
  };
  const originalUpload = Util.uploadFile;
  Util.uploadFile = async bytes => assert.equal(bytes.length, 4);
  try {
    await channel.messages.edit(raw.id, { files: [{ attachment: Buffer.from('test'), name: 'new.txt' }] });
    assert.deepEqual(
      body.attachments.map(attachment => String(attachment.id)),
      [retained, '0'],
    );
    assert.equal(body.attachments[1].uploaded_filename, 'uploaded');
  } finally {
    Util.uploadFile = originalUpload;
  }
});

test('payload resolution does not mutate callers retained attachment arrays', () => {
  const { channel } = fixture();
  const attachments = [{ id: '100000000000000009' }];
  const options = { attachments, files: [{ attachment: Buffer.from('test'), name: 'new.txt' }] };
  const payload = MessagePayload.create(channel, options).resolveData();
  assert.equal(attachments.length, 1);
  assert.equal(payload.data.attachments.length, 2);
  assert.notEqual(payload.data.attachments, attachments);
});

test('digit-containing and nested menu IDs work; submission failures reject without leaking listeners', async () => {
  const { client, raw } = fixture();
  const events = new EventEmitter();
  for (const method of ['on', 'removeListener', 'emit']) client[method] = events[method].bind(events);
  client.incrementMaxListeners = () => events.setMaxListeners(events.getMaxListeners() + 1);
  client.decrementMaxListeners = () => events.setMaxListeners(events.getMaxListeners() - 1);
  const message = new api.Message(client, {
    ...raw,
    components: [
      {
        type: 17,
        components: [
          {
            type: 1,
            components: [
              {
                type: 3,
                custom_id: 'menu1',
                min_values: 1,
                max_values: 1,
                options: [{ label: 'A', value: 'a' }],
              },
            ],
          },
        ],
      },
    ],
  });
  let sent;
  client.api = {
    interactions: {
      post: async ({ data }) => {
        sent = data;
        events.emit(api.Constants.Events.UNHANDLED_PACKET, { t: 'INTERACTION_SUCCESS', d: { nonce: data.nonce } });
      },
    },
  };
  assert.equal(await message.selectMenu('menu1', ['A']), message);
  assert.equal(sent.data.custom_id, 'menu1');
  assert.deepEqual(sent.data.values, ['a']);
  assert.throws(() => message.selectMenu('missing1', ['a']), /INVALID_TYPE/);
  assert.throws(() => message.selectMenu('menu1', ['missing']), /INVALID_TYPE/);
  client.api.interactions.post = async () => {
    throw new Error('submission failed');
  };
  await assert.rejects(message.selectMenu('menu1', ['a']), /submission failed/);
  assert.equal(events.getMaxListeners(), 10);
  assert.equal(events.eventNames().length, 0);
});

test('IPC fetch and eval settle and clean their listeners after exit or kill', async () => {
  for (const reason of ['exit', 'kill']) {
    const shard = new api.Shard({ mode: 'process', respawn: false, totalShards: 1 }, 0);
    const child = new EventEmitter();
    child.send = (_, callback) => callback();
    shard.process = child;
    child.on('exit', () => shard._handleExit(false));
    const pending = [shard.fetchClientValue('user.id'), shard.eval('this.user.id')];
    const rejected = Promise.all(pending.map(promise => assert.rejects(promise, /child process|child|SHARDING/i)));
    if (reason === 'exit') child.emit('exit');
    else shard._handleExit(false);
    await rejected;
    assert.equal(child.listenerCount('message'), 0);
    assert.equal(child.getMaxListeners(), 10);
    assert.equal(shard.listenerCount('death'), 0);
  }
});

test('playback timing stays monotonic beyond 65535 frames, while RTP timestamp wraps', () => {
  const delays = [];
  let now = 1_310_800;
  const Dispatcher = load(
    'src/client/voice/dispatcher/BaseDispatcher.js',
    {
      'node:timers': {
        setTimeout: (_, delay) => {
          delays.push(delay);
          return {
            unref() {
              return this;
            },
          };
        },
      },
    },
    { performance: { now: () => now } },
  );
  const dispatcher = new Dispatcher({}, 12, 120, false);
  dispatcher.FRAME_LENGTH = 20;
  dispatcher.TIMESTAMP_INC = 960;
  dispatcher.count = 65535;
  dispatcher.startTime = 100;
  dispatcher.timestamp = 2 ** 32 - 1;
  dispatcher._step(() => {});
  assert.equal(dispatcher.timestamp, 959);
  now += 20;
  dispatcher._step(() => {});
  assert.deepEqual(delays, [20, 20]);
  assert.equal(dispatcher.count, 65537);
});

test('voice identifies after HELLO, keeps zero sequence, and clearly rejects unsupported DAVE', () => {
  const connection = new EventEmitter();
  connection.authentication = { endpoint: 'voice.example:443', token: 'FAKE_VOICE_TOKEN', sessionId: 'session' };
  connection.channel = { id: 'channel' };
  connection.client = { user: { id: 'user' } };
  const socket = new VoiceWebSocket(connection);
  const sent = [];
  let error;
  socket.on('error', value => {
    error = value;
  });
  socket.sendPacket = async packet => sent.push(packet);
  socket.setHeartbeat = () => {};
  socket.onOpen();
  assert.equal(sent.length, 0);
  socket.onPacket({ op: api.Constants.VoiceOpcodes.HELLO, seq: 0, d: { heartbeat_interval: 1000 } });
  assert.equal(sent.length, 1);
  assert.equal(socket._sequenceNumber, 0);
  socket.onPacket({ op: api.Constants.VoiceOpcodes.SESSION_DESCRIPTION, d: { dave_protocol_version: 999 } });
  assert.equal(error.code, 'VOICE_DAVE_UNSUPPORTED');
  assert.equal(socket.dead, true);
  assert.equal(connection.listenerCount('closing'), 0);
});

test('recorder handles early destruction and failed FFmpeg spawn without retaining sockets', async () => {
  const children = [];
  const sockets = [];
  const Recorder = load('src/client/voice/receiver/Recorder.js', {
    child_process: {
      spawn: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stderr = new PassThrough();
        children.push(child);
        return child;
      },
    },
    dgram: {
      createSocket: () => {
        const socket = new EventEmitter();
        socket.close = () => {
          socket.closed = true;
        };
        sockets.push(socket);
        return socket;
      },
    },
    'tree-kill': () => assert.fail('must not kill an unrelated process'),
  });
  const early = new Recorder({}, { userId: 'u', portUdpH264: 65506, portUdpOpus: 65510, output: 'test.mkv' });
  early.destroy();
  await setImmediate();
  assert.equal(children.length, 0);
  assert.equal(sockets[0].closed, true);
  const failed = new Recorder({}, { userId: 'u', portUdpH264: 65506, portUdpOpus: 65510, output: 'test.mkv' });
  await setImmediate();
  assert.doesNotThrow(() => children[0].emit('error', new Error('spawn ffmpeg ENOENT')));
  assert.equal(failed.destroyed, true);
  assert.equal(sockets[1].closed, true);
});

test('recording port allocation skips odd ports and an explicitly reserved port', async () => {
  const candidates = [50000, 50001, 50002];
  const Recorder = load('src/client/voice/receiver/Recorder.js', {
    '../util/Function': { randomPort: async () => candidates.shift() },
    child_process: {
      spawn: () => {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stderr = new PassThrough();
        return child;
      },
    },
    dgram: {
      createSocket: () => {
        const socket = new EventEmitter();
        socket.close = () => {};
        return socket;
      },
    },
  });
  const recorder = new Recorder({}, { portUdpH264: 50000, portUdpOpus: 0, output: 'test.mkv' });
  await recorder.promise;
  assert.equal(recorder.portUdpH264, 50000);
  assert.equal(recorder.portUdpOpus, 50002);
  recorder.destroy();
});

test('destroying a dispatcher cancels its pending audio/video synchronization', () => {
  const timers = new Set();
  const Dispatcher = load(
    'src/client/voice/dispatcher/BaseDispatcher.js',
    {
      'node:timers': {
        setTimeout: () => {
          const timer = { unref: () => timer };
          timers.add(timer);
          return timer;
        },
      },
    },
    { clearTimeout: timer => timers.delete(timer) },
  );
  const dispatcher = new Dispatcher({}, 12, 120, false);
  const peer = new EventEmitter();
  dispatcher._syncDispatcher = peer;
  dispatcher._playChunk = () => {};
  dispatcher._step = () => {};
  dispatcher.pause = () => {};
  dispatcher.resume = () => assert.fail('must not resume after destroy');
  dispatcher._write(Buffer.from([1]), null, () => {});
  assert.equal(peer.listenerCount('start'), 1);
  dispatcher.destroy();
  assert.equal(peer.listenerCount('start'), 0);
  assert.equal(timers.size, 0);
  peer.emit('start');
});
