'use strict';

const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { createSocket } = require('node:dgram');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
require('../src');
const { LimitedCollection, UserFlags, Permissions, Util, Constants } = require('../src');
const VoiceConnection = require('../src/client/voice/VoiceConnection');
const AudioDispatcher = require('../src/client/voice/dispatcher/AudioDispatcher');
const BaseDispatcher = require('../src/client/voice/dispatcher/BaseDispatcher');
const VideoDispatcher = require('../src/client/voice/dispatcher/VideoDispatcher');
const VoiceUDPClient = require('../src/client/voice/networking/VoiceUDPClient');
const MediaPlayer = require('../src/client/voice/player/MediaPlayer');
const { H264NalSplitter, H265NalSplitter } = require('../src/client/voice/player/processing/AnnexBNalSplitter');
const PacketHandler = require('../src/client/voice/receiver/PacketHandler');
const VoiceReceiver = require('../src/client/voice/receiver/Receiver');

test('finishing audio leaves concurrent video active and finishing video leaves audio speaking', () => {
  for (const kind of ['audio', 'video']) {
    const states = [];
    const voiceConnection = connection();
    voiceConnection.setSpeaking = value => states.push(['audio', value]);
    voiceConnection.setVideoStatus = value => states.push(['video', value]);
    const dispatcher = new BaseDispatcher({ voiceConnection }, 12, 120, false);
    dispatcher.getTypeDispatcher = () => kind;
    dispatcher.emit('finish');
    assert.deepEqual(states, [[kind, kind === 'audio' ? 0 : false]]);
  }
});

test('video FPS validation rejects invalid values before spawning FFmpeg', () => {
  const player = new MediaPlayer(connection());
  for (const fps of [0, -1, NaN, Infinity, '30']) {
    assert.throws(() => player.playUnknownVideo('unused.mp4', { fps }), /positive finite/);
    assert.throws(() => new VideoDispatcher(player, 12, {}, fps, 105), /positive finite/);
  }
  const dispatcher = new VideoDispatcher(player, 12, {}, 29.97, 105);
  assert.equal(dispatcher.fps, 29.97);
  dispatcher.destroy();
});

test('screen-share startup rejects server deletion before authentication and clears its timer', async () => {
  const client = new EventEmitter();
  client.user = { id: 'u' };
  client.ws = {
    broadcast: packet => {
      if (packet.op === Constants.Opcodes.STREAM_CREATE) {
        queueMicrotask(() => client.emit('raw', { t: 'STREAM_DELETE', d: { stream_key: 'guild:g:c:u' } }));
      }
    },
  };
  const parent = new VoiceConnection({ client }, { id: 'c', type: 'GUILD_VOICE', guild: { id: 'g' }, client });
  const pending = parent.createStreamConnection();
  assert.equal(parent.createStreamConnection(), pending);
  const stream = parent.streamConnection;
  await assert.rejects(pending);
  assert.equal(parent.streamConnection, null);
  assert.equal(stream.connectTimeout._destroyed, true);
  parent._disconnect();
  assert.equal(client.listenerCount('raw'), 0);
});

function connection() {
  return {
    authentication: { secret_key: Buffer.alloc(32, 7), mode: 'aead_aes256_gcm_rtpsize', ssrc: 123 },
    ssrcMap: new Map([[123, { userId: 'u' }]]),
  };
}

test('screen-share waits for camera-off acknowledgement before sending STREAM_CREATE', async () => {
  const client = new EventEmitter();
  client.user = { id: 'u' };
  const sent = [];
  client.ws = { broadcast: packet => sent.push(packet) };
  const parent = new VoiceConnection({ client }, { id: 'c', type: 'GUILD_VOICE', guild: { id: 'g' }, client });
  parent.sendVoiceStateUpdate({ self_video: false });
  const pending = parent.createStreamConnection();
  const rejected = assert.rejects(pending);
  assert.deepEqual(
    sent.map(packet => packet.op),
    [Constants.Opcodes.VOICE_STATE_UPDATE],
  );
  client.emit('raw', {
    t: 'VOICE_STATE_UPDATE',
    d: { user_id: 'u', channel_id: 'c', self_mute: false, self_deaf: false, self_video: true },
  });
  await Promise.resolve();
  assert.equal(sent.length, 1);
  client.emit('raw', {
    t: 'VOICE_STATE_UPDATE',
    d: { user_id: 'u', channel_id: 'c', self_mute: false, self_deaf: false, self_video: false },
  });
  await Promise.resolve();
  assert.equal(sent[1].op, Constants.Opcodes.STREAM_CREATE);
  parent._disconnect();
  await rejected;
  assert.equal(client.listenerCount('raw'), 0);
});

test('stream server identity is assigned before authentication for either event order', async () => {
  for (const endpointFirst of [false, true]) {
    const client = new EventEmitter();
    client.user = { id: 'u' };
    client.ws = { broadcast: () => {} };
    const parent = new VoiceConnection({ client }, { id: 'c', type: 'GUILD_VOICE', guild: { id: 'g' }, client });
    parent.authentication.sessionId = 'session';
    const pending = parent.createStreamConnection();
    const rejected = assert.rejects(pending);
    const stream = parent.streamConnection;
    let connected = false;
    stream.connect = () => {
      assert.equal(stream.serverId, '12345');
      connected = true;
    };
    const create = { t: 'STREAM_CREATE', d: { stream_key: 'guild:g:c:u', rtc_server_id: '12345' } };
    const endpoint = {
      t: 'STREAM_SERVER_UPDATE',
      d: { stream_key: 'guild:g:c:u', token: 'test-token', endpoint: 'voice.example' },
    };
    for (const packet of endpointFirst ? [endpoint, create] : [create, endpoint]) client.emit('raw', packet);
    assert.equal(connected, true);
    parent._disconnect();
    await rejected;
  }
});

test('video frame listeners subscribe known SSRCs and unsubscribe when removed', () => {
  const sent = [];
  const voiceConnection = {
    ssrcMap: new Map([[43, { userId: 'u', kind: 'video' }]]),
    sockets: { ws: { sendPacket: async packet => sent.push(packet) } },
  };
  const receiver = new VoiceReceiver(voiceConnection);
  const listener = () => {};
  receiver.on('videoFrame', listener);
  assert.deepEqual(sent[0], { op: Constants.VoiceOpcodes.MEDIA_SINK_WANTS, d: { any: 100, 43: 100 } });
  receiver.removeListener('videoFrame', listener);
  assert.deepEqual(sent.at(-1).d, { any: 100, 43: 0 });
});

test('repeated video announcements retain in-flight frame state; replaced sources are removed', () => {
  const forgotten = [];
  const connection = {
    ssrcMap: new Map(),
    receiver: { packets: { forgetSource: ssrc => forgotten.push(ssrc) }, _updateVideoSubscriptions: () => {} },
  };
  const announce = data => VoiceConnection.prototype.onStartStreaming.call(connection, data);
  const source = { user_id: 'u', audio_ssrc: 10, video_ssrc: 11, rtx_ssrc: 12 };
  announce(source);
  announce(source);
  assert.deepEqual(forgotten, []);
  announce({ ...source, video_ssrc: 13, rtx_ssrc: 14 });
  assert.deepEqual(forgotten, [11, 12]);
  assert.equal(connection.ssrcMap.has(11), false);
  assert.equal(connection.ssrcMap.get(14).primarySsrc, 13);
});

test('failed gateway voice-state sends cancel acknowledgement listeners immediately', async () => {
  for (const synchronous of [false, true]) {
    const client = new EventEmitter();
    client.user = { id: 'u' };
    client.ws = {
      broadcast: () => {
        if (synchronous) throw new Error('send failed');
        return Promise.reject(new Error('send failed'));
      },
    };
    const parent = new VoiceConnection({ client }, { id: 'c', type: 'GUILD_VOICE', guild: { id: 'g' }, client });
    if (synchronous) assert.throws(() => parent.sendVoiceStateUpdate(), /send failed/);
    else await assert.rejects(parent.sendVoiceStateUpdate(), /send failed/);
    assert.equal(client.listenerCount('raw'), 0);
    assert.equal(parent._pendingVoiceState, null);
    parent._disconnect();
  }
});

test('UDP discovery advertises the requested codec without changing shared codec defaults', async () => {
  const defaults = JSON.stringify(Util.getAllPayloadType());
  for (const codec of ['H264', 'VP8', 'H265']) {
    const server = createSocket('udp4');
    server.bind(0, '127.0.0.1');
    await once(server, 'listening');
    const connection = new EventEmitter();
    connection.authentication = { port: server.address().port, ssrc: 123, mode: 'aead_aes256_gcm_rtpsize' };
    connection.videoCodec = codec;
    connection.receiver = { packets: { push: () => {} } };
    const sent = new EventEmitter();
    connection.sockets = { ws: { sendPacket: async packet => sent.emit('packet', packet) } };
    const udp = new VoiceUDPClient(connection);
    server.once('message', (_, remote) => {
      const response = Buffer.alloc(74);
      response.writeUInt16BE(2);
      response.write('127.0.0.1', 8);
      response.writeUInt16BE(remote.port, 72);
      server.send(response, remote.port, remote.address);
    });
    try {
      const received = once(sent, 'packet');
      await udp.createUDPSocket('127.0.0.1');
      const [packet] = await received;
      const video = packet.d.codecs.filter(value => value.type === 'video');
      assert.equal(video.find(value => value.name === codec).priority, 1);
      assert.deepEqual(
        video.filter(value => value.encode).map(value => value.name),
        [codec],
      );
      assert.equal(JSON.stringify(Util.getAllPayloadType()), defaults);
    } finally {
      udp.shutdown();
      server.close();
    }
  }
});

test('playback restarts and audio/video share a nonce counter; packet buffers stay stable', () => {
  const voiceConnection = connection();
  const a = new BaseDispatcher({ voiceConnection }, 12, 120, false);
  const b = new BaseDispatcher({ voiceConnection }, 12, 101, true);
  const first = a._encrypt(Buffer.from('AAAAAAAA'), Buffer.from('header'))[1];
  const saved = Buffer.from(first);
  const second = b._encrypt(Buffer.from('BBBBBBBB'), Buffer.from('header'))[1];
  const third = a._encrypt(Buffer.from('CCCCCCCC'), Buffer.from('header'))[1];
  assert.deepEqual([first.readUInt32BE(), second.readUInt32BE(), third.readUInt32BE()], [1, 2, 3]);
  assert.deepEqual(first, saved);
  assert.equal(a.createPayloadExtension().toString('hex'), '62000000b231303051000000');
  assert.equal(a.createHeaderExtension().readUInt16BE(2), 3);
});

test('malformed and unauthenticated UDP is dropped; valid packets still decode', () => {
  const receiver = new EventEmitter();
  receiver.connection = connection();
  receiver.connection.onSpeaking = () => {};
  const packets = new PacketHandler(receiver);
  assert.doesNotThrow(() => packets.push(Buffer.alloc(1)));
  const invalid = Buffer.alloc(32);
  invalid[0] = 0x80;
  invalid.writeUInt32BE(123, 8);
  assert.doesNotThrow(() => packets.push(invalid));
  const dispatcher = new BaseDispatcher({ voiceConnection: receiver.connection }, 12, 120, false);
  const payload = Buffer.from([1, 2, 3]);
  let received;
  receiver.on('receiverData', (_, packet) => {
    received = packet.payload;
  });
  packets.push(dispatcher._createPacket(payload, false));
  assert.deepEqual(received, payload);
  packets.destroyAllStream();
  assert.equal(packets.speakingTimeouts.size, 0);
});

test('audio playback restarts continue RTP sequence and timestamp within the same transport session', () => {
  const voiceConnection = connection();
  const first = new AudioDispatcher({ voiceConnection });
  first.sequence = 65535;
  first.timestamp = 9000;
  first.startTime = performance.now();
  const sent = first._createPacket(Buffer.from([1]), false);
  assert.equal(sent.readUInt16BE(2), 65535);
  first._step(() => {});
  first.destroy();
  const next = new AudioDispatcher({ voiceConnection });
  const resumed = next._createPacket(Buffer.from([2]), false);
  assert.equal(resumed.readUInt16BE(2), 0);
  assert.equal(resumed.readUInt32BE(4), 9960);
  next.destroy();
});

test('fresh UDP discovery after reconnect closes the previous real socket', async () => {
  const server = createSocket('udp4');
  server.bind(0, '127.0.0.1');
  await once(server, 'listening');
  const connection = new EventEmitter();
  connection.authentication = { port: server.address().port, ssrc: 123 };
  connection.sockets = { ws: {} };
  const udp = new VoiceUDPClient(connection);
  try {
    await udp.createUDPSocket('127.0.0.1');
    const previous = udp.socket;
    const closed = once(previous, 'close');
    await udp.createUDPSocket('127.0.0.1');
    await closed;
    assert.notEqual(udp.socket, previous);
    assert.throws(() => previous.address(), /not running/i);
  } finally {
    udp.shutdown();
    server.close();
  }
});

test('destroyed manual receive streams can be recreated', async () => {
  const receiver = new EventEmitter();
  receiver.connection = connection();
  const packets = new PacketHandler(receiver);
  const old = packets.makeStream('u', 'manual');
  const closed = once(old, 'close');
  old.destroy();
  await closed;
  assert.notEqual(packets.makeStream('u', 'manual'), old);
  packets.destroyAllStream();
});

async function split(Type, chunks) {
  const splitter = new Type();
  const output = [];
  splitter.on('data', data => output.push(data));
  const ended = once(splitter, 'end');
  for (const chunk of chunks) splitter.write(chunk);
  splitter.end();
  await ended;
  return output;
}

test('Annex B preserves split start codes and flushes the final access unit for H264/H265', async () => {
  for (const [Type, aud, slice] of [
    [H264NalSplitter, [9, 0xf0], [0x65, 0x11]],
    [H265NalSplitter, [70, 1], [38, 1, 0x11]],
  ]) {
    const input = Buffer.from([0, 0, 0, 1, ...aud, 0, 0, 1, ...slice]);
    const whole = await split(Type, [input]);
    assert.equal(whole.length, 1);
    assert.equal(whole[0].readUInt32BE(), slice.length);
    for (let boundary = 1; boundary < input.length; boundary++) {
      assert.deepEqual(await split(Type, [input.subarray(0, boundary), input.subarray(boundary)]), whole);
    }
  }
});

test('H264 preserves emulation-prevention bytes in SPS and SEI NALs', async () => {
  for (const nal of [Buffer.from([0x67, 0x42, 0, 0, 3, 1, 0x47]), Buffer.from([0x06, 0, 0, 3, 2, 0x80])]) {
    const output = await split(H264NalSplitter, [Buffer.concat([Buffer.from([0, 0, 0, 1]), nal])]);
    assert.equal(output.length, 1);
    assert.equal(output[0].readUInt32BE(), nal.length);
    assert.deepEqual(output[0].subarray(4), nal);
  }
});

test('high user flags preserve the numeric API and BigInt permissions remain supported', () => {
  const high = UserFlags.FLAGS.VERIFIED_EMAIL;
  const flags = new UserFlags([high, 'DISCORD_EMPLOYEE']);
  assert.equal(typeof flags.bitfield, 'number');
  assert.equal(flags.has('VERIFIED_EMAIL'), true);
  assert.equal(flags.any('VERIFIED_EMAIL'), true);
  assert.equal(flags.remove('DISCORD_EMPLOYEE').bitfield, high);
  assert.equal(flags.freeze().add('DISCORD_EMPLOYEE').has('VERIFIED_EMAIL'), true);
  assert.throws(() => new UserFlags(Infinity));
  assert.throws(() => new UserFlags(1.5));
  assert.equal(new Permissions().add('VIEW_CHANNEL').has('VIEW_CHANNEL'), true);
});

test('initial cache entries obey maxSize, including disabled caches', () => {
  assert.deepEqual(
    [
      ...new LimitedCollection({ maxSize: 1 }, [
        ['a', 1],
        ['b', 2],
      ]),
    ],
    [['b', 2]],
  );
  assert.equal(new LimitedCollection({ maxSize: 0 }, [['a', 1]]).size, 0);
});

test('deferred interaction success settles immediately and releases all listeners', async () => {
  const client = new EventEmitter();
  client.incrementMaxListeners = () => client.setMaxListeners(client.getMaxListeners() + 1);
  client.decrementMaxListeners = () => client.setMaxListeners(client.getMaxListeners() - 1);
  const before = client.getMaxListeners();
  const parent = {};
  const promise = Util.createPromiseInteraction(client, '123', 5000, true, parent);
  client.emit(Constants.Events.UNHANDLED_PACKET, { t: 'INTERACTION_SUCCESS', d: { nonce: '123' } });
  assert.equal(await promise, parent);
  assert.equal(client.getMaxListeners(), before);
  assert.equal(client.eventNames().length, 0);
});
