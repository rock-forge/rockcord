'use strict';

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { createHmac } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { setTimeout } = require('node:timers/promises');
const { RtpPacket, RtpHeader } = require('werift-rtp');
const { group } = require('./dave-helpers.cjs');
const api = require('../src');
const AudioDispatcher = require('../src/client/voice/dispatcher/AudioDispatcher');
const { VP8Dispatcher } = require('../src/client/voice/dispatcher/VPxDispatcher');
const VideoDispatcher = require('../src/client/voice/dispatcher/VideoDispatcher');
const CongestionControl = require('../src/client/voice/networking/CongestionControl');
const MediaRecovery = require('../src/client/voice/networking/MediaRecovery');
const PacketHandler = require('../src/client/voice/receiver/PacketHandler');
const Recorder = require('../src/client/voice/receiver/Recorder');
const { encrypt, decrypt } = require('../src/client/voice/util/TransportCrypto');

test('TOTP migration retains synchronous codes and isolates options between clients', () => {
  const first = new api.Client();
  const second = new api.Client();
  try {
    const epoch = 1600000000000;
    first.authenticator.options = { epoch, digits: 8 };
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(epoch / 30000)));
    const digest = createHmac('sha1', '12345678901234567890').update(counter).digest();
    const offset = digest.at(-1) & 15;
    const expected = String((digest.readUInt32BE(offset) & 0x7fffffff) % 100000000).padStart(8, '0');
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(first.authenticator.generate(secret), expected);
    assert.equal(second.authenticator.options.digits, 6);
    assert.match(second.authenticator.generate('JBSWY3DPEHPK3PXP'), /^\d{6}$/);
    assert.equal(first.authenticator.check(expected, secret), true);
  } finally {
    first.destroy();
    second.destroy();
  }
});

test('congestion control decreases on loss, recovers slowly, obeys bounds and ignores stale reports', () => {
  const changes = [];
  const control = new CongestionControl({ bitrate: 1000, minBitrate: 100, onChange: value => changes.push(value) });
  control.report(0.2, 20, 1, 1000);
  assert.equal(control.targetBitrate, 750000);
  control.report(0, 20, 1, 2000);
  control.report(0, 19, 1, 2000);
  assert.equal(control.targetBitrate, 750000);
  control.report(0, 21, 1, 2000);
  assert.equal(control.targetBitrate, 787500);
  for (let index = 0; index < 20; index++) control.report(1, 22 + index, 1, 3000 + index * 1000);
  assert.equal(control.targetBitrate, 100000);
  for (let index = 0; index < 100; index++) control.report(0, 42 + index, 1, 24000 + index * 1000);
  assert.equal(control.targetBitrate, 1000000);
  assert.ok(changes.length > 2);
  assert.throws(() => new CongestionControl({ bitrate: NaN }), RangeError);
});

test('pacing uses the changed bitrate without catch-up bursts or unlimited idle credit', () => {
  const control = new CongestionControl({ bitrate: 1000, minBitrate: 100 });
  assert.equal(control.delay(1250, 0), 0);
  assert.equal(control.delay(1250, 0), 10);
  control.report(0.2, 1, 1, 1000);
  assert.equal(control.delay(1250, 0), 20);
  assert.ok(Math.abs(control.delay(1250, 0) - 33.33333333) < 0.001);
  assert.equal(control.delay(1250, 10000), 0);
});

test('NACK fallback reduces the rate without receiver reports and counts repeated requests once', () => {
  const control = new CongestionControl({ bitrate: 1000 });
  control.windowStart = 0;
  for (let index = 0; index < 20; index++) control.packetSent(10);
  for (let index = 0; index < 10; index++) control.nack(1);
  control.packetSent(1000);
  assert.equal(control.targetBitrate, 900000);
  control.windowStart = 1000;
  for (let index = 0; index < 20; index++) control.packetSent(1010);
  control.packetSent(2000);
  assert.equal(control.targetBitrate, 900000, 'absence of NACKs cannot prove a healthy path');
});

function auth() {
  return { secret_key: Buffer.alloc(32, 7), ssrc: 42, mode: 'aead_aes256_gcm_rtpsize' };
}

test('authenticated receiver reports drive only the reported outbound video source', () => {
  const control = new CongestionControl({ bitrate: 1000 });
  const connection = { authentication: auth(), _congestionControl: control };
  const recovery = new MediaRecovery(connection);
  const packet = Buffer.alloc(32);
  packet[0] = 0x81;
  packet[1] = 201;
  packet.writeUInt16BE(7, 2);
  packet.writeUInt32BE(123, 4);
  packet.writeUInt32BE(42, 8);
  packet[12] = 128;
  packet.writeUInt32BE(100, 16);
  const seal = () =>
    Buffer.concat([packet.subarray(0, 8), ...encrypt(connection, packet.subarray(8), packet.subarray(0, 8))]);
  try {
    recovery.handle(seal());
    assert.equal(control.targetBitrate, 1000000);
    packet.writeUInt32BE(43, 8);
    const tampered = seal();
    tampered[15] ^= 1;
    recovery.handle(tampered);
    assert.equal(control.targetBitrate, 1000000);
    recovery.handle(seal());
    assert.equal(control.targetBitrate, 750000);
    packet[0] = 0x82;
    assert.doesNotThrow(() => recovery.handle(seal()));
  } finally {
    recovery.reset();
  }
});

test('receiver loss reports handle RTP wrap, duplicate packets and late recovery', () => {
  const reports = [];
  const connection = { authentication: auth(), sockets: { udp: { send: async packet => reports.push(packet) } } };
  const recovery = new MediaRecovery(connection);
  const packet = sequence => new RtpPacket(new RtpHeader({ ssrc: 43, sequenceNumber: sequence }), Buffer.alloc(1));
  try {
    recovery.receive(packet(65534));
    recovery.receive(packet(0));
    recovery.receive(packet(0));
    recovery._report();
    const first = decrypt(connection, reports[0], 8);
    assert.equal(first[12], 85);
    assert.equal(first.readUInt32BE(16), 65536);
    recovery.receive(packet(65535));
    recovery.receive(packet(1));
    recovery._report();
    assert.equal(decrypt(connection, reports[1], 8)[12], 0);
    recovery.reset();
    assert.equal(recovery.reportTimer, null);
    recovery.receive(packet(1));
    recovery.receive(packet(3));
    recovery.receive(packet(2), true);
    recovery._report();
    assert.equal(decrypt(connection, reports[2], 8)[12], 85, 'RTX must not conceal primary path loss');
  } finally {
    recovery.reset();
  }
});

test('paced initial video and synchronized audio preserve native DAVE nonce-zero ordering', async () => {
  const { alice, bob, aliceId } = group();
  const authentication = auth();
  const receiver = new EventEmitter();
  receiver.connection = {
    authentication,
    dave: bob,
    onSpeaking() {},
    ssrcMap: new Map([
      [42, { userId: aliceId, speaking: 1 }],
      [43, { userId: aliceId, kind: 'video', hasVideo: true }],
    ]),
  };
  const handler = new PacketHandler(receiver);
  const stream = handler.makeStream(aliceId, 'manual');
  let receivedVideo;
  receiver.on('videoFrame', (_, frame) => {
    receivedVideo = frame;
  });
  const player = {
    voiceConnection: {
      authentication,
      dave: alice,
      setSpeaking() {},
      setVideoStatus() {},
      sockets: { udp: { send: async packet => handler.push(packet) } },
    },
  };
  const video = new VP8Dispatcher(player, 12, {}, 30);
  const audio = new AudioDispatcher(player);
  player.videoDispatcher = video;
  player.dispatcher = audio;
  video._syncDispatcher = audio;
  video.configureCongestion({ bitrate: 128 });
  const videoFrame = Buffer.concat([Buffer.from([1]), Buffer.alloc(5000, 0x47)]);
  const audioFrame = Buffer.from('native DAVE concurrent audio');
  try {
    const finished = Promise.all([once(video, 'finish'), once(audio, 'finish')]);
    video.end(videoFrame);
    audio.end(audioFrame);
    await Promise.race([finished, setTimeout(2000).then(() => assert.fail('Synchronized startup timed out'))]);
    assert.deepEqual(receivedVideo, videoFrame);
    await Promise.race([
      once(stream, 'readable'),
      setTimeout(1000).then(() => assert.fail('Audio reception timed out')),
    ]);
    assert.deepEqual(stream.read(), audioFrame);
  } finally {
    video.destroy();
    audio.destroy();
    handler.destroyAllStream();
    alice.destroy();
    bob.destroy();
  }
});

test('paced video preserves packet order and cancels delayed sends when destroyed', async () => {
  const sent = [];
  const connection = {
    authentication: auth(),
    setVideoStatus() {},
    sockets: { udp: { send: async packet => sent.push(packet.readUInt16BE(2)) } },
  };
  const player = { voiceConnection: connection };
  const dispatcher = new VideoDispatcher(player, 12, {}, 30, 105);
  player.videoDispatcher = dispatcher;
  dispatcher.configureCongestion({ bitrate: 128 });
  dispatcher._codecCallback = function _codecCallback(chunk) {
    for (let index = 0; index < 3; index++) this._playChunk(chunk, index === 2);
  };
  const finished = once(dispatcher, 'finish');
  dispatcher.end(Buffer.alloc(1200));
  await Promise.race([finished, setTimeout(2000).then(() => assert.fail('Paced frame timed out'))]);
  assert.deepEqual(sent, [0, 1, 2]);
  assert.equal(connection._congestionControl, null);
  const other = new VideoDispatcher(player, 12, {}, 30, 105);
  player.videoDispatcher = other;
  other.configureCongestion({ bitrate: 128 });
  other._codecCallback = dispatcher._codecCallback;
  other.write(Buffer.alloc(1200));
  await setTimeout(10);
  other.destroy();
  const before = sent.length;
  await setTimeout(100);
  assert.equal(sent.length, before);
});

test('recording rejects unsupported codecs before allocating resources', () => {
  assert.throws(() => new Recorder(new EventEmitter(), { codec: 'AV1' }), RangeError);
});

test('group DM invite deletion resolves invite objects, URLs and codes', async () => {
  const codes = [];
  const target = {
    client: {
      api: {
        channels: () => ({
          invites: new Proxy(
            {},
            {
              get: (_, code) => ({ delete: async () => codes.push(code) }),
            },
          ),
        }),
      },
    },
    id: 'channel',
  };
  for (const invite of [{ code: 'abc' }, 'https://discord.gg/abc', 'abc']) {
    await api.GroupDMChannel.prototype.removeInvite.call(target, invite);
  }
  assert.deepEqual(codes, ['abc', 'abc', 'abc']);
});
