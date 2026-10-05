'use strict';
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const process = require('node:process');
const { setTimeout, clearTimeout } = require('node:timers');
const prism = require('prism-media');
const { ffmpeg } = require('./media-runtime.cjs');
require('../src');
const MediaPlayer = require('../src/client/voice/player/MediaPlayer');
const PacketHandler = require('../src/client/voice/receiver/PacketHandler');
const { group } = require('../test/dave-helpers.cjs');
const root = '.tmp/media-samples';
fs.mkdirSync(root, { recursive: true });
function run(args) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr.toString());
  return r.stdout;
}
run(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '2', `${root}/tone.wav`]);
run([
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=160x120:rate=10:duration=1',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  `${root}/video.mp4`,
]);
function setup(codec = 'H264') {
  const { alice, bob, aliceId } = group();
  const authentication = { secret_key: Buffer.alloc(32, 8), mode: 'aead_aes256_gcm_rtpsize', ssrc: 42 };
  const receiver = new EventEmitter();
  receiver.connection = {
    authentication,
    dave: bob,
    onSpeaking: () => {},
    ssrcMap: new Map([
      [42, { userId: aliceId, speaking: 1 }],
      [43, { userId: aliceId, kind: 'video', hasVideo: true }],
    ]),
  };
  const handler = new PacketHandler(receiver);
  let packets = 0;
  const connection = {
    authentication,
    dave: alice,
    videoCodec: codec,
    setSpeaking: () => {},
    setVideoStatus: () => {},
    sockets: {
      udp: {
        send: async packet => {
          packets++;
          handler.push(packet);
        },
      },
    },
  };
  const player = new MediaPlayer(connection, false);
  return {
    alice,
    bob,
    aliceId,
    receiver,
    handler,
    player,
    packets: () => packets,
    destroy: () => {
      player.destroy();
      handler.destroyAllStream();
      alice.destroy();
      bob.destroy();
    },
  };
}
async function wait(dispatcher) {
  let timer;
  try {
    await Promise.race([
      once(dispatcher, 'finish'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Media playback timeout')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const results = [];
  const audio = setup();
  const decoder = new prism.opus.Decoder({ channels: 2, rate: 48000, frameSize: 960 });
  const chunks = [];
  decoder.on('data', bytes => chunks.push(bytes));
  audio.handler.makeStream(audio.aliceId, 'manual').pipe(decoder);
  try {
    await wait(audio.player.playUnknown(`${root}/tone.wav`, { volume: false }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const decoded = Buffer.concat(chunks);
    assert.ok(decoded.length >= 48000 * 2 * 2 * 0.9);
    assert.ok(decoded.some(byte => byte !== 0));
    results.push({ kind: 'audio', sentPackets: audio.packets(), pcmBytes: decoded.length });
  } finally {
    audio.destroy();
    decoder.destroy();
  }
  for (const codec of ['H264', 'VP8', 'H265']) {
    const video = setup(codec);
    const frames = [];
    video.receiver.on('videoFrame', (_, frame) => frames.push(frame));
    try {
      let dispatched = 0;
      video.player.on('debug', message => {
        if (message.includes('frame=')) console.log(message);
      });
      const dispatcher = video.player.playUnknownVideo(`${root}/video.mp4`, { fps: 10 });
      const callback = dispatcher._codecCallback.bind(dispatcher);
      dispatcher._codecCallback = frame => {
        dispatched++;
        callback(frame);
      };
      await wait(dispatcher);
      console.log({ codec, dispatched, received: frames.length, packets: video.packets() });
      assert.equal(frames.length, 10, `${codec} receive count`);
      let encoded;
      let format;
      if (codec === 'H264' || codec === 'H265') {
        encoded = Buffer.concat(frames);
        format = codec === 'H264' ? 'h264' : 'hevc';
      } else {
        const header = Buffer.alloc(32);
        header.write('DKIF');
        header.writeUInt16LE(32, 6);
        header.write('VP80', 8);
        header.writeUInt16LE(160, 12);
        header.writeUInt16LE(120, 14);
        header.writeUInt32LE(10, 16);
        header.writeUInt32LE(1, 20);
        header.writeUInt32LE(frames.length, 24);
        encoded = Buffer.concat([
          header,
          ...frames.flatMap((frame, i) => {
            const h = Buffer.alloc(12);
            h.writeUInt32LE(frame.length);
            h.writeBigUInt64LE(BigInt(i), 4);
            return [h, frame];
          }),
        ]);
        format = 'ivf';
      }
      const output = `${root}/received-${codec}.${format}`;
      fs.writeFileSync(output, encoded);
      const decoded = run(['-f', format, '-i', output, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']);
      assert.equal(decoded.length, 160 * 120 * 1.5 * 10, `${codec} decoded frames`);
      results.push({
        kind: codec,
        receivedFrames: frames.length,
        sentPackets: video.packets(),
        decodedBytes: decoded.length,
      });
    } finally {
      video.destroy();
    }
  }
  fs.writeFileSync('.tmp/media-local-result.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ ffmpeg: run(['-version']).toString().split('\n')[0], results }));
}
module.exports = { setup, wait, run, root };
if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
