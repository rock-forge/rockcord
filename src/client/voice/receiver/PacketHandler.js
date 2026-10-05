'use strict';

const EventEmitter = require('events');
const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const { setTimeout } = require('node:timers');
const { RtpPacket, RtpHeader } = require('werift-rtp');
const { AudioJitter } = require('./AudioJitter');
const Recorder = require('./Recorder');
const Speaking = require('../../../util/Speaking');
const Util = require('../../../util/Util');
const MediaRecovery = require('../networking/MediaRecovery');
const secretbox = require('../util/Secretbox');
const { SILENCE_FRAME } = require('../util/Silence');
const { VideoFrames, packetize } = require('../util/VideoFrames');

// The delay between packets when a user is considered to have stopped speaking
// https://github.com/discordjs/discord.js/issues/3524#issuecomment-540373200
const DISCORD_SPEAKING_DELAY = 250;

// Unused: const HEADER_EXTENSION_BYTE = Buffer.from([0xbe, 0xde]);
const UNPADDED_NONCE_LENGTH = 4;
const AUTH_TAG_LENGTH = 16;

class Readable extends require('stream').Readable {
  _read() {} // eslint-disable-line no-empty-function
}

/**
 * Internal receive packet and media-frame handler.
 * @extends {EventEmitter}
 * @private
 */
class PacketHandler extends EventEmitter {
  constructor(receiver) {
    super();
    this.receiver = receiver;
    this.streams = new Map();
    this.videoStreams = new Map();
    this.speakingTimeouts = new Map();
    this.videoFrames = new VideoFrames();
    this.videoSequences = new Map();
    this.audioJitters = new Map();
    this.recovery = this.connection._mediaRecovery = new MediaRecovery(this.connection);
  }

  getNonceBuffer() {
    return this.receiver.connection.authentication.mode === 'aead_aes256_gcm_rtpsize'
      ? Buffer.alloc(12)
      : Buffer.alloc(24);
  }

  get connection() {
    return this.receiver.connection;
  }

  _stoppedSpeaking(userId) {
    const streamInfo = this.streams.get(userId);
    if (streamInfo && streamInfo.end === 'silence') {
      this.streams.delete(userId);
      streamInfo.stream.push(null);
    }
  }

  makeStream(user, end) {
    if (this.streams.has(user)) return this.streams.get(user).stream;
    const stream = new Readable();
    const cleanup = () => {
      if (this.streams.get(user)?.stream === stream) this.streams.delete(user);
    };
    stream.once('end', cleanup);
    stream.once('close', cleanup);
    this.streams.set(user, { stream, end });
    return stream;
  }

  makeVideoStream(user, output) {
    if (this.videoStreams.has(user)) return this.videoStreams.get(user);
    const stream = new Recorder(this, {
      userId: user,
      output,
    });
    this.videoStreams.set(user, stream);
    stream.once('closed', () => {
      if (this.videoStreams.get(user) === stream) this.videoStreams.delete(user);
    });
    return stream;
  }

  parseBuffer(buffer) {
    const { secret_key, mode } = this.receiver.connection.authentication;
    // Open packet
    if (!secret_key) return new Error('secret_key cannot be null or undefined');
    const nonce = this.getNonceBuffer();
    // Copy the last 4 bytes of unpadded nonce to the padding of (12 - 4) or (24 - 4) bytes
    buffer.copy(nonce, 0, buffer.length - UNPADDED_NONCE_LENGTH);

    let headerSize = 12 + (buffer[0] & 15) * 4;
    const first = buffer.readUint8();
    if ((first >> 4) & 0x01) headerSize += 4;
    if (headerSize > buffer.length - AUTH_TAG_LENGTH - UNPADDED_NONCE_LENGTH) {
      throw new RangeError('Truncated RTP header');
    }

    // The unencrypted RTP header contains 12 bytes, HEADER_EXTENSION and the extension size
    const header = buffer.slice(0, headerSize);

    // Encrypted contains the extension, if any, the opus packet, and the auth tag
    const encrypted = buffer.slice(headerSize, buffer.length - AUTH_TAG_LENGTH - UNPADDED_NONCE_LENGTH);
    const authTag = buffer.slice(
      buffer.length - AUTH_TAG_LENGTH - UNPADDED_NONCE_LENGTH,
      buffer.length - UNPADDED_NONCE_LENGTH,
    );

    let packet;
    switch (mode) {
      case 'aead_aes256_gcm_rtpsize': {
        const decipheriv = crypto.createDecipheriv('aes-256-gcm', secret_key, nonce);
        decipheriv.setAAD(header);
        decipheriv.setAuthTag(authTag);

        packet = Buffer.concat([decipheriv.update(encrypted), decipheriv.final()]);
        break;
      }
      case 'aead_xchacha20_poly1305_rtpsize': {
        // Combined mode expects authtag in the encrypted message
        packet = secretbox.methods.crypto_aead_xchacha20poly1305_ietf_decrypt(
          Buffer.concat([encrypted, authTag]),
          header,
          nonce,
          secret_key,
        );

        packet = Buffer.from(packet);
        break;
      }
      default: {
        return new RangeError(`Unsupported decryption method: ${mode}`);
      }
    }

    /*
    // Strip decrypted RTP Header Extension if present
    if (buffer.slice(12, 14).compare(HEADER_EXTENSION_BYTE) === 0) {
      const headerExtensionLength = buffer.slice(14).readUInt16BE();
      packet = packet.subarray(4 * headerExtensionLength);
    }
    */

    return RtpPacket.deSerialize(Buffer.concat([header, packet]));
  }

  audioReceiver(ssrc, userStat, opusPacket) {
    const streamInfo = this.streams.get(userStat.userId);
    // If the user is in video, we need to check if the packet is just silence
    if (userStat.hasVideo) {
      if (opusPacket instanceof Error) {
        // Only emit an error if we were actively receiving packets from this user
        if (streamInfo) {
          this.emit('error', opusPacket);
        }
        return;
      }
      // Check payload type
      if (opusPacket.header.payloadType !== Util.getPayloadType('opus')) {
        return;
      }
      if (!opusPacket.payload) {
        return;
      }
      if (SILENCE_FRAME.equals(opusPacket.payload) && !opusPacket.concealed) {
        // If this is a silence frame, pretend we never received it
        return;
      }
    }

    let speakingTimeout = this.speakingTimeouts.get(ssrc);
    if (typeof speakingTimeout === 'undefined') {
      // Ensure at least the speaking bit is set.
      // As the object is by reference, it's only needed once per client re-connect.
      if (userStat.speaking === 0) {
        userStat.speaking = Speaking.FLAGS.SPEAKING;
      }
      this.connection.onSpeaking({ user_id: userStat.userId, ssrc: ssrc, speaking: userStat.speaking });
      speakingTimeout = setTimeout(() => {
        try {
          this.connection.onSpeaking({ user_id: userStat.userId, ssrc: ssrc, speaking: 0 });
          clearTimeout(speakingTimeout);
          this.speakingTimeouts.delete(ssrc);
        } catch {
          // Connection already closed, ignore
        }
      }, DISCORD_SPEAKING_DELAY).unref();
      this.speakingTimeouts.set(ssrc, speakingTimeout);
    } else {
      speakingTimeout.refresh();
    }

    if (streamInfo) {
      const { stream } = streamInfo;
      if (opusPacket instanceof Error) {
        this.emit('error', opusPacket);
        return;
      }
      if (opusPacket.header.payloadType !== Util.getPayloadType('opus')) {
        return;
      }
      stream.push(opusPacket.payload);
    }
  }

  audioReceiverForStream(ssrc, userStat, packet) {
    const streamInfo = this.videoStreams.get(userStat.userId);
    if (!streamInfo) return;
    if (packet instanceof Error) {
      return;
    }
    if (packet.header.payloadType !== Util.getPayloadType('opus')) {
      return;
    }
    streamInfo.feed(packet);
  }

  /**
   * Test
   * @param {number} ssrc ssrc
   * @param {Object} userStat { userId, hasVideo }
   * @param {RtpPacket} packet RtpPacket
   * @returns {void}
   */
  videoReceiver(ssrc, userStat, packet) {
    const streamInfo = this.videoStreams.get(userStat.userId);
    // If the user is in video, we need to check if the packet is just silence
    if (userStat.hasVideo) {
      if (packet instanceof Error) {
        return;
      }

      if (packet.header.payloadType === Util.getPayloadType('opus')) {
        return;
      }

      if (this.connection.dave) {
        const codec = ['H264', 'H265', 'VP8'].find(name => Util.getPayloadType(name) === packet.header.payloadType);
        if (!codec) return;
        let plain;
        const frame = this.videoFrames.push(packet, codec, assembled => {
          plain = this.connection.dave.decrypt(assembled, userStat.userId, true);
          return Boolean(plain);
        });
        if (!frame) return;
        this.receiver.emit('videoFrame', userStat, plain, codec);
        if (streamInfo) {
          const payloads = packetize(plain, codec);
          let sequence = this.videoSequences.get(ssrc) ?? packet.header.sequenceNumber;
          for (let i = 0; i < payloads.length; i++) {
            streamInfo.feed(
              new RtpPacket(
                new RtpHeader({
                  ssrc,
                  timestamp: packet.header.timestamp,
                  payloadType: packet.header.payloadType,
                  sequenceNumber: sequence++ & 65535,
                  marker: i === payloads.length - 1,
                }),
                payloads[i],
              ),
            );
          }
          this.videoSequences.set(ssrc, sequence & 65535);
        }
      } else if (streamInfo) {
        streamInfo.feed(packet);
      }
    }
  }

  push(buffer) {
    if (
      Buffer.isBuffer(buffer) &&
      buffer.length >= 28 &&
      buffer[0] >> 6 === 2 &&
      buffer[1] >= 192 &&
      buffer[1] <= 223
    ) {
      this.recovery.handle(buffer);
      return;
    }
    if (!Buffer.isBuffer(buffer) || buffer.length < 32 || buffer[0] >> 6 !== 2) return;
    const ssrc = buffer.readUInt32BE(8);
    let userStat, packet;
    try {
      packet = this.parseBuffer(buffer);
    } catch {
      // Malformed or unauthenticated datagrams must not escape the UDP callback.
      return;
    }
    if (packet instanceof Error) return;
    const type = packet.header.payloadType;
    if (!Util.getAllPayloadType().some(codec => codec.payload_type === type || codec.rtx_payload_type === type)) return;
    if (this.connection.ssrcMap.has(ssrc)) {
      userStat = this.connection.ssrcMap.get(ssrc); // Audio_ssrc
      if (userStat.kind === 'video-rtx') {
        const codec = Util.getAllPayloadType().find(value => value.rtx_payload_type === packet.header.payloadType);
        if (!codec || packet.payload.length < 3) return;
        packet.header.ssrc = userStat.primarySsrc;
        packet.header.sequenceNumber = packet.payload.readUInt16BE();
        packet.header.payloadType = codec.payload_type;
        packet.payload = packet.payload.subarray(2);
        this.recovery.receive(packet);
        this.videoReceiver(userStat.primarySsrc, userStat, packet);
      } else if (userStat.kind === 'video') {
        this.recovery.receive(packet);
        this.videoReceiver(ssrc, userStat, packet);
      } else {
        if (type !== Util.getPayloadType('opus')) return;
        if (this.connection.dave) {
          const plain = this.connection.dave.decrypt(packet.payload, userStat.userId);
          if (!plain) return;
          packet.payload = plain;
        }
        let jitter = this.audioJitters.get(ssrc);
        if (jitter && jitter.userId !== userStat.userId) {
          jitter.reset();
          this.audioJitters.delete(ssrc);
          jitter = null;
        }
        if (!jitter) {
          if (this.audioJitters.size >= 32) return;
          jitter = new AudioJitter(ordered => {
            this.audioReceiver(ssrc, jitter.userStat, ordered);
            this.audioReceiverForStream(ssrc, jitter.userStat, ordered);
          });
          jitter.userId = userStat.userId;
          this.audioJitters.set(ssrc, jitter);
        }
        jitter.userStat = userStat;
        jitter.push(packet);
      }
    } else if (this.connection.ssrcMap.has(ssrc - 1)) {
      userStat = this.connection.ssrcMap.get(ssrc - 1); // Video_ssrc
      this.videoReceiver(ssrc, userStat, packet);
    }
    if (userStat && !(packet instanceof Error)) this.receiver.emit('receiverData', userStat, packet);
  }

  // When udp connection is closed (STREAM_DELETE), destroy all streams (Memory leak)
  forgetSource(ssrc) {
    this.audioJitters.get(ssrc)?.reset();
    this.audioJitters.delete(ssrc);
    this.recovery.sources.delete(ssrc);
    this.videoSequences.delete(ssrc);
    clearTimeout(this.speakingTimeouts.get(ssrc));
    this.speakingTimeouts.delete(ssrc);
    for (const key of this.videoFrames.frames.keys()) {
      if (key.startsWith(`${ssrc}:`)) this.videoFrames.frames.delete(key);
    }
  }

  destroyAllStream() {
    this.recovery.reset();
    for (const jitter of this.audioJitters.values()) jitter.reset();
    this.audioJitters.clear();
    for (const timeout of this.speakingTimeouts.values()) clearTimeout(timeout);
    this.speakingTimeouts.clear();
    this.videoFrames.frames.clear();
    this.videoFrames.completed.clear();
    this.videoSequences.clear();
    for (const stream of this.streams.values()) {
      stream.stream.destroy();
    }
    this.streams.clear();
    for (const stream of this.videoStreams.values()) {
      stream.destroy();
    }
    this.videoStreams.clear();
  }
}

module.exports = PacketHandler;
