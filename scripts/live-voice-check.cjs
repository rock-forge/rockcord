'use strict';
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const process = require('node:process');
const { setTimeout, clearTimeout } = require('node:timers');
const prism = require('prism-media');
const { encodedVideo } = require('./media-frames.cjs');
const { ffmpeg } = require('./media-runtime.cjs');
const { Client } = require('../src');
const channelId = process.env.DISCORD_TEST_CHANNEL;
if (!channelId || !process.env.DISCORD_TEST_TOKEN_A || !process.env.DISCORD_TEST_TOKEN_B) {
  throw new Error('Set DISCORD_TEST_CHANNEL and both DISCORD_TEST_TOKEN_A/B locally before running live checks');
}
require('./media-fixtures.cjs')();
const clients = [];
const tokens = ['A', 'B'].map(label => process.env[`DISCORD_TEST_TOKEN_${label}`]);
const results = [];
const videoDuration = Number(process.env.TEST_VIDEO_SECONDS || 3);
if (!Number.isFinite(videoDuration) || videoDuration < 1 || videoDuration > 600) {
  throw new RangeError('TEST_VIDEO_SECONDS must be between 1 and 600');
}
const loss = process.env.TEST_PACKET_LOSS;
if (loss && !['incoming', 'outgoing'].includes(loss)) throw new RangeError('Invalid TEST_PACKET_LOSS direction');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function safe(error) {
  let text = String(error?.message || error);
  for (const token of tokens) if (token) text = text.split(token).join('[REDACTED]');
  return text.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED]').slice(0, 300);
}
async function bound(promise, name, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function report(value) {
  results.push(value);
  console.log(JSON.stringify(value));
}
function watch(connection, label) {
  connection.on('error', error => report({ account: label, voiceError: safe(error) }));
  connection.on('debug', message => {
    if (/\[WS\] << opcode|\[WS\] closed with code/.test(message)) {
      console.log(JSON.stringify({ account: label, voice: safe(message) }));
    }
  });
}
async function join(client, label) {
  const channel = await client.channels.fetch(channelId);
  const pending = client.voice.joinChannel(channel, {
    selfMute: false,
    selfDeaf: false,
    selfVideo: false,
    videoCodec: process.env.VIDEO_CODEC || 'H264',
  });
  watch(client.voice.connection, label);
  return bound(pending, `${label} join`);
}
async function groupReady() {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const sessions = clients.map(client => client.voice.connection?.dave);
    if (
      sessions.every(dave => dave?.version === 1 && dave.session?.ready && !dave.blocked) &&
      sessions[0].voicePrivacyCode === sessions[1].voicePrivacyCode
    ) {
      return;
    }
    await delay(200);
  }
  throw new Error('DAVE group did not become ready with matching privacy codes');
}
async function audio(sender, recipient, stage) {
  const connection = sender.voice.connection;
  const receive = recipient.voice.connection.receiver.createStream(sender.user.id, { end: 'manual', mode: 'opus' });
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  let packets = 0,
    bytes = 0,
    nonzero = false;
  receive.on('data', () => packets++);
  decoder.on('data', pcm => {
    bytes += pcm.length;
    nonzero ||= pcm.some(value => value !== 0);
  });
  receive.pipe(decoder);
  try {
    await bound(once(connection.playAudio('.tmp/media-samples/tone.wav', { volume: false }), 'finish'), stage, 10000);
    await delay(500);
    report({ stage, packetsReceived: packets, decodedPcmBytes: bytes, nonzero, pass: packets >= 25 && nonzero });
    if (packets < 25 || !nonzero) throw new Error(`${stage} insufficient decoded audio`);
  } finally {
    receive.destroy();
    decoder.destroy();
  }
}
async function video(sender, recipient) {
  const codec = sender.voice.connection.videoCodec;
  const frames = [];
  const receive = recipient.voice.connection.receiver;
  const listener = (user, frame, receivedCodec) => {
    if (user.userId === sender.user.id && receivedCodec === codec) frames.push(frame);
  };
  receive.on('videoFrame', listener);
  const datagrams = {};
  const count = packet => {
    const type = packet[1] & 127;
    datagrams[type] = (datagrams[type] || 0) + 1;
  };
  recipient.voice.connection.sockets.udp.socket.on('message', count);
  let videoDecrypts = 0,
    failedDecrypts = 0;
  const dave = recipient.voice.connection.dave;
  const decrypt = dave.decrypt.bind(dave);
  dave.decrypt = (frame, user, video) => {
    const plain = decrypt(frame, user, video);
    if (video) {
      videoDecrypts++;
      if (!plain) failedDecrypts++;
    }
    return plain;
  };
  const ws = recipient.voice.connection.sockets.ws;
  const send = ws.sendPacket.bind(ws);
  ws.sendPacket = packet => {
    if (packet.op === 15) console.log(JSON.stringify({ wants: packet.d }));
    return send(packet);
  };
  const senderWs = sender.voice.connection.sockets.ws;
  const senderSend = senderWs.sendPacket.bind(senderWs);
  senderWs.sendPacket = packet => senderSend(packet);
  const senderOnPacket = senderWs.onPacket.bind(senderWs);
  senderWs.onPacket = packet => {
    if (packet.op === 15) console.log(JSON.stringify({ senderWants: packet.d }));
    return senderOnPacket(packet);
  };
  let videoSent = 0,
    incoming = 0,
    dropped = 0,
    recorder;
  const payloadType = codec === 'VP8' ? 107 : codec === 'H265' ? 103 : 105;
  const packets = receive.packets;
  const push = packets.push.bind(packets);
  packets.push = packet => {
    if (loss === 'incoming' && (packet[1] & 127) === payloadType && ++incoming % 20 === 5) {
      dropped++;
      return undefined;
    }
    return push(packet);
  };
  const udp = sender.voice.connection.sockets.udp;
  const sendUdp = udp.send.bind(udp);
  udp.send = packet => {
    if ((packet[1] & 127) === payloadType) {
      videoSent++;
      if (loss === 'outgoing' && videoSent % 20 === 5) {
        dropped++;
        return Promise.resolve(packet);
      }
    }
    return sendUdp(packet);
  };
  try {
    if (process.env.TEST_RECORDING === '1') {
      if (codec !== 'H264') throw new Error('Recorder supports H264 and Opus');
      recorder = receive.createVideoStream(sender.user.id, '.tmp/media-samples/live-recorded.mkv');
      recorder.on('debug', message => fs.appendFileSync('.tmp/live-recorder-debug.log', `${safe(message)}\n`));
      recorder.on('error', error => report({ stage: 'recorder error', failed: safe(error) }));
      await bound(once(recorder, 'ready'), 'live recorder ready', 10000);
    }
    sender.voice.connection.sendVoiceStateUpdate({ self_video: true });
    await delay(500);
    await groupReady();
    const concurrentAudio = recorder
      ? audio(sender, recipient, 'audio while recording video').catch(error => {
          report({
            stage: 'concurrent audio diagnostics',
            datagrams,
            sourceMap: [...recipient.voice.connection.ssrcMap],
            senderBlocked: sender.voice.connection.dave.blocked,
            receiverBlocked: dave.blocked,
            senderAudioCodec: sender.voice.connection.authentication.audio_codec,
            error: safe(error),
          });
        })
      : Promise.resolve();
    await bound(
      Promise.all([
        concurrentAudio,
        once(
          sender.voice.connection.playVideo('.tmp/media-samples/video-long.mp4', {
            fps: 10,
            inputFFmpegArgs: ['-stream_loop', '-1'],
            outputFFmpegArgs: ['-g', '10', '-t', String(videoDuration)],
          }),
          'finish',
        ),
      ]),
      `${codec} playback`,
      videoDuration * 1000 + 15000,
    );
    await delay(1000);
    report({
      stage: 'video diagnostics',
      videoSent,
      senderSsrc: sender.voice.connection.authentication.ssrc,
      datagrams,
      videoDecrypts,
      failedDecrypts,
      sourceMap: [...recipient.voice.connection.ssrcMap.values()].map(info => ({
        kind: info.kind,
        hasVideo: info.hasVideo,
      })),
      negotiatedCodec: sender.voice.connection.authentication.video_codec,
      streams: sender.voice.connection.authentication.streams,
      dropped,
      recovery: sender.voice.connection._mediaRecovery.stats,
      receiveRecovery: packets.recovery.stats,
    });
    const encoded = encodedVideo(frames, codec);
    const receivedFile = `.tmp/media-samples/live-received.${encoded.format}`;
    fs.writeFileSync(receivedFile, encoded.bytes);
    const decoded = spawnSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        encoded.format,
        '-i',
        receivedFile,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        'pipe:1',
      ],
      { windowsHide: true, timeout: 30000, maxBuffer: Math.ceil((videoDuration + 2) * 10 * 28800) },
    );
    const decodedFrames = (decoded.stdout?.length || 0) / 28800;
    const pass =
      decoded.status === 0 &&
      decodedFrames >= Math.floor(videoDuration * 10 * 0.8) &&
      sender.voice.connection.authentication.video_codec === codec;
    report({
      stage: `${codec} live video A to B`,
      framesReceived: frames.length,
      decodedBytes: decoded.stdout?.length || 0,
      pass,
    });
    if (!pass) report({ stage: `${codec} decode`, diagnostic: decoded.stderr?.toString().slice(0, 300) });
    if (recorder) {
      await bound(recorder.stop(), 'live recorder stop', 10000);
      const recording = spawnSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          '.tmp/media-samples/live-recorded.mkv',
          '-map',
          '0:v:0',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'yuv420p',
          'pipe:1',
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: Math.ceil((videoDuration + 2) * 10 * 28800) },
      );
      const recordedFrames = (recording.stdout?.length || 0) / 28800;
      report({
        stage: 'live H264 recording',
        recordedFrames,
        pass: recording.status === 0 && recordedFrames >= decodedFrames * 0.8,
      });
    }
  } finally {
    await recorder?.stop().catch(() => {});
    packets.push = push;
    receive.removeListener('videoFrame', listener);
    recipient.voice.connection.sockets.udp.socket.removeListener('message', count);
    dave.decrypt = decrypt;
    ws.sendPacket = send;
    senderWs.onPacket = senderOnPacket;
    senderWs.sendPacket = senderSend;
    udp.send = sendUdp;
    sender.voice.connection.sendVoiceStateUpdate({ self_video: false });
  }
}
async function screenshare() {
  let owner, viewer;
  const observer = packet => {
    if (packet.t?.startsWith('STREAM_')) {
      console.log(
        JSON.stringify({ streamEvent: packet.t, keys: Object.keys(packet.d || {}), reason: packet.d?.reason }),
      );
    }
  };
  clients[0].on('raw', observer);
  try {
    report({
      stage: 'screen-share permission',
      allowed: clients[0].voice.connection.channel.permissionsFor(clients[0].user)?.has('STREAM'),
    });
    const pending = clients[0].voice.connection.createStreamConnection();
    owner = clients[0].voice.connection.streamConnection;
    watch(owner, 'A screenshare');
    owner = await bound(pending, 'create screen share');
    await delay(1000);
    const watchPending = clients[1].voice.connection.joinStreamConnection(clients[0].user.id);
    viewer = clients[1].voice.connection.streamWatchConnection.get(clients[0].user.id);
    watch(viewer, 'B screenshare viewer');
    viewer = await bound(watchPending, 'watch screen share');
    const until = Date.now() + 20000;
    while (
      Date.now() < until &&
      (!owner.dave.session?.ready ||
        !viewer.dave.session?.ready ||
        owner.dave.blocked ||
        viewer.dave.blocked ||
        owner.dave.voicePrivacyCode !== viewer.dave.voicePrivacyCode)
    ) {
      await delay(200);
    }
    if (
      !owner.dave.session?.ready ||
      !viewer.dave.session?.ready ||
      owner.dave.voicePrivacyCode !== viewer.dave.voicePrivacyCode
    ) {
      throw new Error('Screen-share DAVE group not ready');
    }
    const frames = [];
    viewer.receiver.on('videoFrame', (user, frame) => {
      if (user.userId === clients[0].user.id) frames.push(frame);
    });
    await bound(
      once(owner.playVideo('.tmp/media-samples/video-long.mp4', { fps: 10, outputFFmpegArgs: ['-g', '1'] }), 'finish'),
      'screen-share playback',
      10000,
    );
    await delay(1000);
    const encoded = encodedVideo(frames, owner.videoCodec);
    const file = `.tmp/media-samples/live-screen.${encoded.format}`;
    fs.writeFileSync(file, encoded.bytes);
    const decoded = spawnSync(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        encoded.format,
        '-i',
        file,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        'pipe:1',
      ],
      { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );
    const pass = frames.length > 0 && decoded.status === 0 && decoded.stdout.length > 0;
    report({
      stage: 'separate screen-share connection',
      framesReceived: frames.length,
      decodedBytes: decoded.stdout?.length || 0,
      pass,
    });
  } finally {
    clients[0].removeListener('raw', observer);
    viewer?.disconnect();
    owner?.disconnect();
  }
}

async function main() {
  try {
    for (const [i, label] of ['A', 'B'].entries()) {
      const client = new Client({ checkUpdate: false });
      clients.push(client);
      client.on('error', error => report({ account: label, error: safe(error) }));
      await bound(client.login(tokens[i]), `${label} login`, 45000);
      await join(client, label);
    }
    await groupReady();
    report({ stage: 'initial DAVE group', pass: true });
    await audio(clients[0], clients[1], 'audio A to B');
    await audio(clients[1], clients[0], 'audio B to A');
    await video(clients[0], clients[1]);
    if (process.env.TEST_SCREENSHARE === '1') await screenshare();
    if (process.env.VIDEO_ONLY) return;
    clients[1].voice.connection.disconnect();
    await delay(1500);
    await join(clients[1], 'B rejoin');
    await groupReady();
    report({ stage: 'participant leave/rejoin DAVE transition', pass: true });
    await audio(clients[0], clients[1], 'audio A to B after rejoin');
    clients[1].voice.connection.sockets.ws.ws.close(4000);
    await delay(3000);
    await groupReady();
    report({ stage: 'voice websocket interruption/reconnect', pass: true });
    await audio(clients[1], clients[0], 'audio B to A after reconnect');
  } catch (error) {
    report({ failed: safe(error) });
    process.exitCode = 1;
  } finally {
    for (const client of clients) {
      try {
        client.voice.connection?.disconnect();
      } catch {
        /* Already disconnected. */
      }
    }
    await delay(300);
    for (const client of clients) client.destroy();
    if (results.some(result => result.pass === false || result.failed)) process.exitCode = 1;
    fs.writeFileSync('.tmp/live-media-result.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ cleanup: 'both clients destroyed' }));
    setTimeout(() => {
      console.log(
        JSON.stringify({
          resources: process.getActiveResourcesInfo(),
          handles: process._getActiveHandles().map(h => h.constructor.name),
        }),
      );
    }, 1500).unref();
  }
}
main().catch(error => {
  console.log(safe(error));
  process.exitCode = 1;
});
