'use strict';

const { Buffer } = require('node:buffer');
const { setTimeout } = require('node:timers');
const { RtpHeader, RtpPacket } = require('werift-rtp');
const { SILENCE_FRAME } = require('../util/Silence');

// Opus TOC frame durations from RFC 6716, section 3.1.
function duration(payload) {
  if (!payload.length) return 20;
  const config = payload[0] >> 3;
  const frame =
    config >= 16 ? 2.5 * 2 ** (config & 3) : config >= 12 ? 10 * 2 ** (config & 1) : [10, 20, 40, 60][config & 3];
  const code = payload[0] & 3;
  const frames = code === 0 ? 1 : code === 3 ? (payload[1] || 0) & 63 : 2;
  const milliseconds = frame * frames;
  return milliseconds > 0 && milliseconds <= 120 ? milliseconds : 20;
}

/** Forty-millisecond playout window with bounded reordering and loss padding. @private */
class AudioJitter {
  constructor(deliver) {
    this.deliver = deliver;
    this.packets = new Map();
    this.expected = null;
    this.lastArrival = -Infinity;
  }

  push(packet) {
    const now = performance.now();
    const seq = packet.header.sequenceNumber;
    if (packet.payload.length > 4096) return;
    if (
      this.expected === null ||
      now - this.lastArrival > 500 ||
      (((seq - this.expected) & 65535) > 1024 && ((seq - this.expected) & 65535) < 32768)
    ) {
      this.reset();
      this.expected = seq;
      this.next = now + 40;
    }
    const ahead = (seq - this.expected) & 65535;
    if (ahead >= 32768 || this.packets.has(seq)) return;
    if (this.packets.size >= 64) return;
    this.lastArrival = now;
    this.packets.set(seq, packet);
    this._schedule();
  }

  _schedule() {
    if (this.timer || !this.packets.size) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._play();
    }, Math.max(0, this.next - performance.now())).unref();
  }

  _play() {
    let packet = this.packets.get(this.expected);
    if (!packet) {
      const sequence = [...this.packets.keys()].sort(
        (a, b) => ((a - this.expected) & 65535) - ((b - this.expected) & 65535),
      )[0];
      if (sequence === undefined) return;
      const gap = (sequence - this.expected) & 65535;
      if (gap > 10 || !this.last) {
        this.expected = sequence;
        packet = this.packets.get(sequence);
      } else {
        packet = new RtpPacket(
          new RtpHeader({
            ...this.last.header,
            sequenceNumber: this.expected,
            timestamp: (this.last.header.timestamp + duration(this.last.payload) * 48) >>> 0,
          }),
          Buffer.from(SILENCE_FRAME),
        );
        packet.concealed = true;
      }
    }
    this.packets.delete(this.expected);
    this.expected = (this.expected + 1) & 65535;
    this.last = packet;
    this.next += duration(packet.payload);
    this.deliver(packet);
    this._schedule();
  }

  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    this.packets.clear();
    this.expected = null;
    this.last = null;
  }
}

module.exports = { AudioJitter, duration };
