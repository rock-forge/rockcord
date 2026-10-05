'use strict';

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { setTimeout, clearTimeout } = require('node:timers');
const { RtpHeader, RtpPacket } = require('werift-rtp');
require('../src');
const { group, gateway } = require('./dave-helpers.cjs');
const { H264Dispatcher, H265Dispatcher } = require('../src/client/voice/dispatcher/AnnexBDispatcher');
const AudioDispatcher = require('../src/client/voice/dispatcher/AudioDispatcher');
const BaseDispatcher = require('../src/client/voice/dispatcher/BaseDispatcher');
const { VP8Dispatcher } = require('../src/client/voice/dispatcher/VPxDispatcher');
const DAVE = require('../src/client/voice/networking/DAVE');
const VoiceWebSocket = require('../src/client/voice/networking/VoiceWebSocket');
const PacketHandler = require('../src/client/voice/receiver/PacketHandler');
const { VideoFrames, packetize, depacketize, lengthPrefixedToAnnexB } = require('../src/client/voice/util/VideoFrames');
const { VoiceOpcodes: Op } = require('../src/util/Constants');
const Util = require('../src/util/Util');

const frame = codec => {
  const payload = Buffer.alloc(5000, 0x47);
  if (codec === 'H264') return Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65, 0xff]), payload]);
  if (codec === 'H265') return Buffer.concat([Buffer.from([0, 0, 0, 1, 0x26, 1]), payload]);
  return Buffer.concat([Buffer.from([1]), payload]);
};

test('real MLS group encrypts/decrypts Opus and rejects tampering without returning ciphertext', () => {
  const { alice, bob, aliceId } = group();
  try {
    const plain = Buffer.from('test-only encoded audio bytes');
    const encrypted = alice.encrypt(plain);
    assert.notDeepEqual(encrypted, plain);
    assert.deepEqual(bob.decrypt(encrypted, aliceId), plain);
    const tampered = Buffer.from(encrypted);
    tampered[1] ^= 1;
    assert.equal(bob.decrypt(tampered, aliceId), null);
    assert.equal(bob.decrypt(plain, aliceId), null);
    assert.equal(alice.voicePrivacyCode, bob.voicePrivacyCode);
    assert.equal(typeof alice.voicePrivacyCode, 'string');
  } finally {
    alice.destroy();
    bob.destroy();
  }
});

test('H264/H265/VP8 encrypt whole frames, survive fragmentation/reordering/wrap, and decrypt exactly', () => {
  const { alice, bob, aliceId } = group();
  try {
    for (const codec of ['H264', 'H265', 'VP8']) {
      const original = frame(codec);
      const encrypted = alice.encrypt(original, codec);
      assert.notDeepEqual(encrypted, original);
      const payloads = packetize(encrypted, codec, 256, 65535);
      assert.ok(payloads.length > 1);
      assert.ok(payloads.every(p => p.length <= 256));
      const receiver = new VideoFrames();
      const packets = payloads.map(
        (payload, i) =>
          new RtpPacket(
            new RtpHeader({
              ssrc: 12,
              timestamp: 9000,
              sequenceNumber: (65534 + i) & 65535,
              marker: i === payloads.length - 1,
            }),
            payload,
          ),
      );
      assert.equal(receiver.push(packets[0], codec), null);
      assert.equal(receiver.push(packets.at(-1), codec), null);
      let reconstructed;
      for (const packet of packets.slice(1, -1)) reconstructed = receiver.push(packet, codec);
      assert.deepEqual(reconstructed, encrypted);
      assert.deepEqual(bob.decrypt(reconstructed, aliceId, true), original);
      for (const packet of packets) assert.equal(receiver.push(packet, codec), null, 'duplicate completed frame');
      const reverseReceiver = new VideoFrames();
      let reverseFrame;
      for (const packet of [...packets].reverse()) reverseFrame = reverseReceiver.push(packet, codec);
      assert.deepEqual(reverseFrame, encrypted);
      // Native replay protection rejects the frame already decrypted above.
      assert.equal(bob.decrypt(reverseFrame, aliceId, true), null);
    }
  } finally {
    alice.destroy();
    bob.destroy();
  }
});

test('pending negotiation and commit transitions suppress frames until the gateway executes', () => {
  const { alice, bob, bobId, aliceSent } = group();
  try {
    const plain = Buffer.from('audio');
    alice.pending.set(8, 1);
    alice.blocked = true;
    assert.equal(alice.encrypt(plain), null);
    assert.equal(alice.execute(99), false);
    assert.equal(alice.encrypt(plain), null);
    assert.equal(alice.execute(8), true);
    assert.deepEqual(bob.decrypt(alice.encrypt(plain), alice.userId), plain);
    const late = bob.encrypt(plain);
    alice.prepare({ transition_id: 9, protocol_version: 0 });
    assert.notDeepEqual(alice.encrypt(plain), plain);
    assert.ok(aliceSent.some(p => p.op === Op.DAVE_TRANSITION_READY && p.d.transition_id === 9));
    alice.execute(9);
    assert.deepEqual(alice.encrypt(plain), plain);
    assert.deepEqual(alice.decrypt(late, bobId), plain);
    alice.epoch({ epoch: 1, protocol_version: 1 });
    assert.equal(alice.encrypt(plain), null);
    assert.equal(alice.session.ready, false);
  } finally {
    alice.destroy();
    bob.destroy();
  }
  const pending = new DAVE(
    '100000000000000002',
    '100000000000000001',
    () => {},
    () => {},
  );
  assert.equal(pending.encrypt(Buffer.from('audio')), null);
  pending.destroy();
});

test('invalid commits trigger one invalid-transition report and a fresh key package', () => {
  const { alice, bob, aliceSent } = group();
  try {
    const keysBefore = aliceSent.filter(p => p.op === Op.MLS_KEY_PACKAGE).length;
    alice.binary(Op.MLS_ANNOUNCE_COMMIT_TRANSITION, Buffer.from([0, 7, 0]));
    assert.equal(aliceSent.filter(p => p.op === Op.MLS_INVALID_COMMIT_WELCOME).length, 1);
    assert.equal(aliceSent.filter(p => p.op === Op.MLS_KEY_PACKAGE).length, keysBefore + 1);
    assert.equal(alice.encrypt(Buffer.from('audio')), null);
    alice.recover(7);
    assert.equal(aliceSent.filter(p => p.op === Op.MLS_INVALID_COMMIT_WELCOME).length, 1);
  } finally {
    alice.destroy();
    bob.destroy();
  }
});

test('real proposals validate recognized membership and emit the combined commit/welcome', () => {
  const id = '100000000000000002';
  const otherId = '100000000000000003';
  const channel = '100000000000000001';
  const sent = [];
  const a = new DAVE(
    id,
    channel,
    () => {},
    (op, payload) => sent.push({ op, payload }),
  );
  const b = new DAVE(
    otherId,
    channel,
    () => {},
    () => {},
  );
  try {
    a.initialize(1);
    b.initialize(1);
    const service = gateway();
    a.binary(Op.MLS_EXTERNAL_SENDER, service.external);
    const proposal = service.proposal(channel, b.session.getSerializedKeyPackage());
    assert.throws(
      () => a.binary(Op.MLS_PROPOSALS, Buffer.concat([Buffer.from([0]), proposal])),
      /unexpected user|UnexpectedUser/i,
    );
    a.clients.add(otherId);
    a.binary(Op.MLS_PROPOSALS, Buffer.concat([Buffer.from([0]), proposal]));
    assert.ok(sent.some(p => p.op === Op.MLS_COMMIT_WELCOME && p.payload.length > 100));
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('voice gateway separates binary/JSON packets, tracks seq zero and membership, and advertises DAVE', () => {
  const connection = new EventEmitter();
  connection.channel = { id: '100000000000000001' };
  connection.client = { user: { id: '100000000000000002' } };
  connection.authentication = {};
  connection.ssrcMap = new Map();
  const socket = new VoiceWebSocket(connection);
  const sent = [];
  socket.sendPacket = async packet => sent.push(packet);
  socket.send = async payload => sent.push(payload);
  socket.setHeartbeat = () => {};
  let error;
  socket.on('error', value => {
    error = value;
  });
  socket.onPacket({ op: Op.HELLO, seq: 0, d: { heartbeat_interval: 1000 } });
  assert.equal(sent[0].d.max_dave_protocol_version, 1);
  socket.onMessage({
    data: Buffer.from(JSON.stringify({ op: Op.CLIENTS_CONNECT, d: { user_ids: ['100000000000000003'] } })),
    isBinary: false,
  });
  assert.equal(socket.dave.clients.has('100000000000000003'), true);
  socket.onPacket({ op: Op.SESSION_DESCRIPTION, d: { secret_key: Array(32).fill(0), dave_protocol_version: 1 } });
  socket.onMessage({
    data: Buffer.concat([Buffer.from([0, 0, Op.MLS_EXTERNAL_SENDER]), gateway().external]),
    isBinary: true,
  });
  assert.equal(socket._sequenceNumber, 0);
  assert.equal(error, undefined);
  socket.onMessage({ data: Buffer.from([0, 0]), isBinary: true });
  assert.match(error.message, /Truncated/);
  socket.shutdown();
  assert.equal(socket.dave.closed, true);
  assert.equal(socket.dave.session, null);
});

test('received encrypted video is reassembled and decrypted before recording', () => {
  const { alice, bob, aliceId } = group();
  const recorded = [];
  const receiver = new EventEmitter();
  receiver.connection = { dave: bob };
  const handler = new PacketHandler(receiver);
  handler.videoStreams.set(aliceId, { feed: packet => recorded.push(packet), destroy: () => {} });
  let received;
  receiver.on('videoFrame', (_, bytes) => {
    received = bytes;
  });
  try {
    const plain = frame('H264');
    const payloads = packetize(alice.encrypt(plain, 'H264'), 'H264', 400);
    payloads.forEach((payload, i) =>
      handler.videoReceiver(
        42,
        { userId: aliceId, hasVideo: true },
        new RtpPacket(
          new RtpHeader({
            ssrc: 42,
            timestamp: 9000,
            payloadType: Util.getPayloadType('H264'),
            sequenceNumber: i,
            marker: i === payloads.length - 1,
          }),
          payload,
        ),
      ),
    );
    assert.deepEqual(received, plain);
    assert.deepEqual(
      depacketize(
        recorded.map(p => p.payload),
        'H264',
      ),
      plain,
    );
    assert.equal(recorded.at(-1).header.marker, true);
  } finally {
    handler.destroyAllStream();
    alice.destroy();
    bob.destroy();
  }
});

test('screen-share DAVE groups use their media-session ID instead of the parent voice channel', () => {
  const connection = new EventEmitter();
  connection.channel = { id: '100000000000000001' };
  connection.serverId = '200000000000000002';
  connection.client = { user: { id: '100000000000000003' } };
  const socket = new VoiceWebSocket(connection);
  assert.equal(socket.dave.channelId, '200000000000000001');
  socket.shutdown();
});

test('authenticated RTX packets restore primary sequence/SSRC before DAVE video decryption', () => {
  const { alice, bob, aliceId } = group();
  const authentication = { secret_key: Buffer.alloc(32, 4), mode: 'aead_aes256_gcm_rtpsize', ssrc: 44 };
  const dispatcher = new BaseDispatcher({ voiceConnection: { authentication } }, 12, 106, false);
  const receiver = new EventEmitter();
  receiver.connection = {
    authentication,
    dave: bob,
    ssrcMap: new Map([[44, { userId: aliceId, hasVideo: true, kind: 'video-rtx', primarySsrc: 43 }]]),
  };
  const handler = new PacketHandler(receiver);
  let received;
  receiver.on('videoFrame', (_, bytes) => {
    received = bytes;
  });
  try {
    const plain = frame('H264');
    const payloads = packetize(alice.encrypt(plain, 'H264'), 'H264', 400);
    payloads.forEach((payload, i) => {
      const originalSequence = Buffer.alloc(2);
      originalSequence.writeUInt16BE(i);
      const packet = new RtpPacket(
        new RtpHeader({
          ssrc: 44,
          timestamp: 9000,
          sequenceNumber: 1000 + i,
          payloadType: 106,
          marker: i === payloads.length - 1,
        }),
        Buffer.concat([originalSequence, payload]),
      ).serialize();
      const header = packet.subarray(0, 12);
      handler.push(Buffer.concat([header, ...dispatcher._encrypt(packet.subarray(12), header)]));
    });
    assert.deepEqual(received, plain);
  } finally {
    dispatcher.destroy();
    handler.destroyAllStream();
    alice.destroy();
    bob.destroy();
  }
});

test('incomplete or malformed video is dropped and NAL lengths are validated', () => {
  const receiver = new VideoFrames();
  const packet = new RtpPacket(
    new RtpHeader({ ssrc: 1, timestamp: 1, sequenceNumber: 0, marker: true }),
    Buffer.from([28, 0x41, 1]),
  );
  assert.equal(receiver.push(packet, 'H264'), null);
  assert.throws(() => lengthPrefixedToAnnexB(Buffer.from([0, 0, 0, 10, 1])), /Invalid NAL/);
  assert.throws(() => depacketize([Buffer.from([24, 0, 9, 1])], 'H264'), /Invalid aggregation/);
});

test('audio dispatch and receive apply both DAVE and authenticated RTP without plaintext fallback', async () => {
  const { alice, bob, aliceId } = group();
  const authentication = { secret_key: Buffer.alloc(32, 9), mode: 'aead_aes256_gcm_rtpsize', ssrc: 42 };
  const player = { voiceConnection: { authentication, dave: alice } };
  const dispatcher = new AudioDispatcher(player);
  player.dispatcher = dispatcher;
  const sent = [];
  dispatcher._sendPacket = packet => sent.push(packet);
  const receiver = new EventEmitter();
  receiver.connection = {
    authentication,
    dave: bob,
    ssrcMap: new Map([[42, { userId: aliceId, speaking: 1 }]]),
    onSpeaking: () => {},
  };
  const handler = new PacketHandler(receiver);
  const stream = handler.makeStream(aliceId, 'manual');
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 2000);
  try {
    const plain = Buffer.from('encoded audio fixture');
    dispatcher._playChunk(plain);
    assert.equal(sent.length, 1);
    const inner = handler.parseBuffer(sent[0]).payload;
    assert.notDeepEqual(inner, plain);
    handler.push(sent[0]);
    await once(stream, 'readable', { signal: abort.signal });
    assert.deepEqual(stream.read(), plain);
    const tampered = Buffer.from(sent[0]);
    tampered[15] ^= 1;
    handler.push(tampered);
    assert.equal(stream.read(), null);
    alice.blocked = true;
    dispatcher._playChunk(plain);
    assert.equal(sent.length, 1);
    alice.blocked = false;
    const failure = new Error('encryption failure');
    alice.encrypt = () => {
      throw failure;
    };
    let writeError;
    dispatcher._write(plain, 'buffer', error => {
      writeError = error;
    });
    assert.equal(writeError, failure);
    assert.equal(sent.length, 1);
  } finally {
    clearTimeout(deadline);
    dispatcher.destroy();
    handler.destroyAllStream();
    alice.destroy();
    bob.destroy();
  }
});

test('real video dispatchers encrypt before fragmentation and receive plaintext through authenticated RTP', () => {
  const { alice, bob, aliceId } = group();
  const authentication = { secret_key: Buffer.alloc(32, 7), mode: 'aead_aes256_gcm_rtpsize', ssrc: 42 };
  const receiver = new EventEmitter();
  receiver.connection = {
    authentication,
    dave: bob,
    ssrcMap: new Map([[43, { userId: aliceId, hasVideo: true, kind: 'video' }]]),
  };
  const handler = new PacketHandler(receiver);
  try {
    for (const [codec, Dispatcher] of [
      ['H264', H264Dispatcher],
      ['H265', H265Dispatcher],
      ['VP8', VP8Dispatcher],
    ]) {
      const player = { voiceConnection: { authentication, dave: alice } };
      const dispatcher = new Dispatcher(player, 12, {}, 30);
      player.videoDispatcher = dispatcher;
      dispatcher.count = 100000;
      dispatcher.sequence = 65534;
      const sent = [];
      dispatcher._sendPacket = packet => sent.push(packet);
      let received;
      const listener = (_, bytes) => {
        received = bytes;
      };
      receiver.on('videoFrame', listener);
      try {
        const plain = frame(codec);
        let input = plain;
        if (codec !== 'VP8') {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(plain.length - 4);
          input = Buffer.concat([size, plain.subarray(4)]);
        }
        dispatcher._codecCallback(input);
        assert.ok(sent.length > 1);
        sent.forEach(packet => handler.push(packet));
        assert.deepEqual(received, plain);
        assert.equal(handler.parseBuffer(sent.at(-1)).header.marker, true);
        const count = sent.length;
        alice.blocked = true;
        dispatcher._codecCallback(input);
        assert.equal(sent.length, count);
        alice.blocked = false;
      } finally {
        receiver.removeListener('videoFrame', listener);
        dispatcher.destroy();
      }
    }
  } finally {
    handler.destroyAllStream();
    alice.destroy();
    bob.destroy();
  }
});
