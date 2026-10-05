'use strict';

const { Buffer } = require('node:buffer');
const { setInterval } = require('node:timers');
const Util = require('../../../util/Util');
const { encrypt, decrypt } = require('../util/TransportCrypto');

/** Bounded RFC 4585 NACK feedback and RFC 4588 video RTX handling. @private */
class MediaRecovery {
  constructor(connection) {
    this.connection = connection;
    this.cache = new Map();
    this.sources = new Map();
    this.rtxSequence = 0;
    this.stats = { requested: 0, retransmitted: 0, recovered: 0, expired: 0 };
  }

  remember(header, payload) {
    const type = Util.getAllPayloadType().find(
      codec => codec.rtx_payload_type && codec.payload_type === (header[1] & 127),
    );
    if (!type || payload.length > 4096) return;
    const key = Buffer.from(this.connection.authentication.secret_key);
    if (!this.key?.equals(key)) {
      this.reset();
      this.key = key;
    }
    const now = performance.now();
    for (const [id, item] of this.cache) if (now - item.time > 2000) this.cache.delete(id);
    if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value);
    const extension = header[0] & 0x10 ? header.readUInt16BE(header.length - 2) * 4 : 0;
    this.cache.set(`${header.readUInt32BE(8)}:${header.readUInt16BE(2)}`, {
      header: Buffer.from(header.subarray(0, 12)),
      payload: Buffer.from(payload.subarray(extension)),
      type: type.rtx_payload_type,
      time: now,
      retries: 0,
      last: -Infinity,
    });
  }

  receive(packet) {
    const { ssrc, sequenceNumber: seq } = packet.header;
    let source = this.sources.get(ssrc);
    if (!source) {
      if (this.sources.size >= 32) return;
      this.sources.set(ssrc, (source = { highest: seq, missing: new Map() }));
      return;
    }
    if (source.missing.delete(seq)) this.stats.recovered++;
    const distance = (seq - source.highest) & 65535;
    if (!distance || distance >= 32768) return;
    if (distance > 128) {
      this.stats.expired += source.missing.size;
      source.missing.clear();
    } else {
      const time = performance.now();
      for (let i = 1; i < distance; i++) {
        if (source.missing.size >= 128) break;
        source.missing.set((source.highest + i) & 65535, { time, last: -Infinity, retries: 0 });
      }
    }
    source.highest = seq;
    if (source.missing.size && !this.timer) this.timer = setInterval(() => this._tick(), 20).unref();
  }

  _tick() {
    const now = performance.now();
    let pending = false;
    for (const [ssrc, source] of this.sources) {
      const sequences = [];
      for (const [seq, item] of source.missing) {
        if (now - item.time >= 500) {
          source.missing.delete(seq);
          this.stats.expired++;
        } else if (now - item.time >= 20 && now - item.last >= 60 && item.retries < 3) {
          item.last = now;
          item.retries++;
          sequences.push(seq);
        }
      }
      if (sequences.length) this._nack(ssrc, sequences);
      pending ||= source.missing.size > 0;
    }
    if (!pending) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _nack(ssrc, sequences) {
    const entries = [];
    for (const seq of sequences) {
      const entry = entries.at(-1);
      const delta = entry ? (seq - entry.seq) & 65535 : 0;
      if (entry && delta > 0 && delta <= 16) entry.mask |= 1 << (delta - 1);
      else entries.push({ seq, mask: 0 });
    }
    const packet = Buffer.alloc(12 + entries.length * 4);
    packet[0] = 0x81;
    packet[1] = 205;
    packet.writeUInt16BE(packet.length / 4 - 1, 2);
    packet.writeUInt32BE(this.connection.authentication.ssrc, 4);
    packet.writeUInt32BE(ssrc, 8);
    entries.forEach((entry, index) => {
      packet.writeUInt16BE(entry.seq, 12 + index * 4);
      packet.writeUInt16BE(entry.mask, 14 + index * 4);
    });
    this.stats.requested += sequences.length;
    try {
      const header = packet.subarray(0, 8);
      this._send(Buffer.concat([header, ...encrypt(this.connection, packet.subarray(8), header)]));
    } catch (error) {
      this.connection.receiver?.emit('debug', error);
    }
  }

  handle(buffer) {
    let packet;
    try {
      packet = decrypt(this.connection, buffer, 8);
    } catch {
      return;
    }
    const messages = [];
    let offset = 0;
    while (offset + 8 <= packet.length) {
      const size = (packet.readUInt16BE(offset + 2) + 1) * 4;
      if (packet[offset] >> 6 !== 2 || size < 8 || offset + size > packet.length) return;
      if (packet[offset + 1] === 205 && (packet[offset] & 31) === 1 && size >= 16 && size % 4 === 0) {
        messages.push(packet.subarray(offset, offset + size));
      }
      offset += size;
    }
    if (offset !== packet.length) return;
    for (const message of messages) this._handleNack(message);
  }

  _handleNack(packet) {
    const now = performance.now();
    const ssrc = packet.readUInt32BE(8);
    for (let offset = 12; offset < packet.length; offset += 4) {
      const seq = packet.readUInt16BE(offset),
        mask = packet.readUInt16BE(offset + 2);
      this._retransmit(ssrc, seq, now);
      for (let bit = 0; bit < 16; bit++) {
        if (mask & (1 << bit)) this._retransmit(ssrc, (seq + bit + 1) & 65535, now);
      }
    }
  }

  _retransmit(ssrc, sequence, now) {
    const item = this.cache.get(`${ssrc}:${sequence}`);
    const auth = this.connection.authentication;
    if (
      !item ||
      !this.key?.equals(Buffer.from(auth.secret_key)) ||
      now - item.time > 2000 ||
      item.retries >= 3 ||
      now - item.last < 20
    ) {
      return;
    }
    const stream = auth.streams?.find(value => value.ssrc === ssrc);
    const rtx = stream?.rtx_ssrc ?? (ssrc === auth.ssrc + 1 ? auth.ssrc + 2 : null);
    if (!rtx) return;
    item.retries++;
    item.last = now;
    const header = Buffer.from(item.header);
    header[0] = 0x80;
    header[1] = (header[1] & 0x80) | item.type;
    header.writeUInt16BE(this.rtxSequence++ & 65535, 2);
    header.writeUInt32BE(rtx, 8);
    const original = Buffer.alloc(2);
    original.writeUInt16BE(sequence);
    try {
      this._send(Buffer.concat([header, ...encrypt(this.connection, Buffer.concat([original, item.payload]), header)]));
      this.stats.retransmitted++;
    } catch (error) {
      this.connection.receiver?.emit('debug', error);
    }
  }

  _send(packet) {
    this.connection.sockets?.udp?.send(packet).catch(error => this.connection.receiver?.emit('debug', error));
  }

  reset() {
    clearInterval(this.timer);
    this.timer = null;
    this.cache.clear();
    this.sources.clear();
    this.rtxSequence = 0;
  }
}

module.exports = MediaRecovery;
