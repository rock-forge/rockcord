'use strict';

const { Buffer } = require('node:buffer');
const { Writable } = require('node:stream');
const { setTimeout } = require('node:timers');
const { encrypt } = require('../util/TransportCrypto');

const MAX_UINT_16 = 2 ** 16 - 1;
const MAX_UINT_32 = 2 ** 32 - 1;

const packetStates = new WeakMap();

/**
 * @external WritableStream
 * @see {@link https://nodejs.org/api/stream.html#stream_class_stream_writable}
 */

/**
 * @extends {Writable}
 */
class BaseDispatcher extends Writable {
  constructor(player, highWaterMark = 12, payloadType, extensionEnabled, streams = {}) {
    super({
      highWaterMark,
    });
    this.streams = streams;
    /**
     * The Player that controls this dispatcher
     * @type {MediaPlayer}
     */
    this.player = player;
    this.payloadType = payloadType;
    this.extensionEnabled = extensionEnabled;

    this._nonce = 0;
    this._nonceBuffer = null;

    /**
     * The time that the stream was paused at (null if not paused)
     * @type {?number}
     */
    this.pausedSince = null;
    this._writeCallback = null;

    this._pausedTime = 0;
    this._silentPausedTime = 0;

    this.count = 0;
    this.sequence = 0;
    this.timestamp = 0;
    const connection = player.voiceConnection;
    if (connection?.authentication?.secret_key) {
      let states = packetStates.get(connection);
      if (!states) packetStates.set(connection, (states = new Map()));
      const type = this.getTypeDispatcher();
      const { secret_key, ssrc } = connection.authentication;
      let state = states.get(type);
      if (!state || state.ssrc !== ssrc || !state.key.equals(Buffer.from(secret_key))) {
        state = { ssrc, key: Buffer.from(secret_key), sequence: 0, timestamp: 0 };
        states.set(type, state);
      }
      this._packetState = state;
      this.sequence = state.sequence;
      this.timestamp = state.timestamp;
    }

    const streamError = (type, err) => {
      /**
       * Emitted when the dispatcher encounters an error.
       * @event BaseDispatcher#error
       */
      if (type && err) {
        err.message = `${type} stream: ${err.message}`;
        this.emit(this.player.dispatcher === this ? 'error' : 'debug', err);
      }
      this.destroy();
    };

    this.on('error', () => streamError());
    if (this.streams.input) this.streams.input.on('error', err => streamError('input', err));
    if (this.streams.ffmpeg) this.streams.ffmpeg.on('error', err => streamError('ffmpeg', err));
    if (this.streams.opus) this.streams.opus.on('error', err => streamError('opus', err));
    if (this.streams.volume) this.streams.volume.on('error', err => streamError('volume', err));

    this.on('finish', () => {
      this._cleanup();
      if (this.getTypeDispatcher() === 'audio') {
        this._setSpeaking(0);
      } else if (this.getTypeDispatcher() === 'video') {
        this._setVideoStatus(false);
        this._setStreamStatus(true);
      }
    });
  }

  getTypeDispatcher() {
    return 'base';
  }

  resetNonceBuffer() {
    this._nonceBuffer =
      this.player.voiceConnection.authentication.mode === 'aead_aes256_gcm_rtpsize'
        ? Buffer.alloc(12)
        : Buffer.alloc(24);
  }

  getNewSequence() {
    const currentSeq = this.sequence;
    this.sequence++;
    if (this.sequence > MAX_UINT_16) this.sequence = 0;
    if (this._packetState) this._packetState.sequence = this.sequence;
    return currentSeq;
  }

  _write(chunk, enc, done) {
    if (!this.startTime) {
      /**
       * Emitted once the stream has started to play.
       * @event BaseDispatcher#start
       */
      this.emit('start');
      this.startTime = performance.now();
    }
    if (this._syncDispatcher && !this._syncDispatcher.startTime && !this._syncStartListener) {
      this.pause();
      const cb = () => {
        this._syncDispatcher.removeListener('start', cb);
        clearTimeout(this._syncStartTimer);
        this._syncStartListener = null;
        this.resume();
      };
      this._syncStartListener = cb;
      this._syncDispatcher.once('start', cb);
      this._syncStartTimer = setTimeout(cb, 10_000).unref();
    }
    try {
      if (this.getTypeDispatcher() === 'video') {
        this._codecCallback(chunk);
      } else {
        this._playChunk(chunk);
      }
    } catch (error) {
      done(error);
      return;
    }
    this._step(done);
  }

  _destroy(err, cb) {
    this._cleanup();
    super._destroy(err, cb);
  }

  _cleanup() {
    clearTimeout(this._stepTimer);
    clearTimeout(this._syncStartTimer);
    if (this._syncStartListener) this._syncDispatcher?.removeListener('start', this._syncStartListener);
    this._syncStartListener = null;
    this._writeCallback = null;
    if (this.player.dispatcher === this) {
      this.player.dispatcher.destroy();
      this.player.dispatcher = null;
    }
    if (this.player.videoDispatcher === this) {
      this.player.videoDispatcher.destroy();
      this.player.videoDispatcher = null;
    }
    const { streams } = this;
    if (streams.opus) streams.opus.destroy();
    streams.ffmpeg?.destroy();
  }

  /**
   * Pauses playback
   * @param {boolean} [silence=false] Whether to play silence while paused to prevent audio glitches
   */
  pause(silence = false) {
    if (this.paused) return;
    if (this.streams.opus) this.streams.opus.unpipe(this); // Audio
    if (this.streams.video) {
      this.streams.ffmpeg.pause();
      this.streams.video.unpipe(this);
    }
    if (this.getTypeDispatcher() === 'audio') {
      if (silence) {
        this.streams.silence.pipe(this);
        this._silence = true;
      } else {
        this._setSpeaking(0);
      }
    }
    this.pausedSince = performance.now();
  }

  /**
   * Whether or not playback is paused
   * @type {boolean}
   * @readonly
   */
  get paused() {
    return Boolean(this.pausedSince);
  }

  /**
   * Total time that this dispatcher has been paused in milliseconds
   * @type {number}
   * @readonly
   */
  get pausedTime() {
    return this._silentPausedTime + this._pausedTime + (this.paused ? performance.now() - this.pausedSince : 0);
  }

  /**
   * Resumes playback
   */
  resume() {
    if (!this.pausedSince) return;
    if (this.getTypeDispatcher() === 'audio') this.streams.silence.unpipe(this);
    if (this.streams.opus) this.streams.opus.pipe(this);
    if (this.streams.video) {
      this.streams.ffmpeg.resume();
      this.streams.video.pipe(this);
    }
    if (this._silence) {
      this._silentPausedTime += performance.now() - this.pausedSince;
      this._silence = false;
    } else {
      this._pausedTime += performance.now() - this.pausedSince;
    }
    this.pausedSince = null;
    if (typeof this._writeCallback === 'function') this._writeCallback();
  }

  /**
   * The time (in milliseconds) that the dispatcher has been playing audio for, taking into account skips and pauses
   * @type {number}
   * @readonly
   */
  get totalStreamTime() {
    return performance.now() - this.startTime;
  }

  _step(done) {
    this._writeCallback = () => {
      this._writeCallback = null;
      done();
    };
    const next = (this.count + 1) * this.FRAME_LENGTH - (performance.now() - this.startTime - this._pausedTime);
    this._stepTimer = setTimeout(() => {
      if ((!this.pausedSince || this._silence) && this._writeCallback) this._writeCallback();
    }, Math.max(0, next)).unref();
    this.timestamp = (this.timestamp + this.TIMESTAMP_INC) % (MAX_UINT_32 + 1);
    if (this._packetState) this._packetState.timestamp = this.timestamp;
    this.count++;
  }

  _final(callback) {
    this._writeCallback = null;
    callback();
  }

  _playChunk(chunk, isLastPacket = false) {
    if (
      (this.player.dispatcher !== this && this.player.videoDispatcher !== this) ||
      !this.player.voiceConnection.authentication.secret_key
    ) {
      return;
    }
    if (this.getTypeDispatcher() === 'audio' && this.player.voiceConnection.dave) {
      chunk = this.player.voiceConnection.dave.encrypt(chunk);
      if (!chunk) return;
    }
    const packet = this._createPacket(chunk, isLastPacket);
    if (packet) this._sendPacket(packet);
  }

  /**
   * Creates a one-byte extension header
   * https://www.rfc-editor.org/rfc/rfc5285#section-4.2
   * @returns {Buffer} <Buffer be de 00 01>
   */
  createHeaderExtension() {
    /*
      *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
      +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
      |      defined by profile       |           length              |
      +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
      */
    const profile = Buffer.alloc(4);
    profile[0] = 0xbe;
    profile[1] = 0xde;
    profile.writeUInt16BE(this.createPayloadExtension().length / 4, 2);

    return profile;
  }

  /*
   * Creates padded native UDP extensions for playout delay, stream ID and transport sequence.
   * @see https://docs.discord.food/topics/voice-connections#sending-and-receiving-voice
   * Discord expects a playout delay RTP extension header on every video packet.
   * @see https://webrtc.googlesource.com/src/+/refs/heads/main/docs/native-code/rtp-hdrext/playout-delay
   * @returns {Buffer} Padded RTP extension elements
   */
  createPayloadExtension() {
    // Native UDP uses ID 6 for playout delay, 11 for primary RID, and 5 for transport sequence.
    const rid = Buffer.from(this.player.voiceConnection.authentication.streams?.[0]?.rid || '100');
    if (!rid.length || rid.length > 16) throw new RangeError('Invalid video RID');
    const data = Buffer.concat([
      Buffer.from([0x62, 0, 0, 0, 0xb0 | (rid.length - 1)]),
      rid,
      Buffer.from([0x51, (this.sequence >> 8) & 255, this.sequence & 255]),
    ]);
    return Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  }

  _encrypt(buffer, additionalData) {
    const parts = encrypt(this.player.voiceConnection, buffer, additionalData);
    this._nonce = parts[1].readUInt32BE();
    this.resetNonceBuffer();
    parts[1].copy(this._nonceBuffer);
    return parts;
  }

  _createPacket(buffer, isLastPacket) {
    /*
    // Packet is raw rtp from ffmpeg
    const rtp = webrtc.RtpPacket.deSerialize(buffer);
    if (!rtp.payload) {
      console.log('no payload', rtp);
      return null;
    }
    // Header
    // https://docs.discord.food/topics/voice-connections#rtp-packet-structure
    let rtpHeader = buffer.slice(0, 12); // RTP_HEADER_SIZE
    rtpHeader[0] = 0x80; // Version + Flags (1 byte)
    rtpHeader[1] = this.payloadType; // Payload Type (1 byte)
    if (this.extensionEnabled) {
      rtpHeader = Buffer.concat([rtpHeader, this.createHeaderExtension()]);
      rtpHeader[0] |= 1 << 4; // 0x90
    }
    rtpHeader.writeUIntBE(this.getNewSequence(), 2, 2);
    rtpHeader.writeUIntBE(this.timestamp, 4, 4);
    rtpHeader.writeUIntBE(
      this.player.voiceConnection.authentication.ssrc + Number(this.getTypeDispatcher() === 'video'),
      8,
      4,
    );
    */
    // Header
    let rtpHeader = Buffer.alloc(12); // RTP_HEADER_SIZE
    rtpHeader[0] = 0x80; // Version + Flags (1 byte)
    rtpHeader[1] = this.payloadType; // Payload Type (1 byte)
    if (this.extensionEnabled) {
      rtpHeader = Buffer.concat([rtpHeader, this.createHeaderExtension()]);
      rtpHeader[0] |= 1 << 4; // 0x90
    }
    if (this.getTypeDispatcher() === 'video' && isLastPacket) {
      rtpHeader[1] |= 1 << 7; // Marker bit
    }

    rtpHeader.writeUIntBE(this.getNewSequence(), 2, 2);
    rtpHeader.writeUIntBE(this.timestamp, 4, 4);
    rtpHeader.writeUIntBE(
      this.player.voiceConnection.authentication.ssrc + Number(this.getTypeDispatcher() === 'video'),
      8,
      4,
    );
    this.player.voiceConnection._mediaRecovery?.remember(rtpHeader, buffer);
    return Buffer.concat([rtpHeader, ...this._encrypt(buffer, rtpHeader)]);
  }

  _sendPacket(packet) {
    /**
     * Emitted whenever the dispatcher has debug information.
     * @event BaseDispatcher#debug
     * @param {string} info The debug info
     */
    if (this.getTypeDispatcher() === 'audio') {
      this._setSpeaking(this.player.isScreenSharing ? 1 << 1 : 1 << 0); // 1 << 0 = SPEAKING, 1 << 1 = SOUND SHARE
    } else if (this.getTypeDispatcher() === 'video') {
      this._setVideoStatus(true);
      this._setStreamStatus(false);
    }
    if (!this.player.voiceConnection.sockets.udp) {
      this.emit('debug', 'Failed to send a packet - no UDP socket');
      return;
    }
    this.player.voiceConnection.sockets.udp.send(packet).catch(e => {
      if (this.getTypeDispatcher() === 'audio') {
        this._setSpeaking(0);
      } else if (this.getTypeDispatcher() === 'video') {
        this._setVideoStatus(false);
        this._setStreamStatus(true);
      }
      this.emit('debug', `Failed to send a packet - ${e}`);
    });
  }

  _setSpeaking(value) {
    if (typeof this.player.voiceConnection !== 'undefined') {
      this.player.voiceConnection.setSpeaking(value);
    }
    /**
     * Emitted when the dispatcher starts/stops speaking.
     * @event AudioDispatcher#speaking
     * @param {boolean} value Whether or not the dispatcher is speaking
     */
    this.emit('speaking', value);
  }

  _setVideoStatus(value) {
    if (typeof this.player.voiceConnection !== 'undefined') {
      this.player.voiceConnection.setVideoStatus(value);
    }
    /**
     * Emitted when the dispatcher starts/stops video.
     * @event VideoDispatcher#videoStatus
     * @param {boolean} value Whether or not the dispatcher is enable video
     */
    this.emit('videoStatus', value);
  }

  _setStreamStatus(value) {
    if (typeof this.player.voiceConnection?.sendScreenshareState !== 'undefined') {
      this.player.voiceConnection.sendScreenshareState(value);
    }
    /**
     * Emitted when the dispatcher starts/stops video.
     * @event VideoDispatcher#streamStatus
     * @param {boolean} isPaused Whether or not the dispatcher is pause video
     */
    this.emit('streamStatus', value);
  }
}

module.exports = BaseDispatcher;
