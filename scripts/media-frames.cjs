'use strict';
const { Buffer } = require('node:buffer');

function encodedVideo(frames, codec, { width = 160, height = 120, fps = 10 } = {}) {
  if (codec === 'H264' || codec === 'H265') {
    return { format: codec === 'H264' ? 'h264' : 'hevc', bytes: Buffer.concat(frames) };
  }
  if (codec !== 'VP8') throw new RangeError(`Unsupported frame codec: ${codec}`);
  const header = Buffer.alloc(32);
  header.write('DKIF');
  header.writeUInt16LE(32, 6);
  header.write('VP80', 8);
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header.writeUInt32LE(fps, 16);
  header.writeUInt32LE(1, 20);
  header.writeUInt32LE(frames.length, 24);
  return {
    format: 'ivf',
    bytes: Buffer.concat([
      header,
      ...frames.flatMap((frame, index) => {
        const descriptor = Buffer.alloc(12);
        descriptor.writeUInt32LE(frame.length);
        descriptor.writeBigUInt64LE(BigInt(index), 4);
        return [descriptor, frame];
      }),
    ]),
  };
}

module.exports = { encodedVideo };
