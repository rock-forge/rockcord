'use strict';

const { spawn } = require('child_process');
const { createSocket } = require('dgram');
const { EventEmitter } = require('events');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { setTimeout } = require('node:timers');
const { Writable } = require('stream');
const kill = require('tree-kill');
const { RtpPacket } = require('werift-rtp');
const Util = require('../../../util/Util');
const { randomPort } = require('../util/Function');
const { StreamOutput } = require('../util/Socket');

/**
 * Represents a FFmpeg handler
 * @extends {EventEmitter}
 */
class Recorder extends EventEmitter {
  constructor(receiver, { userId, portUdpH264, portUdpOpus, output } = {}) {
    super();

    Object.defineProperty(this, 'receiver', { value: receiver });

    /**
     * The user ID
     * @type {Snowflake}
     */
    this.userId = userId;

    this.portUdpH264 = portUdpH264 || null;
    this.portUdpH265 = null;
    this.portUdpOpus = portUdpOpus || null;

    this.promise = null;

    if (!portUdpH264 || !portUdpOpus) {
      this.promise = (async () => {
        const selected = new Set([this.portUdpH264, this.portUdpOpus].filter(Boolean));
        const missing = Number(!this.portUdpH264) + Number(!this.portUdpOpus);
        const ports = [];
        for (let attempt = 0; ports.length < missing && attempt < 64; attempt++) {
          const port = await randomPort('udp4');
          if (port % 2 === 0 && !selected.has(port)) {
            selected.add(port);
            ports.push(port);
          }
        }
        if (ports.length < missing) throw new Error('Could not allocate recording ports');
        this.portUdpH264 ??= ports.shift();
        this.portUdpOpus ??= ports.shift();
      })();
    }

    /**
     * The output of the stream
     * @type {string|Readable}
     */
    this.output = output;

    /**
     * The FFmpeg process is ready or not
     * @type {boolean}
     */
    this.ready = false;
    this.destroyed = false;
    this.closed = false;
    this.completion = new Promise(resolve => (this._resolveCompletion = resolve));

    this.socket = createSocket('udp4');

    this.socket.on('error', error => this.fail(error));
    this.init(output).catch(error => this.fail(error));
  }

  fail(error) {
    this._error = error;
    if (this.listenerCount('error')) this.emit('error', error);
    else this.emit('debug', error.message);
    this.destroy();
  }
  async init(output) {
    await this.promise;
    if (this.destroyed) return;
    // Keep stdin available for FFmpeg's graceful quit command. Reading SDP from
    // stdin and closing it leaves no way to write the Matroska trailer on Windows.
    const sdpData = Util.getSDPCodecName(this.portUdpH264, this.portUdpH265, this.portUdpOpus).replace(
      /;sprop-parameter-sets=[^;\r\n]+/,
      '',
    );
    this._directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rockcord-recorder-'));
    this._sdpPath = path.join(this._directory, 'input.sdp');
    fs.writeFileSync(this._sdpPath, sdpData);
    const isStream = output instanceof Writable;
    if (isStream) {
      this.outputStream = StreamOutput(output);
    }
    const stream = spawn(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-hide_banner',
        '-reorder_queue_size',
        '0',
        '-thread_queue_size',
        '500',
        '-err_detect',
        'ignore_err',
        '-flags2',
        '+export_mvs',
        '-fflags',
        '+genpts+discardcorrupt',
        '-f',
        'sdp',
        '-analyzeduration',
        '5000000',
        '-probesize',
        '1M',
        '-listen_timeout',
        '0',
        '-protocol_whitelist',
        'file,udp,rtp,pipe,fd',
        '-i',
        this._sdpPath,
        '-buffer_size',
        '4M',
        '-max_delay',
        '0',
        '-rtbufsize',
        '4M',
        '-c',
        'copy',
        '-y',
        '-f',
        'matroska',
        isStream ? this.outputStream.url : output,
      ],
      { windowsHide: true },
    );

    /**
     * The FFmpeg process
     * @type {ChildProcessWithoutNullStreams}
     */
    this.stream = stream;
    stream.on('error', error => this.fail(error));
    stream.stdin.on('error', error => this.fail(error));
    stream.once('close', code => {
      this.exitCode = code;
      if (code && !this._error) this._error = new Error(`FFmpeg recording exited with code ${code}`);
      this.destroy();
      this._finalize();
    });
    this.stream.stdout?.resume();
    stream.once('spawn', () => this._waitForPorts().catch(error => this.fail(error)));
    this.stream.stderr.on('data', data => {
      this.emit('debug', `stderr: ${data}`);
    });
  }

  async _waitForPorts() {
    const bound = port =>
      new Promise(resolve => {
        const probe = createSocket('udp4');
        probe.once('error', error => {
          try {
            probe.close();
          } catch {
            /* An unsuccessful bind may close the probe. */
          }
          resolve(error.code === 'EADDRINUSE');
        });
        probe.bind(port, '127.0.0.1', () => probe.close(() => resolve(false)));
      });
    for (let attempt = 0; attempt < 120 && !this.destroyed; attempt++) {
      const ports = await Promise.all([bound(this.portUdpH264), bound(this.portUdpOpus)]);
      if (ports.every(Boolean)) {
        this.ready = true;
        this.emit('ready', this);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!this.destroyed) throw new Error('FFmpeg did not open the recording RTP ports');
  }
  /**
   * Send a payload to FFmpeg via UDP
   * @param {RtpPacket|string|Buffer} payload The payload
   * @param {*} callback Callback
   */
  feed(
    payload,
    callback = e => {
      if (e) {
        console.error('Error sending packet:', e);
      }
    },
  ) {
    if (this.destroyed) return;
    if (!(payload instanceof RtpPacket)) {
      payload = RtpPacket.deSerialize(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    }
    const message = payload.serialize();
    // Get port from payloadType
    let port;
    if (payload.header.payloadType === Util.getPayloadType('opus')) {
      port = this.portUdpOpus;
      this._lastAudioHeader = payload.header;
    } else if (payload.header.payloadType === Util.getPayloadType('H264')) {
      port = this.portUdpH264;
      this._lastVideoHeader = payload.header;
    } else {
      return;
    }
    this.socket.send(message, 0, message.length, port, '127.0.0.1', callback);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    if (this.receiver?.videoStreams?.get(this.userId) === this) this.receiver.videoStreams.delete(this.userId);
    if (this.stream?.pid && this.stream.exitCode === null && !this._error) {
      // RTCP BYE ends both local RTP inputs. Unlike an immediate quit, EOF lets
      // FFmpeg drain its parser and muxer, preserving the final buffered frame.
      for (const [port, ssrc] of [
        [this.portUdpH264, this._lastVideoHeader?.ssrc ?? 1],
        [this.portUdpOpus, this._lastAudioHeader?.ssrc ?? 2],
      ]) {
        // Include an empty, padded reason: FFmpeg's RTP demuxer requires at
        // least 12 bytes even though a reason-less BYE may be eight bytes.
        const bye = Buffer.from([0x81, 203, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
        bye.writeUInt32BE(ssrc, 4);
        this.socket.send(bye, port + 1, '127.0.0.1', () => {});
      }
      this._quitTimer = setTimeout(() => this.stream.stdin.end('q\n'), 2000).unref();
      this._killTimer = setTimeout(() => {
        this._error = new Error('FFmpeg recording did not stop within 5 seconds');
        kill(this.stream.pid, () => {});
      }, 5000).unref();
    } else if (this.stream?.pid && this.stream.exitCode === null) {
      // Wait for close before removing the SDP: Windows keeps the input file
      // locked until the failed child has actually exited.
      kill(this.stream.pid, () => {});
    } else {
      this._finalize();
    }
  }

  /**
   * Stop receiving and wait for FFmpeg to finalize the recording.
   * @returns {Promise<void>}
   */
  async stop() {
    this.destroy();
    await this.completion;
    if (this._error) throw this._error;
  }

  _finalize() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._killTimer);
    clearTimeout(this._quitTimer);
    try {
      this.socket.close();
    } catch {
      /* Socket may not have bound yet. */
    }
    this.outputStream?.destroy();
    try {
      if (this._sdpPath) fs.rmSync(this._sdpPath, { force: true });
      if (this._directory) fs.rmdirSync(this._directory);
    } catch (error) {
      this._error ??= error;
      this.emit('debug', `Recorder temporary-file cleanup failed: ${error.message}`);
    }
    this._resolveCompletion();
    this.emit('closed', this);
  }

  /**
   * Emitted when the Recorder becomes ready to start working.
   * @event Recorder#ready
   */

  /**
   * Emitted when the Recorder is closed.
   * @event Recorder#closed
   */
}

module.exports = Recorder;
