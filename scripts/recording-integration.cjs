'use strict';
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { once } = require('node:events');
const fs = require('node:fs');
const process = require('node:process');
const { PassThrough } = require('node:stream');
const { setTimeout, clearTimeout } = require('node:timers');
const { setup, wait, run, root } = require('./media-integration.cjs');

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function recording(writable) {
  const media = setup();
  const file = `${root}/recorded-${writable ? 'stream' : 'file'}.mkv`;
  const output = writable ? new PassThrough() : file;
  const chunks = [];
  if (writable) output.on('data', chunk => chunks.push(chunk));
  const finished = writable ? once(output, 'finish') : Promise.resolve();
  const recorder = media.handler.makeVideoStream(media.aliceId, output);
  const errors = [];
  recorder.on('error', error => errors.push(error));
  try {
    await bounded(once(recorder, 'ready'), 'Recorder readiness');
    await Promise.all([
      wait(media.player.playUnknown(`${root}/tone.wav`, { volume: false })),
      wait(media.player.playUnknownVideo(`${root}/video.mp4`, { fps: 10 })),
    ]);
    // Idle input must remain recordable; stopping must flush the final video frame.
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(recorder.closed, false);
    await bounded(recorder.stop(), 'Recorder finalization');
    await bounded(finished, 'Writable output finalization');
    assert.equal(errors.length, 0);
    assert.equal(recorder.exitCode, 0);
    assert.equal(media.handler.videoStreams.size, 0);
    assert.equal(fs.existsSync(recorder._sdpPath), false);
    if (writable) fs.writeFileSync(file, Buffer.concat(chunks));
    const video = run(['-i', file, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1']);
    const audio = run(['-i', file, '-map', '0:a:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1']);
    assert.equal(video.length, 160 * 120 * 1.5 * 10);
    assert.ok(audio.length >= 48000 * 2 * 2 * 0.9);
    assert.ok(audio.some(byte => byte !== 0));
    return {
      output: writable ? 'Writable' : 'file',
      frames: 10,
      audioBytes: audio.length,
      bytes: fs.statSync(file).size,
    };
  } finally {
    await bounded(
      recorder.stop().catch(() => {}),
      'Recorder cleanup',
    );
    media.destroy();
    if (writable) output.destroy();
  }
}

async function main() {
  const results = [await recording(false), await recording(true)];
  fs.writeFileSync('.tmp/recording-result.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ recording: results }));
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
