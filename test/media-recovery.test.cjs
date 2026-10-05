'use strict';

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { setTimeout: setDeadline, clearTimeout } = require('node:timers');
const { setTimeout } = require('node:timers/promises');
const { RtpPacket, RtpHeader } = require('werift-rtp');
require('../src');
const { group } = require('./dave-helpers.cjs');
const VideoDispatcher = require('../src/client/voice/dispatcher/VideoDispatcher');
const MediaRecovery = require('../src/client/voice/networking/MediaRecovery');
const { AudioJitter, duration } = require('../src/client/voice/receiver/AudioJitter');
const PacketHandler = require('../src/client/voice/receiver/PacketHandler');
const { encrypt, decrypt } = require('../src/client/voice/util/TransportCrypto');
const { packetize, VideoFrames } = require('../src/client/voice/util/VideoFrames');

test('late leading NALs remain recoverable after a syntactically complete tail fails authentication', () => {
  const frames = new VideoFrames();
  const first = new RtpPacket(
    new RtpHeader({ ssrc: 43, timestamp: 9000, sequenceNumber: 10, payloadType: 105 }),
    Buffer.from([0x67, 0x42]),
  );
  const last = new RtpPacket(
    new RtpHeader({ ssrc: 43, timestamp: 9000, sequenceNumber: 11, payloadType: 105, marker: true }),
    Buffer.from([0x65, 0x17]),
  );
  const expected = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x65, 0x17]);
  const authenticate = candidate => candidate.equals(expected);
  assert.equal(frames.push(last, 'H264', authenticate), null);
  assert.deepEqual(frames.push(first, 'H264', authenticate), expected);
  assert.equal(frames.push(last, 'H264', authenticate), null);
});

test('transport probe packets never enter DAVE media decryption', () => {
  const receiver = new EventEmitter();
  const connection = (receiver.connection = {
    authentication: auth(),
    ssrcMap: new Map([[42, { userId: 'u' }]]),
    dave: { decrypt: () => assert.fail('probe is not Opus media') },
  });
  const handler = new PacketHandler(receiver);
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 96;
  header.writeUInt32BE(42, 8);
  try {
    handler.push(Buffer.concat([header, ...encrypt(connection, Buffer.alloc(12), header)]));
    assert.equal(handler.audioJitters.size, 0);
  } finally {
    handler.destroyAllStream();
  }
});

function auth() {
  return { secret_key: Buffer.alloc(32, 17), mode: 'aead_aes256_gcm_rtpsize', ssrc: 42 };
}

test('encrypted NACK repairs a missing DAVE video fragment through RTX across sequence wrap', async () => {
  const { alice, bob, aliceId } = group();
  const sender = { authentication: auth(), sockets: {}, dave: alice };
  const recovery = (sender._mediaRecovery = new MediaRecovery(sender));
  const receiver = new EventEmitter();
  receiver.connection = {
    authentication: auth(),
    dave: bob,
    sockets: {},
    ssrcMap: new Map([
      [43, { userId: aliceId, kind: 'video', hasVideo: true }],
      [44, { userId: aliceId, kind: 'video-rtx', primarySsrc: 43, hasVideo: true }],
    ]),
  };
  const handler = new PacketHandler(receiver);
  const nonces = [];
  sender.sockets.udp = {
    send: async packet => {
      nonces.push(packet.readUInt32BE(packet.length - 4));
      handler.push(packet);
    },
  };
  receiver.connection.sockets.udp = { send: async packet => recovery.handle(packet) };
  const player = { voiceConnection: sender };
  const dispatcher = new VideoDispatcher(player, 12, {}, 30, 105);
  dispatcher.sequence = 65534;
  const plain = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(3000, 0x17)]);
  const abort = new AbortController();
  const deadline = setDeadline(() => abort.abort(), 2000);
  try {
    const received = once(receiver, 'videoFrame', { signal: abort.signal });
    const payloads = packetize(alice.encrypt(plain, 'H264'), 'H264', 800);
    payloads.forEach((payload, index) => {
      const packet = dispatcher._createPacket(
        Buffer.concat([dispatcher.createPayloadExtension(), payload]),
        index === payloads.length - 1,
      );
      nonces.push(packet.readUInt32BE(packet.length - 4));
      if (index !== 1) handler.push(packet);
    });
    const [, result] = await received;
    assert.deepEqual(result, plain);
    assert.equal(recovery.stats.retransmitted, 1);
    assert.equal(handler.recovery.stats.recovered, 1);
    assert.equal(new Set(nonces).size, nonces.length);
  } finally {
    clearTimeout(deadline);
    dispatcher.destroy();
    recovery.reset();
    handler.destroyAllStream();
    alice.destroy();
    bob.destroy();
  }
});

test('NACK rejects tampering and expired/key-rotated cache entries and limits repeat retries', () => {
  const connection = { authentication: auth(), sockets: { udp: { send: async () => {} } } };
  const recovery = new MediaRecovery(connection);
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 105;
  header.writeUInt32BE(43, 8);
  recovery.remember(header, Buffer.from([0x65, 1]));
  const feedback = Buffer.from([0x81, 205, 0, 3, 0, 0, 0, 2, 0, 0, 0, 43, 0, 0, 0, 0]);
  const encrypted = Buffer.concat([
    feedback.subarray(0, 8),
    ...encrypt(connection, feedback.subarray(8), feedback.subarray(0, 8)),
  ]);
  const tampered = Buffer.from(encrypted);
  tampered[12] ^= 1;
  recovery.handle(tampered);
  assert.equal(recovery.stats.retransmitted, 0);
  const entry = recovery.cache.get('43:0');
  for (let i = 0; i < 10; i++) {
    entry.last = -Infinity;
    recovery.handle(encrypted);
  }
  assert.equal(recovery.stats.retransmitted, 3);
  entry.retries = 0;
  entry.last = -Infinity;
  entry.time -= 3000;
  recovery.handle(encrypted);
  assert.equal(recovery.stats.retransmitted, 3);
  entry.time = performance.now();
  connection.authentication.secret_key = Buffer.alloc(32, 18);
  recovery.handle(encrypted);
  assert.equal(recovery.stats.retransmitted, 3);
  recovery.reset();
});

test('RTCP and RTP share fresh transport nonces and tampered feedback fails authentication', () => {
  const connection = { authentication: auth() };
  const header = Buffer.from([0x81, 205, 0, 3, 0, 0, 0, 1]);
  const body = Buffer.alloc(8);
  const first = Buffer.concat([header, ...encrypt(connection, body, header)]);
  const second = Buffer.concat([header, ...encrypt(connection, body, header)]);
  assert.notEqual(first.readUInt32BE(first.length - 4), second.readUInt32BE(second.length - 4));
  assert.deepEqual(decrypt(connection, first, 8), Buffer.concat([header, body]));
  first[15] ^= 1;
  assert.throws(() => decrypt(connection, first, 8));
});

function audio(seq, timestamp, value = 1) {
  return new RtpPacket(
    new RtpHeader({ sequenceNumber: seq, timestamp, ssrc: 42, payloadType: 120 }),
    Buffer.from([0xf8, value]),
  );
}

test('audio jitter orders late packets, rejects duplicates, pads loss and handles wrap', async () => {
  const delivered = [];
  const jitter = new AudioJitter(packet => delivered.push(packet));
  try {
    jitter.push(audio(65534, 0));
    jitter.push(audio(0, 1920));
    jitter.push(audio(65535, 960));
    jitter.push(audio(65535, 960));
    jitter.push(audio(2, 3840));
    await setTimeout(160);
    assert.deepEqual(
      delivered.map(packet => packet.header.sequenceNumber),
      [65534, 65535, 0, 1, 2],
    );
    assert.deepEqual(delivered[3].payload, Buffer.from([0xf8, 0xff, 0xfe]));
    jitter.push(audio(0, 1920));
    await setTimeout(25);
    assert.equal(delivered.length, 5);
    jitter.push(audio(3, 4800));
    jitter.reset();
    await setTimeout(25);
    assert.equal(delivered.length, 5);
    assert.equal(jitter.packets.size, 0);
  } finally {
    jitter.reset();
  }
});

test('Opus TOC duration supports variable packet duration and bounds malformed input', () => {
  assert.equal(duration(Buffer.from([0xf8])), 20);
  assert.equal(duration(Buffer.from([0x80])), 2.5);
  assert.equal(duration(Buffer.from([0x18])), 60);
  assert.equal(duration(Buffer.from([0xfb, 3])), 60);
  assert.equal(duration(Buffer.from([0xfb, 63])), 20);
});
