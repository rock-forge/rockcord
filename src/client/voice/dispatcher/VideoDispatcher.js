'use strict';

const { setTimeout } = require('node:timers');
const BaseDispatcher = require('./BaseDispatcher');
const CongestionControl = require('../networking/CongestionControl');

/**
 * The class that sends video packet data to the voice connection.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel).then(connection => {
 *   // You can play a file or a stream here:
 *   const dispatcher = connection.playVideo('/home/hydrabolt/video.mp4', { fps: 60, preset: 'ultrafast' });
 * });
 * ```
 * @extends {BaseDispatcher}
 */
class VideoDispatcher extends BaseDispatcher {
  constructor(player, highWaterMark = 12, streams, fps = 30, payloadType) {
    super(player, highWaterMark, payloadType, true, streams);
    /**
     * Video FPS
     * @type {number}
     */
    this.setFPSSource(fps);

    this.mtu = 1200;
  }

  get TIMESTAMP_INC() {
    return 90000 / this.fps;
  }

  get FRAME_LENGTH() {
    return 1000 / this.fps;
  }

  /**
   * Get the type of the dispatcher
   * @returns {'video'}
   */
  getTypeDispatcher() {
    return 'video';
  }

  partitionMtu(data) {
    const out = [];
    const dataLength = data.length;

    for (let i = 0; i < dataLength; i += this.mtu) {
      out.push(data.slice(i, i + this.mtu));
    }

    return out;
  }

  /**
   * Set FPS
   * @param {number} value fps
   */
  setFPSSource(value) {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError('Video FPS must be a positive finite number');
    this.fps = value;
  }

  _codecCallback() {
    throw new Error('The _codecCallback method must be implemented');
  }

  configureCongestion(options = {}) {
    if (options.congestionControl === false) return;
    const config = typeof options.congestionControl === 'object' ? options.congestionControl : {};
    const bitrate = config.bitrate ?? (typeof options.bitrate === 'number' ? options.bitrate : 2000);
    this.congestionControl = new CongestionControl({
      bitrate,
      minBitrate: Math.min(128, bitrate),
      ...config,
      onChange: state => this.emit('congestion', state),
    });
    this.player.voiceConnection._congestionControl = this.congestionControl;
  }

  _write(chunk, encoding, done) {
    if (this.congestionControl) {
      this._pacedPackets = [];
      this._pacedBytes = 0;
      this._pacingKey = this.player.voiceConnection.authentication.secret_key;
    }
    super._write(chunk, encoding, done);
  }

  _sendPacket(packet) {
    if (!this._pacedPackets) return super._sendPacket(packet);
    this._pacedBytes += packet.length;
    if (this._pacedBytes > 4 * 1024 * 1024 || this._pacedPackets.length >= 4096) {
      throw new RangeError('Video frame exceeds the pacing queue limit');
    }
    this._pacedPackets.push(packet);
    return undefined;
  }

  _step(done) {
    if (!this._pacedPackets) return super._step(done);
    const packets = this._pacedPackets;
    this._pacedPackets = null;
    let index = 0;
    const sendNext = () => {
      if (this.destroyed) return;
      if (this.paused) {
        this._pacingTimer = setTimeout(sendNext, 20).unref();
        return;
      }
      if (index === packets.length) {
        super._step(done);
        return;
      }
      const packet = packets[index++];
      const delay = this.congestionControl.delay(packet.length);
      this._pacingTimer = setTimeout(
        () => {
          if (this.destroyed) return;
          if (this._pacingKey !== this.player.voiceConnection.authentication.secret_key) {
            this.destroy(new Error('Video transport key changed during paced playback'));
            return;
          }
          if (this.paused) {
            index--;
            sendNext();
            return;
          }
          this.congestionControl.packetSent();
          super._sendPacket(packet);
          sendNext();
        },
        Math.max(0, delay),
      ).unref();
    };
    sendNext();
    return undefined;
  }

  _cleanup() {
    clearTimeout(this._pacingTimer);
    this._pacedPackets = null;
    if (this.player.voiceConnection._congestionControl === this.congestionControl) {
      this.player.voiceConnection._congestionControl = null;
    }
    super._cleanup();
  }
}

module.exports = VideoDispatcher;
