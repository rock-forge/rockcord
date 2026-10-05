'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { ffmpeg } = require('./media-runtime.cjs');

module.exports = () => {
  const root = '.tmp/media-samples';
  fs.mkdirSync(root, { recursive: true });
  const generate = args => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      windowsHide: true,
      timeout: 30000,
    });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.toString());
  };
  generate(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '48000', '-ac', '2', `${root}/tone.wav`]);
  for (const [duration, name] of [
    [1, 'video.mp4'],
    [3, 'video-long.mp4'],
  ]) {
    generate([
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=160x120:rate=10:duration=${duration}`,
      '-c:v',
      'libx264',
      '-g',
      '10',
      '-pix_fmt',
      'yuv420p',
      `${root}/${name}`,
    ]);
  }
};
