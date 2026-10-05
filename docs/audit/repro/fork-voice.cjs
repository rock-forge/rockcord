'use strict';

// Offline DAVE wiring checks only. Native Davey is loaded from the reference
// checkout; no Client is constructed and no Discord or UDP connections occur.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
const fork = path.join(root, '.tmp/reference-youtsuho');
require(path.join(root, 'src'));
const nativeRequire = createRequire(path.join(fork, 'package.json'));
const Davey = nativeRequire('@snazzah/davey');
const DAVESession = nativeRequire('./src/client/voice/util/DAVESession');
const BaseDispatcher = nativeRequire('./src/client/voice/dispatcher/BaseDispatcher');

function report(name, evidence) { console.log(JSON.stringify({ name, evidence })); }
function load(file, substitutions = {}) {
  const filename = path.join(fork, file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module,
    exports: module.exports,
    require: id => Object.hasOwn(substitutions, id) ? substitutions[id] : localRequire(id),
    Buffer, performance, clearTimeout, clearInterval,
  }, { filename });
  return module.exports;
}

const real = new DAVESession(1, '100000000000000001', '100000000000000002');
real.reinit();
assert.equal(real.session.ready, false);
const clearFrame = Buffer.from('synthetic opus frame');
assert.equal(real.encrypt(clearFrame), clearFrame);
report('DAVE v1 sends plaintext while MLS is unready', {
  nativeVersion: Davey.VERSION, protocolVersion: real.protocolVersion,
  nativeReady: real.session.ready, returnedInputUnchanged: true,
});
real.destroy();

const sent = [];
const decrypted = [];
const wrapper = new DAVESession(1, '100000000000000001', '100000000000000002');
wrapper.session = {
  ready: true,
  encryptOpus(packet) { sent.push(Buffer.from(packet)); return packet; },
  decrypt(userId, mediaType, packet) { decrypted.push({ userId, mediaType }); return packet; },
  processWelcome() {},
};
const authentication = { secret_key: Buffer.alloc(32, 7), mode: 'aead_aes256_gcm_rtpsize', ssrc: 123 };
const connection = { authentication, daveSession: wrapper, ssrcMap: new Map() };
const player = { voiceConnection: connection };
const video = new BaseDispatcher(player, 12, 105, true);
video.getTypeDispatcher = () => 'video';
const videoPayload = Buffer.concat([video.createPayloadExtension(), Buffer.from([0x65, 0x11])]);
video._createPacket(videoPayload, true);
assert.equal(sent.length, 1);
assert.equal(sent[0].toString('hex'), '000000006511');
report('video fragment and extension routed through encryptOpus', { encryptOpusInput: sent[0].toString('hex') });

const PacketHandler = load('src/client/voice/receiver/PacketHandler.js', {
  './Recorder': require(path.join(root, 'src/client/voice/receiver/Recorder')),
  '../../../util/Util': require(path.join(root, 'src/util/Util')),
});
const receiver = new EventEmitter();
receiver.connection = connection;
const handler = new PacketHandler(receiver);
connection.daveSession = null;
const plainVideo = new BaseDispatcher(player, 12, 105, false);
plainVideo.getTypeDispatcher = () => 'video';
const transportPacket = plainVideo._createPacket(Buffer.from([0x65, 0x11]), true);
connection.daveSession = wrapper;
handler.parseBuffer(transportPacket, { userId: '100000000000000003' });
assert.equal(decrypted[0].mediaType, Davey.MediaType.AUDIO);
report('video receive routed through AUDIO decryption', { payloadType: 105, usedMediaType: decrypted[0].mediaType, VIDEO: Davey.MediaType.VIDEO });

const transition = Buffer.from([0, 42, 1]);
wrapper.processWelcome(transition);
assert.equal(wrapper.pendingTransitions.get(42), 1);
const before = sent.length;
wrapper.encrypt(Buffer.from('next epoch frame'));
assert.equal(sent.length, before + 1);
report('media encryption ungated while transition execution pending', {
  pendingTransitionId: 42, encryptedImmediately: true, lastExecutedTransition: wrapper.lastTransitionId,
});

const VoiceConnection = load('src/client/voice/VoiceConnection.js', {
  './networking/VoiceWebSocket': require(path.join(root, 'src/client/voice/networking/VoiceWebSocket')),
  './player/MediaPlayer': require(path.join(root, 'src/client/voice/player/MediaPlayer')),
  './receiver/Receiver': require(path.join(root, 'src/client/voice/receiver/Receiver')),
});
const readyEvents = [];
const fakeConnection = {
  authentication: {}, dispatcher: {}, videoDispatcher: null,
  daveSession: { protocolVersion: 1, session: { ready: false } },
  emit(event) { readyEvents.push(event); },
};
VoiceConnection.prototype.onSessionDescription.call(fakeConnection, {
  mode: 'aead_aes256_gcm_rtpsize', secret_key: Buffer.alloc(32, 7), dave_protocol_version: 1,
});
assert(readyEvents.includes('ready'));
report('connection ready precedes DAVE readiness', { events: readyEvents, daveReady: false });
