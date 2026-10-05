'use strict';

const { Buffer } = require('node:buffer');

const START = Buffer.from([0, 0, 0, 1]);
const MAX_FRAME = 32 * 1024 * 1024;

function lengthPrefixedToAnnexB(frame) {
  const nalus = [];
  let offset = 0;
  while (offset < frame.length) {
    if (offset + 4 > frame.length) throw new RangeError('Truncated NAL length');
    const size = frame.readUInt32BE(offset);
    offset += 4;
    if (!size || offset + size > frame.length) throw new RangeError('Invalid NAL length');
    nalus.push(START, frame.subarray(offset, offset + size));
    offset += size;
  }
  return Buffer.concat(nalus);
}

function annexBNalus(frame) {
  const starts = [];
  for (let i = 0; i + 3 < frame.length; i++) {
    if (frame[i] || frame[i + 1]) continue;
    const size = frame[i + 2] === 1 ? 3 : frame[i + 2] === 0 && frame[i + 3] === 1 ? 4 : 0;
    if (size) {
      starts.push({ offset: i, size });
      i += size - 1;
    }
  }
  if (!starts.length || starts[0].offset !== 0) throw new RangeError('Missing Annex B start code');
  return starts.map((start, i) => frame.subarray(start.offset + start.size, starts[i + 1]?.offset ?? frame.length));
}

function packetize(frame, codec, mtu = 1200, pictureId = 0) {
  if (!Number.isInteger(mtu) || mtu < 16) throw new RangeError('Invalid video MTU');
  const output = [];
  if (codec === 'VP8') {
    for (let offset = 0; offset < frame.length; offset += mtu - 4) {
      const descriptor = Buffer.from([offset ? 0x80 : 0x90, 0x80, 0x80 | ((pictureId >> 8) & 0x7f), pictureId & 0xff]);
      output.push(Buffer.concat([descriptor, frame.subarray(offset, offset + mtu - 4)]));
    }
    return output;
  }
  if (!['H264', 'H265'].includes(codec)) throw new RangeError(`Unsupported video codec: ${codec}`);
  for (const nalu of annexBNalus(frame)) {
    if (nalu.length <= mtu) {
      output.push(nalu);
      continue;
    }
    const headerSize = codec === 'H264' ? 1 : 2;
    const fuSize = headerSize + 1;
    const type = codec === 'H264' ? nalu[0] & 31 : (nalu[0] >> 1) & 63;
    for (let offset = headerSize; offset < nalu.length; offset += mtu - fuSize) {
      const end = Math.min(nalu.length, offset + mtu - fuSize);
      const flags = (offset === headerSize ? 0x80 : 0) | (end === nalu.length ? 0x40 : 0);
      const fu =
        codec === 'H264'
          ? Buffer.from([(nalu[0] & 0xe0) | 28, flags | type])
          : Buffer.from([(nalu[0] & 0x81) | (49 << 1), nalu[1], flags | type]);
      output.push(Buffer.concat([fu, nalu.subarray(offset, end)]));
    }
  }
  return output;
}

function depacketize(payloads, codec) {
  const parts = [];
  let fragment = false;
  for (const payload of payloads) {
    if (!payload.length) throw new RangeError('Empty video payload');
    if (codec === 'VP8') {
      if (!parts.length && !(payload[0] & 0x10)) throw new RangeError('Missing first VP8 partition');
      let offset = 1;
      if (payload[0] & 0x80) {
        const flags = payload[offset++];
        if (flags & 0x80) offset += payload[offset] & 0x80 ? 2 : 1;
        if (flags & 0x40) offset++;
        if (flags & 0x30) offset++;
      }
      if (offset >= payload.length) throw new RangeError('Truncated VP8 descriptor');
      parts.push(payload.subarray(offset));
      continue;
    }
    const h265 = codec === 'H265';
    const type = h265 ? (payload[0] >> 1) & 63 : payload[0] & 31;
    const fuType = h265 ? 49 : 28;
    const aggregateType = h265 ? 48 : 24;
    if (type === aggregateType) {
      if (fragment) throw new RangeError('Incomplete fragmented NAL');
      let offset = h265 ? 2 : 1;
      while (offset < payload.length) {
        if (offset + 2 > payload.length) throw new RangeError('Truncated aggregation packet');
        const size = payload.readUInt16BE(offset);
        offset += 2;
        if (!size || offset + size > payload.length) throw new RangeError('Invalid aggregation length');
        parts.push(START, payload.subarray(offset, offset + size));
        offset += size;
      }
    } else if (type === fuType) {
      const size = h265 ? 3 : 2;
      if (payload.length <= size) throw new RangeError('Truncated fragmentation unit');
      const flags = payload[size - 1];
      if (flags & 0x80) {
        if (fragment) throw new RangeError('Incomplete fragmented NAL');
        fragment = true;
        parts.push(
          START,
          h265
            ? Buffer.from([(payload[0] & 0x81) | ((flags & 63) << 1), payload[1]])
            : Buffer.from([(payload[0] & 0xe0) | (flags & 31)]),
        );
      } else if (!fragment) {
        throw new RangeError('Missing first fragmentation unit');
      }
      parts.push(payload.subarray(size));
      if (flags & 0x40) fragment = false;
    } else {
      if (fragment) throw new RangeError('Incomplete fragmented NAL');
      if (type >= aggregateType || (!h265 && type === 0)) throw new RangeError('Unsupported NAL packet');
      parts.push(START, payload);
    }
  }
  if (fragment) throw new RangeError('Incomplete fragmented NAL');
  return Buffer.concat(parts);
}

class VideoFrames {
  constructor() {
    this.frames = new Map();
    this.completed = new Map();
  }

  push(packet, codec, validate) {
    const { ssrc, timestamp, sequenceNumber: seq, marker } = packet.header;
    const now = Date.now();
    const key = `${ssrc}:${timestamp}:${codec}`;
    for (const [id, time] of this.completed) {
      if (now - time > 2000) this.completed.delete(id);
    }
    if (this.completed.has(key)) return null;
    for (const [id, frame] of this.frames) {
      if (now - frame.time > 2000) this.frames.delete(id);
    }
    let frame = this.frames.get(key);
    if (!frame || frame.timestamp !== timestamp || frame.codec !== codec) {
      if (this.frames.size >= 32) this.frames.delete(this.frames.keys().next().value);
      frame = { timestamp, codec, time: now, packets: new Map(), bytes: 0, first: seq, last: null };
      this.frames.set(key, frame);
    }
    if (frame.packets.has(seq)) return null;
    if (((frame.first - seq) & 65535) < 4096) frame.first = seq;
    frame.bytes += packet.payload.length;
    if (frame.bytes > MAX_FRAME || frame.packets.size >= 4096) {
      this.frames.delete(key);
      return null;
    }
    frame.packets.set(seq, packet.payload);
    if (marker) frame.last = seq;
    if (frame.last === null) return null;
    const count = ((frame.last - frame.first) & 65535) + 1;
    if (count > 4096 || count !== frame.packets.size) return null;
    const payloads = [];
    for (let i = 0; i < count; i++) {
      const payload = frame.packets.get((frame.first + i) & 65535);
      if (!payload) return null;
      payloads.push(payload);
    }
    try {
      const complete = depacketize(payloads, codec);
      // A marker and contiguous tail do not prove the beginning arrived. DAVE
      // authentication must succeed before suppressing subsequent RTX fragments.
      if (validate && !validate(complete)) return null;
      this.frames.delete(key);
      if (this.completed.size >= 128) this.completed.delete(this.completed.keys().next().value);
      this.completed.set(key, now);
      return complete;
    } catch {
      // The marker can arrive before the first fragment. Retain bounded state for late packets.
      return null;
    }
  }
}

module.exports = { VideoFrames, packetize, depacketize, lengthPrefixedToAnnexB, annexBNalus };
