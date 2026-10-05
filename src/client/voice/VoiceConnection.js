'use strict';

const EventEmitter = require('events');
const { getCiphers } = require('node:crypto');
const { setTimeout } = require('node:timers');
const { Collection } = require('@discordjs/collection');
const VoiceUDP = require('./networking/VoiceUDPClient');
const VoiceWebSocket = require('./networking/VoiceWebSocket');
const MediaPlayer = require('./player/MediaPlayer');
const VoiceReceiver = require('./receiver/Receiver');
const { parseStreamKey } = require('./util/Function');
const PlayInterface = require('./util/PlayInterface');
const Silence = require('./util/Silence');
const { Error } = require('../../errors');
const { Opcodes, VoiceOpcodes, VoiceStatus, Events } = require('../../util/Constants');
const Speaking = require('../../util/Speaking');
const Util = require('../../util/Util');

// Workaround for Discord now requiring silence to be sent before being able to receive audio
class SingleSilence extends Silence {
  _read() {
    super._read();
    this.push(null);
  }
}

const SUPPORTED_MODES = ['aead_xchacha20_poly1305_rtpsize'];

// Just in case there's some system that doesn't come with aes-256-gcm, conditionally add it as supported
if (getCiphers().includes('aes-256-gcm')) {
  SUPPORTED_MODES.unshift('aead_aes256_gcm_rtpsize');
}

const SUPPORTED_CODECS = ['VP8', 'H264', 'H265'];

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => {
 *
 *   });
 * ```
 * @extends {EventEmitter}
 * @implements {PlayInterface}
 */
class VoiceConnection extends EventEmitter {
  constructor(voiceManager, channel) {
    super();

    /**
     * The voice manager that instantiated this connection
     * @type {ClientVoiceManager}
     */
    this.voiceManager = voiceManager;

    /**
     * The voice channel this connection is currently serving
     * @type {VoiceChannel}
     */
    this.channel = channel;

    /**
     * The current status of the voice connection
     * @type {VoiceStatus}
     */
    this.status = VoiceStatus.AUTHENTICATING;

    /**
     * Our current speaking state
     * @type {Readonly<Speaking>}
     */
    this.speaking = new Speaking().freeze();

    /**
     * Our current video state
     * @type {boolean | null}
     */
    this.videoStatus = null;

    /**
     * The authentication data needed to connect to the voice server
     * @type {Object}
     * @private
     */
    this.authentication = {};

    /**
     * The audio player for this voice connection
     * @type {MediaPlayer}
     */
    this.player = new MediaPlayer(this, this.constructor.name === 'StreamConnection');

    this.player.on('debug', m => {
      /**
       * Debug info from the connection.
       * @event VoiceConnection#debug
       * @param {string} message The debug message
       */
      this.emit('debug', `media player - ${m}`);
    });

    this.player.on('error', e => {
      /**
       * Warning info from the connection.
       * @event VoiceConnection#warn
       * @param {string|Error} warning The warning
       */
      this.emit('warn', e);
    });

    this.once('closing', () => this.player.destroy());

    /**
     * Map SSRC values to user IDs
     * @type {Map<number, { userId: Snowflake, speaking: boolean, hasVideo: boolean }>}
     * @private
     */
    this.ssrcMap = new Map();

    /**
     * Tracks which users are talking
     * @type {Map<Snowflake, Readonly<Speaking>>}
     * @private
     */
    this._speaking = new Map();

    /**
     * Object that wraps contains the `ws` and `udp` sockets of this voice connection
     * @type {Object}
     * @private
     */
    this.sockets = {};

    /**
     * The voice receiver of this connection
     * @type {VoiceReceiver}
     */
    this.receiver = new VoiceReceiver(this);

    /**
     * Video codec
     * * `VP8`
     * * `VP9` (Not supported for encoding & decoding)
     * * `H264`
     * * `H265`
     * * `AV1` (Not supported for encoding & decoding)
     * @typedef {string} VideoCodec
     */

    /**
     * Video codec (encoded) of this connection
     * @type {VideoCodec}
     */
    this.videoCodec = 'H264';

    /**
     * Create a stream connection ?
     * @type {?StreamConnection}
     */
    this.streamConnection = null;

    /**
     * All stream watch connection
     * @type {Collection<Snowflake, StreamConnectionReadonly>}
     */
    this.streamWatchConnection = new Collection();
  }

  /**
   * The client that instantiated this connection
   * @type {Client}
   * @readonly
   */
  get client() {
    return this.voiceManager.client;
  }

  /**
   * The current audio dispatcher (if any)
   * @type {?AudioDispatcher}
   * @readonly
   */
  get dispatcher() {
    return this.player.dispatcher;
  }

  /**
   * The current video dispatcher (if any)
   * @type {?VideoDispatcher}
   * @readonly
   */
  get videoDispatcher() {
    return this.player.videoDispatcher;
  }

  /**
   * Sets whether the voice connection should display as "speaking", "soundshare" or "none".
   * @param {BitFieldResolvable} value The new speaking state
   */
  setSpeaking(value) {
    if (this.speaking.equals(value)) return;
    if (this.status !== VoiceStatus.CONNECTED) return;
    this.speaking = new Speaking(value).freeze();
    this.sockets.ws
      .sendPacket({
        op: VoiceOpcodes.SPEAKING,
        d: {
          speaking: this.speaking.bitfield,
          delay: 0,
          ssrc: this.authentication.ssrc,
        },
      })
      .catch(e => {
        this.emit('debug', e);
      });
  }

  /**
   * Set video codec before select protocol
   * @param {VideoCodec} value Codec
   * @returns {VoiceConnection}
   */
  setVideoCodec(value) {
    if (!SUPPORTED_CODECS.includes(value)) throw new Error('INVALID_VIDEO_CODEC', SUPPORTED_CODECS);
    this.videoCodec = value;
    return this;
  }

  /**
   * Sets video status
   * @param {boolean} value Video on or off
   */
  setVideoStatus(value) {
    if (value === this.videoStatus) return;
    if (this.status !== VoiceStatus.CONNECTED) return;
    this.videoStatus = value;
    if (!value) {
      this.sockets.ws
        .sendPacket({
          op: VoiceOpcodes.SOURCES,
          d: {
            audio_ssrc: this.authentication.ssrc,
            video_ssrc: 0,
            rtx_ssrc: 0,
            streams: [],
          },
        })
        .catch(e => {
          this.emit('debug', e);
        });
    } else {
      this.sockets.ws
        .sendPacket({
          op: VoiceOpcodes.SOURCES,
          d: {
            audio_ssrc: this.authentication.ssrc,
            video_ssrc: this.authentication.ssrc + 1,
            rtx_ssrc: this.authentication.ssrc + 2,
            streams: [
              {
                type: 'video',
                rid: '100',
                ssrc: this.authentication.ssrc + 1,
                active: true,
                quality: 100,
                rtx_ssrc: this.authentication.ssrc + 2,
                max_bitrate: 8000000,
                max_framerate: 60,
                max_resolution: {
                  type: 'source',
                  width: 0,
                  height: 0,
                },
              },
            ],
          },
        })
        .catch(e => {
          this.emit('debug', e);
        });
    }
  }

  /**
   * The voice state of this connection
   * @type {?VoiceState}
   */
  get voice() {
    return this.client.user.voice;
  }

  /**
   * Sends a request to the main gateway to join a voice channel.
   * @param {Object} [options] The options to provide
   * @returns {Promise<Shard>}
   * @private
   */
  sendVoiceStateUpdate(options = {}) {
    options = Util.mergeDefault(
      {
        guild_id: this.channel.guild?.id || null,
        channel_id: this.channel.id,
        self_mute: this.voice ? this.voice.selfMute : false,
        self_deaf: this.voice ? this.voice.selfDeaf : false,
        self_video: this.voice ? this.voice.selfVideo : false,
        flags: 2,
      },
      options,
    );

    this.emit('debug', `Sending voice state update: ${JSON.stringify(options)}`);

    this._pendingVoiceState?.cancel();
    let settle;
    const pending = { promise: new Promise(resolve => (settle = resolve)) };
    const finish = acknowledged => {
      clearTimeout(pending.timer);
      this.client.removeListener('raw', onState);
      if (this._pendingVoiceState === pending) this._pendingVoiceState = null;
      settle(acknowledged);
    };
    const onState = packet => {
      if (packet?.t !== 'VOICE_STATE_UPDATE' || packet.d?.user_id !== this.client.user?.id) return;
      if (!['channel_id', 'self_mute', 'self_deaf', 'self_video'].every(key => packet.d[key] === options[key])) return;
      finish(true);
    };
    pending.cancel = () => finish(false);
    pending.timer = setTimeout(pending.cancel, 15_000).unref();
    this._pendingVoiceState = pending;
    this.client.on('raw', onState);

    try {
      return Promise.resolve(this.channel.client.ws.broadcast({ op: Opcodes.VOICE_STATE_UPDATE, d: options })).catch(
        error => {
          pending.cancel();
          throw error;
        },
      );
    } catch (error) {
      pending.cancel();
      throw error;
    }
  }

  /**
   * Set the token and endpoint required to connect to the voice servers.
   * @param {string} token The voice token
   * @param {string} endpoint The voice endpoint
   * @returns {void}
   * @private
   */
  setTokenAndEndpoint(token, endpoint) {
    this.emit('debug', `Voice endpoint "${endpoint}" updated`);
    if (!endpoint) {
      // Signifies awaiting endpoint stage
      return;
    }

    if (!token) {
      this.authenticateFailed('VOICE_TOKEN_ABSENT');
      return;
    }

    endpoint = endpoint.replace(/^wss?:\/\//, '').replace(/\/$/, '');
    this.emit('debug', `Endpoint resolved as ${endpoint}`);

    if (!endpoint) {
      this.authenticateFailed('VOICE_INVALID_ENDPOINT');
      return;
    }

    if (this.status === VoiceStatus.AUTHENTICATING) {
      this.authentication.token = token;
      this.authentication.endpoint = endpoint;
      this.checkAuthenticated();
    } else if (token !== this.authentication.token || endpoint !== this.authentication.endpoint) {
      this.reconnect(token, endpoint);
    }
  }

  /**
   * Sets the Session ID for the connection.
   * @param {string} sessionId The voice session ID
   * @private
   */
  setSessionId(sessionId) {
    this.emit('debug', `Setting sessionId ${sessionId} (stored as "${this.authentication.sessionId}")`);
    if (!sessionId) {
      this.authenticateFailed('VOICE_SESSION_ABSENT');
      return;
    }

    if (this.status === VoiceStatus.AUTHENTICATING) {
      this.authentication.sessionId = sessionId;
      this.checkAuthenticated();
    } else if (sessionId !== this.authentication.sessionId) {
      this.authentication.sessionId = sessionId;
      /**
       * Emitted when a new session ID is received.
       * @event VoiceConnection#newSession
       * @private
       */
      this.emit('newSession', sessionId);
    }
  }

  /**
   * Checks whether the voice connection is authenticated.
   * @private
   */
  checkAuthenticated() {
    const { token, endpoint, sessionId } = this.authentication;
    this.emit('debug', `Authenticated with sessionId ${sessionId}`);
    if (token && endpoint && sessionId) {
      this.status = VoiceStatus.CONNECTING;
      /**
       * Emitted when we successfully initiate a voice connection.
       * @event VoiceConnection#authenticated
       */
      this.emit('authenticated');
      this.connect();
    }
  }

  /**
   * Invoked when we fail to initiate a voice connection.
   * @param {string} reason The reason for failure
   * @private
   */
  authenticateFailed(reason) {
    clearTimeout(this.connectTimeout);
    this.emit('debug', `Authenticate failed - ${reason}`);
    if (this.status === VoiceStatus.AUTHENTICATING) {
      /**
       * Emitted when we fail to initiate a voice connection.
       * @event VoiceConnection#failed
       * @param {Error} error The encountered error
       */
      this.emit('failed', new Error(reason));
    } else {
      /**
       * Emitted whenever the connection encounters an error.
       * @event VoiceConnection#error
       * @param {Error} error The encountered error
       */
      this.emit('error', new Error(reason));
    }
    this.status = VoiceStatus.DISCONNECTED;
  }

  /**
   * Move to a different voice channel in the same guild.
   * @param {VoiceChannel} channel The channel to move to
   * @private
   */
  updateChannel(channel) {
    this.channel = channel;
    this.sendVoiceStateUpdate();
  }

  /**
   * Attempts to authenticate to the voice server.
   * @param {Object} options Join config
   * @private
   */
  authenticate(options = {}) {
    this.sendVoiceStateUpdate(options);
    this.connectTimeout = setTimeout(() => this.authenticateFailed('VOICE_CONNECTION_TIMEOUT'), 15_000).unref();
  }

  /**
   * Attempts to reconnect to the voice server (typically after a region change).
   * @param {string} token The voice token
   * @param {string} endpoint The voice endpoint
   * @private
   */
  reconnect(token, endpoint) {
    this.authentication.token = token;
    this.authentication.endpoint = endpoint;
    this.speaking = new Speaking().freeze();
    this.status = VoiceStatus.RECONNECTING;
    this.emit('debug', `Reconnecting to ${endpoint}`);
    /**
     * Emitted when the voice connection is reconnecting (typically after a region change).
     * @event VoiceConnection#reconnecting
     */
    this.emit('reconnecting');
    this.connect();
  }

  /**
   * Disconnects the voice connection, causing a disconnect and closing event to be emitted.
   */
  disconnect() {
    this.emit('closing');
    this.emit('debug', 'disconnect() triggered');
    clearTimeout(this.connectTimeout);
    const conn = this.voiceManager.connection;
    if (conn === this) this.voiceManager.connection = null;
    this.sendVoiceStateUpdate({
      channel_id: null,
    });
    this._disconnect();
  }

  /**
   * Internally disconnects (doesn't send disconnect packet).
   * @private
   */
  _disconnect() {
    this.cleanup();
    this.status = VoiceStatus.DISCONNECTED;
    /**
     * Emitted when the voice connection disconnects.
     * @event VoiceConnection#disconnect
     */
    this.emit('disconnect');
  }

  /**
   * Cleans up after disconnect.
   * @private
   */
  cleanup() {
    this._pendingVoiceState?.cancel();
    if (!this.voiceConnection) {
      this.streamConnection?.disconnect();
      for (const stream of this.streamWatchConnection.values()) stream.disconnect();
    }
    this.player.destroy();
    this.speaking = new Speaking().freeze();
    const { ws, udp } = this.sockets;

    this.emit('debug', 'Connection clean up');

    if (ws) {
      ws.removeAllListeners('error');
      ws.removeAllListeners('ready');
      ws.removeAllListeners('sessionDescription');
      ws.removeAllListeners('speaking');
      ws.shutdown();
    }

    if (udp) {
      udp.shutdown();
      udp.removeAllListeners('error');
    }
    this.receiver?.packets?.destroyAllStream();

    this.sockets.ws = null;
    this.sockets.udp = null;
  }

  /**
   * Connect the voice connection.
   * @private
   */
  connect() {
    this.emit('debug', `Connect triggered`);
    if (this.status !== VoiceStatus.RECONNECTING) {
      if (this.sockets.ws) throw new Error('WS_CONNECTION_EXISTS');
      if (this.sockets.udp) throw new Error('UDP_CONNECTION_EXISTS');
    }

    if (this.sockets.ws) this.sockets.ws.shutdown();
    if (this.sockets.udp) this.sockets.udp.shutdown();

    this.sockets.ws = new VoiceWebSocket(this);
    this.sockets.udp = new VoiceUDP(this);

    const { ws, udp } = this.sockets;

    ws.on('debug', msg => this.emit('debug', msg));
    udp.on('debug', msg => this.emit('debug', msg));
    ws.on('error', err => this.emit('error', err));
    udp.on('error', err => this.emit('error', err));
    ws.on('ready', this.onReady.bind(this));
    ws.on('sessionDescription', this.onSessionDescription.bind(this));
    ws.on('startSpeaking', this.onStartSpeaking.bind(this));
    ws.on('startStreaming', this.onStartStreaming.bind(this));

    this.sockets.ws.connect();
  }

  /**
   * Invoked when the voice websocket is ready.
   * @param {Object} data The received data
   * @private
   */
  onReady(data) {
    Object.assign(this.authentication, data);
    for (let mode of data.modes) {
      if (SUPPORTED_MODES.includes(mode)) {
        this.authentication.mode = mode;
        this.emit('debug', `Selecting the ${mode} mode`);
        break;
      }
    }
    this.sockets.udp.createUDPSocket(data.ip);
  }

  /**
   * Invoked when a session description is received.
   * @param {Object} data The received data
   * @private
   */
  onSessionDescription(data) {
    this._mediaRecovery?.reset();
    for (const jitter of this.receiver.packets.audioJitters.values()) jitter.reset();
    this.receiver.packets.audioJitters.clear();
    Object.assign(this.authentication, data);
    this.status = VoiceStatus.CONNECTED;
    const ready = () => {
      clearTimeout(this.connectTimeout);
      this.emit('debug', 'Voice transport ready');
      /**
       * Emitted once the connection is ready, when a promise to join a voice channel resolves,
       * the connection will already be ready.
       * @event VoiceConnection#ready
       */
      this.emit('ready');
    };
    if (this.dispatcher || this.videoDispatcher) {
      ready();
    } else {
      // This serves to provide support for voice receive, sending audio is required to receive it.
      const dispatcher = this.playAudio(new SingleSilence(), { type: 'opus', volume: false });
      dispatcher.once('finish', ready);
    }
  }

  onStartSpeaking({ user_id, ssrc, speaking }) {
    this.ssrcMap.set(+ssrc, {
      ...(this.ssrcMap.get(+ssrc) || {}),
      userId: user_id,
      speaking: speaking,
    });
  }

  onStartStreaming({ video_ssrc, user_id, audio_ssrc, rtx_ssrc, streams = [] }) {
    const layers = streams.length
      ? streams.filter(stream => stream.active !== false)
      : [{ ssrc: video_ssrc, rtx_ssrc }];
    const retained = new Set(layers.flatMap(layer => [+layer.ssrc, +layer.rtx_ssrc]).filter(Boolean));
    for (const [ssrc, info] of this.ssrcMap) {
      if (info.userId === user_id && ['video', 'video-rtx'].includes(info.kind) && !retained.has(ssrc)) {
        this.ssrcMap.delete(ssrc);
        this.receiver.packets.forgetSource(ssrc);
      }
    }
    this.ssrcMap.set(+audio_ssrc, {
      ...(this.ssrcMap.get(+audio_ssrc) || {}),
      userId: user_id,
      hasVideo: Boolean(video_ssrc), // Maybe ?
    });
    for (const layer of layers) {
      if (!layer.ssrc) continue;
      this.ssrcMap.set(+layer.ssrc, { userId: user_id, hasVideo: true, kind: 'video' });
      if (layer.rtx_ssrc) {
        this.ssrcMap.set(+layer.rtx_ssrc, {
          userId: user_id,
          hasVideo: true,
          kind: 'video-rtx',
          primarySsrc: +layer.ssrc,
        });
      }
    }
    this.receiver?._updateVideoSubscriptions();
    /**
{
  video_ssrc: 0,
  user_id: 'uid',
  streams: [
    {
      ssrc: 27734,
      rtx_ssrc: 27735,
      rid: '100',
      quality: 100,
      max_resolution: { width: 0, type: 'source', height: 0 },,
      max_framerate: 60,
      active: false
    }
  ],
  audio_ssrc: 27733
}
     */
  }

  /**
   * Invoked when a speaking event is received.
   * @param {Object} data The received data
   * @private
   */
  onSpeaking({ user_id, speaking }) {
    speaking = new Speaking(speaking).freeze();
    const guild = this.channel.guild;
    const user = this.client.users.cache.get(user_id);
    const old = this._speaking.get(user_id) || new Speaking(0).freeze();
    this._speaking.set(user_id, speaking);
    /**
     * Emitted whenever a user changes speaking state.
     * @event VoiceConnection#speaking
     * @param {User} user The user that has changed speaking state
     * @param {Readonly<Speaking>} speaking The speaking state of the user
     */
    if (this.status === VoiceStatus.CONNECTED) {
      this.emit('speaking', user, speaking);
      if (!speaking.has(Speaking.FLAGS.SPEAKING)) {
        this.receiver.packets._stoppedSpeaking(user_id);
      }
    }

    if (guild && user && !speaking.equals(old)) {
      const member = guild.members.cache.get(user);
      if (member) {
        /**
         * Emitted once a guild member changes speaking state.
         * @event Client#guildMemberSpeaking
         * @param {GuildMember} member The member that started/stopped speaking
         * @param {Readonly<Speaking>} speaking The speaking state of the member
         */
        this.client.emit(Events.GUILD_MEMBER_SPEAKING, member, speaking);
      }
    }
  }

  playAudio() {}
  playVideo() {}

  /**
   * Create new connection to screenshare stream
   * @returns {Promise<StreamConnection>}
   */
  createStreamConnection() {
    if (this.streamConnection?._readyPromise) return this.streamConnection._readyPromise;
    let created;
    // eslint-disable-next-line consistent-return
    const pending = new Promise((resolve, reject) => {
      if (this.streamConnection) {
        return resolve(this.streamConnection);
      } else {
        const connection = (this.streamConnection = new StreamConnection(this.voiceManager, this.channel, this));
        created = connection;
        connection.setVideoCodec(this.videoCodec); // Sync :?
        // Setup event...
        if (!this.eventHook) {
          this.eventHook = true; // Dont listen this event two times :/
          const onStreamPacket = packet => {
            if (typeof packet !== 'object' || !packet.t || !packet.d || !packet.d?.stream_key) {
              return;
            }
            const { t: event, d: data } = packet;
            const StreamKey = parseStreamKey(data.stream_key);
            if (
              StreamKey.userId === this.channel.client.user.id &&
              this.channel.id == StreamKey.channelId &&
              this.streamConnection
            ) {
              // Current user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  this.streamConnection.serverId = data.rtc_server_id;
                  this.streamConnection.setSessionId(this.authentication.sessionId);
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  this.streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  this.streamConnection.disconnect();
                  break;
                }
                case 'STREAM_UPDATE': {
                  this.streamConnection.update(data);
                  break;
                }
              }
            }
            if (this.streamWatchConnection.has(StreamKey.userId) && this.channel.id == StreamKey.channelId) {
              const streamConnection = this.streamWatchConnection.get(StreamKey.userId);
              // Watch user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  streamConnection.serverId = data.rtc_server_id;
                  streamConnection.setSessionId(this.authentication.sessionId);
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  streamConnection.disconnect();
                  streamConnection.receiver.packets.destroyAllStream();
                  break;
                }
                case 'STREAM_UPDATE': {
                  streamConnection.update(data);
                  break;
                }
              }
            }
          };
          this.channel.client.on('raw', onStreamPacket);
          this.once('disconnect', () => {
            this.channel.client.removeListener('raw', onStreamPacket);
            this.eventHook = false;
          });
        }

        connection.on('debug', msg =>
          this.channel.client.emit(
            'debug',
            `[VOICE STREAM (${this.channel.guild?.id || this.channel.id}:${connection.status})]: ${msg}`,
          ),
        );
        connection.once('failed', reason => {
          this.streamConnection = null;
          reject(reason);
          connection.disconnect();
        });

        const onError = error => {
          reject(error);
          connection.disconnect();
        };
        connection.on('error', onError);

        connection.once('ready', () => {
          clearTimeout(connection.connectTimeout);
          resolve(connection);
          connection.removeListener('error', onError);
        });
        connection.once('disconnect', () => {
          clearTimeout(connection.connectTimeout);
          this.streamConnection = null;
          reject(new Error('VOICE_STREAM_DISCONNECTED'));
        });
        connection.connectTimeout = setTimeout(
          () => connection.authenticateFailed('VOICE_CONNECTION_TIMEOUT'),
          15_000,
        ).unref();
        const start = () => {
          if (connection.status === VoiceStatus.DISCONNECTED) return;
          connection.sendSignalScreenshare();
          connection.sendScreenshareState(false);
        };
        // Wait for an in-flight camera/voice change before creating a stream: a late
        // camera-off update can otherwise cancel the newly created stream server-side.
        if (this._pendingVoiceState) {
          this._pendingVoiceState.promise.then(acknowledged => {
            if (acknowledged) {
              start();
            } else if (connection.status !== VoiceStatus.DISCONNECTED) {
              connection.authenticateFailed('VOICE_CONNECTION_TIMEOUT');
            }
          });
        } else {
          start();
        }
      }
    });
    if (created) created._readyPromise = pending;
    return pending;
  }

  /**
   * Watch user stream
   * @param {UserResolvable} user Discord user
   * @returns {Promise<StreamConnectionReadonly>}
   */
  async joinStreamConnection(user) {
    const userId = this.client.users.resolveId(user);
    // Check if user is streaming
    if (!userId) {
      throw new Error('VOICE_USER_MISSING');
    }
    const voiceState = this.channel.guild?.voiceStates.cache.get(userId) || this.client.voiceStates.cache.get(userId);
    if (!voiceState || !voiceState.streaming) {
      throw new Error('VOICE_USER_NOT_STREAMING');
    }
    if (this.streamWatchConnection.get(userId)?._readyPromise) {
      return this.streamWatchConnection.get(userId)._readyPromise;
    }
    let created;
    // eslint-disable-next-line consistent-return
    const pending = new Promise((resolve, reject) => {
      if (this.streamWatchConnection.has(userId)) {
        return resolve(this.streamWatchConnection.get(userId));
      } else {
        const connection = new StreamConnectionReadonly(this.voiceManager, this.channel, this, userId);
        created = connection;
        this.streamWatchConnection.set(userId, connection);
        connection.setVideoCodec(this.videoCodec);
        // Setup event...
        if (!this.eventHook) {
          this.eventHook = true; // Dont listen this event two times :/
          const onStreamPacket = packet => {
            if (typeof packet !== 'object' || !packet.t || !packet.d || !packet.d?.stream_key) {
              return;
            }
            const { t: event, d: data } = packet;
            const StreamKey = parseStreamKey(data.stream_key);
            if (
              StreamKey.userId === this.channel.client.user.id &&
              this.channel.id == StreamKey.channelId &&
              this.streamConnection
            ) {
              // Current user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  this.streamConnection.serverId = data.rtc_server_id;
                  this.streamConnection.setSessionId(this.authentication.sessionId);
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  this.streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  this.streamConnection.disconnect();
                  break;
                }
                case 'STREAM_UPDATE': {
                  this.streamConnection.update(data);
                  break;
                }
              }
            }
            if (this.streamWatchConnection.has(StreamKey.userId) && this.channel.id == StreamKey.channelId) {
              const streamConnection = this.streamWatchConnection.get(StreamKey.userId);
              // Watch user stream
              switch (event) {
                case 'STREAM_CREATE': {
                  streamConnection.serverId = data.rtc_server_id;
                  streamConnection.setSessionId(this.authentication.sessionId);
                  break;
                }
                case 'STREAM_SERVER_UPDATE': {
                  streamConnection.setTokenAndEndpoint(data.token, data.endpoint);
                  break;
                }
                case 'STREAM_DELETE': {
                  streamConnection.disconnect();
                  streamConnection.receiver.packets.destroyAllStream();
                  break;
                }
                case 'STREAM_UPDATE': {
                  streamConnection.update(data);
                  break;
                }
              }
            }
          };
          this.channel.client.on('raw', onStreamPacket);
          this.once('disconnect', () => {
            this.channel.client.removeListener('raw', onStreamPacket);
            this.eventHook = false;
          });
        }

        connection.on('debug', msg =>
          this.channel.client.emit(
            'debug',
            `[VOICE STREAM WATCH (${userId}>${this.channel.guild?.id || this.channel.id}:${
              connection.status
            })]: ${msg}`,
          ),
        );
        connection.once('failed', reason => {
          this.streamWatchConnection.delete(userId);
          reject(reason);
          connection.disconnect();
        });

        const onError = error => {
          reject(error);
          connection.disconnect();
        };
        connection.on('error', onError);

        connection.once('ready', () => {
          clearTimeout(connection.connectTimeout);
          resolve(connection);
          connection.removeListener('error', onError);
        });
        connection.once('disconnect', () => {
          clearTimeout(connection.connectTimeout);
          this.streamWatchConnection.delete(userId);
          reject(new Error('VOICE_STREAM_DISCONNECTED'));
        });
        connection.connectTimeout = setTimeout(
          () => connection.authenticateFailed('VOICE_CONNECTION_TIMEOUT'),
          15_000,
        ).unref();
        connection.sendSignalScreenshare();
      }
    });
    if (created) created._readyPromise = pending;
    return pending;
  }

  /**
   * @event VoiceConnection#streamUpdate
   * @description Emitted when the StreamConnection or StreamConnectionReadonly
   * state changes, providing the previous and current stream state.
   *
   * @param {StreamState} oldData - The previous state of the stream.
   * @param {StreamState} newData - The current state of the stream.
   *
   * @typedef {Object} StreamState
   * @property {boolean} isPaused - Indicates whether the stream is currently paused.
   * @property {string|null} region - The region where the stream is hosted, or null if not specified.
   * @property {Snowflake[]} viewerIds - An array of Snowflake IDs representing the viewers connected to the stream.
   */
}

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => connection.createStreamConnection())
 *    .then(connection => {
 *
 *   });
 * ```
 * @extends {VoiceConnection}
 */
class StreamConnection extends VoiceConnection {
  #requestDisconnect = false;
  /**
   * @param {ClientVoiceManager} voiceManager Voice manager
   * @param {Channel} channel any channel (joinable)
   * @param {VoiceConnection} voiceConnection parent
   */
  constructor(voiceManager, channel, voiceConnection) {
    super(voiceManager, channel);

    /**
     * Current voice connection
     * @type {VoiceConnection}
     */
    this.voiceConnection = voiceConnection;

    Object.defineProperty(this, 'voiceConnection', {
      value: voiceConnection,
      writable: false,
    });

    /**
     * Server Id
     * @type {string | null}
     */
    this.serverId = null;

    /**
     * Stream state
     * @type {boolean | null}
     */
    this.isPaused = null;

    /**
     * Viewer IDs
     * @type {Snowflake[]}
     */
    this.viewerIds = [];

    /**
     * Voice region name
     * @type {string | null}
     */
    this.region = null;
  }

  createStreamConnection() {
    return Promise.resolve(this);
  }

  joinStreamConnection() {
    throw new Error('STREAM_CANNOT_JOIN');
  }

  get streamConnection() {
    return this;
  }

  set streamConnection(value) {
    // Why ?
  }

  get streamWatchConnection() {
    return new Collection();
  }

  set streamWatchConnection(value) {
    // Why ?
  }

  disconnect() {
    if (this.#requestDisconnect) return;
    this.emit('closing');
    this.emit('debug', 'Stream: disconnect() triggered');
    clearTimeout(this.connectTimeout);
    if (this.voiceConnection.streamConnection === this) this.voiceConnection.streamConnection = null;
    this.sendStopScreenshare();
    this._disconnect();
  }

  /**
   * Create new stream connection (WS packet)
   * @returns {void}
   */
  sendSignalScreenshare() {
    const data = {
      type: ['DM', 'GROUP_DM'].includes(this.channel.type) ? 'call' : 'guild',
      guild_id: this.channel.guild?.id || null,
      channel_id: this.channel.id,
      preferred_region: null,
    };
    this.emit('debug', `Signal Stream: ${JSON.stringify(data)}`);
    return this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_CREATE,
      d: data,
    });
  }

  /**
   * Send screenshare state... (WS)
   * @param {boolean} isPaused screenshare paused ?
   * @returns {void}
   */
  sendScreenshareState(isPaused = false) {
    if (isPaused == this.isPaused) return;
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds,
      },
      {
        isPaused,
        region: this.region,
        viewerIds: this.viewerIds,
      },
    );
    this.isPaused = isPaused;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_SET_PAUSED,
      d: {
        stream_key: this.streamKey,
        paused: isPaused,
      },
    });
  }

  /**
   * Stop screenshare, delete this connection (WS)
   * @returns {void}
   * @private Using StreamConnection#disconnect()
   */
  sendStopScreenshare() {
    this.#requestDisconnect = true;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_DELETE,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  update(data) {
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds.slice(),
      },
      {
        isPaused: data.paused,
        region: data.region,
        viewerIds: data.viewer_ids,
      },
    );
    this.viewerIds = data.viewer_ids;
    this.region = data.region;
    this.isPaused = data.paused;
  }

  /**
   * Current stream key
   * @type {string}
   */
  get streamKey() {
    return `${['DM', 'GROUP_DM'].includes(this.channel.type) ? 'call' : `guild:${this.channel.guild.id}`}:${
      this.channel.id
    }:${this.channel.client.user.id}`;
  }
}

/**
 * Represents a connection to a guild's voice server.
 * ```js
 * // Obtained using:
 * client.voice.joinChannel(channel)
 *   .then(connection => connection.createStreamConnection())
 *    .then(connection => {
 *
 *   });
 * ```
 * @extends {VoiceConnection}
 */
class StreamConnectionReadonly extends VoiceConnection {
  #requestDisconnect = false;
  /**
   * @param {ClientVoiceManager} voiceManager Voice manager
   * @param {Channel} channel any channel (joinable)
   * @param {VoiceConnection} voiceConnection parent
   * @param {Snowflake} userId User ID
   */
  constructor(voiceManager, channel, voiceConnection, userId) {
    super(voiceManager, channel);

    /**
     * Current voice connection
     * @type {VoiceConnection}
     */
    this.voiceConnection = voiceConnection;

    /**
     * User ID (who started the stream)
     * @type {Snowflake}
     */
    this.userId = userId;

    Object.defineProperty(this, 'voiceConnection', {
      value: voiceConnection,
      writable: false,
    });

    /**
     * Server Id
     * @type {string | null}
     */
    this.serverId = null;

    /**
     * Stream state
     * @type {boolean}
     */
    this.isPaused = false;

    /**
     * Viewer IDs
     * @type {Snowflake[]}
     */
    this.viewerIds = [];

    /**
     * Voice region name
     * @type {string | null}
     */
    this.region = null;
  }

  createStreamConnection() {
    throw new Error('STREAM_CONNECTION_READONLY');
  }

  joinStreamConnection() {
    return Promise.resolve(this);
  }

  get streamConnection() {
    return null;
  }

  set streamConnection(value) {
    // Why ?
  }

  get streamWatchConnection() {
    return new Collection();
  }

  set streamWatchConnection(value) {
    // Why ?
  }

  disconnect() {
    if (this.#requestDisconnect) return;
    this.emit('closing');
    this.emit('debug', 'Stream: disconnect() triggered');
    clearTimeout(this.connectTimeout);
    this.voiceConnection.streamWatchConnection.delete(this.userId);
    this.sendStopScreenshare();
    this._disconnect();
  }

  /**
   * Create new stream connection (WS packet)
   * @returns {void}
   */
  sendSignalScreenshare() {
    this.emit('debug', `Signal Stream Watch: ${this.streamKey}`);
    return this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_WATCH,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  /**
   * Stop screenshare, delete this connection (WS)
   * @returns {void}
   * @private Using StreamConnection#disconnect()
   */
  sendStopScreenshare() {
    this.#requestDisconnect = true;
    this.channel.client.ws.broadcast({
      op: Opcodes.STREAM_DELETE,
      d: {
        stream_key: this.streamKey,
      },
    });
  }

  update(data) {
    this.emit(
      'streamUpdate',
      {
        isPaused: this.isPaused,
        region: this.region,
        viewerIds: this.viewerIds.slice(),
      },
      {
        isPaused: data.paused,
        region: data.region,
        viewerIds: data.viewer_ids,
      },
    );
    this.isPaused = data.paused;
    this.viewerIds = data.viewer_ids;
    this.region = data.region;
  }

  /**
   * Current stream key
   * @type {string}
   */
  get streamKey() {
    return `${['DM', 'GROUP_DM'].includes(this.channel.type) ? 'call' : `guild:${this.channel.guild.id}`}:${
      this.channel.id
    }:${this.userId}`;
  }
}

PlayInterface.applyToClass(VoiceConnection);
PlayInterface.applyToClass(StreamConnection);

module.exports = VoiceConnection;
module.exports.StreamConnection = StreamConnection;
module.exports.StreamConnectionReadonly = StreamConnectionReadonly;
