'use strict';

// Offline regression evidence for the audit. These checks assert current defects,
// rather than their desired behavior. No Discord connections or credentials.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '../../..');
require(path.join(root, 'src'));

function load(file, substitutions = {}, globals = {}) {
  const filename = path.join(root, file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    require: id => Object.hasOwn(substitutions, id) ? substitutions[id] : localRequire(id),
    Buffer,
    performance,
    clearTimeout,
    clearInterval,
    ...globals,
  }, { filename });
  return module.exports;
}

function report(name, evidence) {
  console.log(JSON.stringify({ name, evidence }));
}

async function collect(splitter, chunks) {
  const out = [];
  splitter.on('data', chunk => out.push(chunk));
  const finished = new Promise((resolve, reject) => {
    splitter.once('end', resolve);
    splitter.once('error', reject);
  });
  for (const chunk of chunks) splitter.write(chunk);
  splitter.end();
  await finished;
  return out;
}

(async () => {
  const BaseDispatcher = require(path.join(root, 'src/client/voice/dispatcher/BaseDispatcher'));
  const authentication = { secret_key: Buffer.alloc(32, 7), mode: 'aead_aes256_gcm_rtpsize', ssrc: 123 };
  const player = { voiceConnection: { authentication } };
  const a = new BaseDispatcher(player, 12, 120, false);
  const b = new BaseDispatcher(player, 12, 120, false);
  const p1 = Buffer.from('AAAAAAAA');
  const p2 = Buffer.from('BBBBBBBB');
  const [c1, n1] = a._encrypt(p1, Buffer.from('header'));
  const [c2, n2] = b._encrypt(p2, Buffer.from('header'));
  const xor = (x, y) => Buffer.from(x.map((v, i) => v ^ y[i]));
  assert.equal(n1.toString('hex'), n2.toString('hex'));
  assert.equal(xor(c1.subarray(0, 8), c2.subarray(0, 8)).toString('hex'), xor(p1, p2).toString('hex'));
  report('repeated AES-GCM nonce across dispatchers', { nonce: n1.toString('hex'), ciphertextXorEqualsPlaintextXor: true });

  const delays = [];
  let now = 1_310_800;
  const TimedDispatcher = load('src/client/voice/dispatcher/BaseDispatcher.js', {
    'node:timers': { setTimeout: (fn, delay) => { delays.push(delay); return { unref() { return this; } }; } },
  }, { performance: { now: () => now } });
  const timed = new TimedDispatcher(player, 12, 120, false);
  timed.FRAME_LENGTH = 20;
  timed.TIMESTAMP_INC = 960;
  timed.count = 65535;
  timed.startTime = 100;
  timed._step(() => {});
  now += 20;
  timed._step(() => {});
  assert.deepEqual(delays, [20, -1_310_700]);
  report('scheduler rollover', { delays, frameCountAfterTwoSteps: timed.count });

  const extension = a.createPayloadExtension();
  assert.equal(extension.toString('hex'), '00000000');
  report('video extension omitted by unterminated comment', { extension: extension.toString('hex') });

  const PacketHandler = require(path.join(root, 'src/client/voice/receiver/PacketHandler'));
  const receiver = new EventEmitter();
  receiver.connection = { authentication, ssrcMap: new Map([[123, { userId: 'u' }]]) };
  const packets = new PacketHandler(receiver);
  const short = Buffer.alloc(1);
  const badAuth = Buffer.alloc(32);
  badAuth[0] = 0x80;
  badAuth.writeUInt32BE(123, 8);
  let shortError, authError;
  try { packets.push(short); } catch (e) { shortError = `${e.name}: ${e.message}`; }
  try { packets.push(badAuth); } catch (e) { authError = `${e.name}: ${e.message}`; }
  assert(shortError && authError);
  report('unhandled UDP parsing errors', { shortError, authError });

  const { H264NalSplitter } = require(path.join(root, 'src/client/voice/player/processing/AnnexBNalSplitter'));
  const start = Buffer.from([0, 0, 1]);
  const nal = bytes => Buffer.concat([start, Buffer.from(bytes)]);
  const singleFrame = Buffer.concat([nal([9, 0xf0]), nal([0x65, 0x11])]);
  const singleOut = await collect(new H264NalSplitter(), [singleFrame]);
  assert.equal(singleOut.length, 0);
  const frames = Buffer.concat([
    nal([0x67, 0x42]), nal([9, 0xf0]), nal([0x65, 0x11]),
    nal([9, 0xf0]), nal([0x41, 0x22]), nal([9, 0xf0]), nal([0x41, 0x33]),
  ]);
  const wholeOut = await collect(new H264NalSplitter(), [frames]);
  const splitOut = await collect(new H264NalSplitter(), [frames.subarray(0, 2), frames.subarray(2)]);
  assert.notDeepEqual(wholeOut, splitOut);
  report('Annex B start boundary and final frame loss', {
    oneFrameOutputCount: singleOut.length,
    intactFirstOutput: wholeOut[0].toString('hex'),
    splitFirstOutput: splitOut[0].toString('hex'),
  });

  const VoiceConnection = require(path.join(root, 'src/client/voice/VoiceConnection'));
  let udpShutdown = 0;
  const fakeUDP = Object.assign(new EventEmitter(), { shutdown: () => { udpShutdown++; } });
  const fakeConnection = {
    player: { destroy() {} },
    sockets: { ws: null, udp: fakeUDP },
    emit() {},
  };
  VoiceConnection.prototype.cleanup.call(fakeConnection);
  assert.equal(udpShutdown, 0);
  assert.equal(fakeConnection.sockets.udp, null);
  report('server-initiated cleanup loses open UDP socket', { udpShutdown, socketReferenceRemoved: true });

  const manual = packets.makeStream('manual-user', 'manual');
  manual.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packets.makeStream('manual-user', 'manual'), manual);
  assert.equal(manual.destroyed, true);
  report('manual receive stream cannot be recreated', { oldDestroyedStreamReturned: true });

  const UserFlags = require(path.join(root, 'src/util/UserFlags'));
  const flags = new UserFlags(UserFlags.FLAGS.VERIFIED_EMAIL);
  assert.equal(flags.has('VERIFIED_EMAIL'), false);
  assert.equal(new UserFlags().add('VERIFIED_EMAIL').bitfield, 0);
  report('flags above 32 bits truncated', { hasSetFlag: flags.has('VERIFIED_EMAIL'), addedFlag: new UserFlags().add('VERIFIED_EMAIL').bitfield });

  const LimitedCollection = require(path.join(root, 'src/util/LimitedCollection'));
  const cache = new LimitedCollection({ maxSize: 1 }, [['a', 1], ['b', 2]]);
  const disabledCache = new LimitedCollection({ maxSize: 0 }, [['a', 1]]);
  assert.equal(cache.size, 2);
  assert.equal(disabledCache.size, 1);
  report('cache constructor bypasses limits', { maxSize1Actual: cache.size, maxSize0Actual: disabledCache.size });

  const Util = require(path.join(root, 'src/util/Util'));
  const interactions = new EventEmitter();
  interactions.incrementMaxListeners = () => interactions.setMaxListeners(interactions.getMaxListeners() + 1);
  interactions.decrementMaxListeners = () => interactions.setMaxListeners(interactions.getMaxListeners() - 1);
  const { Events } = require(path.join(root, 'src/util/Constants'));
  const before = interactions.getMaxListeners();
  const promise = Util.createPromiseInteraction(interactions, '123', 15, true, { id: 'parent' });
  interactions.emit(Events.UNHANDLED_PACKET, { t: 'INTERACTION_SUCCESS', d: { nonce: '123' } });
  const hold = setTimeout(() => {}, 200);
  await promise;
  clearTimeout(hold);
  assert.equal(interactions.getMaxListeners(), before + 1);
  report('deferred interaction listener allowance leaks', { before, after: interactions.getMaxListeners() });

  const socketState = { closed: false, sends: [] };
  const fakeChild = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), pid: 999, spawnargs: ['ffmpeg', 'fake'] });
  const Recorder = load('src/client/voice/receiver/Recorder.js', {
    child_process: { spawn: () => fakeChild },
    dgram: { createSocket: () => ({ close: () => { socketState.closed = true; }, send: (...args) => socketState.sends.push(args) }) },
    'find-process': () => Promise.resolve([{ pid: 999 }]),
    'tree-kill': () => {},
  });
  const rec = new Recorder({ videoStreams: new Map() }, { userId: 'u', portUdpH264: 65506, portUdpOpus: 65510, output: 'audit.mkv' });
  await new Promise(resolve => setImmediate(resolve));
  rec.destroy();
  await new Promise(resolve => setImmediate(resolve));
  let spawnError;
  try { fakeChild.emit('error', new Error('spawn ffmpeg ENOENT')); } catch (e) { spawnError = e.message; }
  assert.equal(socketState.closed, false);
  assert.equal(spawnError, 'spawn ffmpeg ENOENT');
  report('recorder leaves UDP resource and spawn errors unhandled', { closed: socketState.closed, spawnError });
})();
