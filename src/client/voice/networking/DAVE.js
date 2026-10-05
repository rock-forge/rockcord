'use strict';

const { Buffer } = require('node:buffer');
const { VoiceOpcodes: Op } = require('../../../util/Constants');
const { SILENCE_FRAME } = require('../util/Silence');

let native;
const binding = () => (native ??= require('@snazzah/davey'));

// Session flow follows https://daveprotocol.com/. Cryptography belongs to the maintained native binding.
class DAVE {
  constructor(userId, channelId, sendJSON, sendBinary) {
    this.userId = userId;
    this.channelId = channelId;
    this.sendJSON = sendJSON;
    this.sendBinary = sendBinary;
    this.version = 0;
    this.targetVersion = 0;
    this.negotiated = false;
    this.closed = false;
    this.blocked = true;
    this.pending = new Map();
    this.clients = new Set([userId]);
    this.failures = 0;
  }

  static get maxVersion() {
    return binding().DAVE_PROTOCOL_VERSION;
  }

  validateVersion(version) {
    if (!Number.isInteger(version) || version < 0 || version > DAVE.maxVersion) {
      const error = new Error(`Unsupported DAVE protocol version: ${version}`);
      error.code = 'VOICE_DAVE_UNSUPPORTED';
      throw error;
    }
  }

  initialize(version) {
    this.validateVersion(version);
    this.negotiated = true;
    this.version = this.targetVersion = version;
    this.pending.clear();
    this.recovering = false;
    if (version > 0) {
      this.reinit(version);
    } else {
      this.session?.reset();
      this.blocked = false;
    }
  }

  reinit(version = this.targetVersion) {
    this.validateVersion(version);
    this.blocked = true;
    if (!version) return;
    if (this.session) this.session.reinit(version, this.userId, this.channelId);
    else this.session = new (binding().DAVESession)(version, this.userId, this.channelId);
    this.sendBinary(Op.MLS_KEY_PACKAGE, this.session.getSerializedKeyPackage());
  }

  prepare({ transition_id: id, protocol_version: version }) {
    this.validateVersion(version);
    if (!Number.isInteger(id) || id < 0 || id > 65535) throw new RangeError('Invalid DAVE transition ID');
    this.pending.set(id, version);
    this.targetVersion = version;
    // Only an explicit gateway downgrade allows transport-only receive frames.
    if (version === 0) this.session?.setPassthroughMode(true);
    if (id === 0) return this.execute(id);
    if (version === 0 || this.session?.ready) this.signalReady(id);
    return false;
  }

  signalReady(id) {
    this.sendJSON({ op: Op.DAVE_TRANSITION_READY, d: { transition_id: id } });
  }

  execute(id) {
    if (!this.pending.has(id)) return false;
    const upgrading = this.version === 0 && this.pending.get(id) > 0;
    this.version = this.targetVersion = this.pending.get(id);
    this.pending.delete(id);
    this.lastTransition = id;
    this.recovering = false;
    this.blocked = this.version > 0 && !this.session?.ready;
    // When upgrading, expire the explicitly permitted plaintext grace period after ten seconds.
    if (this.version > 0) {
      if (upgrading) this.session?.setPassthroughMode(true);
      this.session?.setPassthroughMode(false, 10);
    }
    return true;
  }

  epoch(data) {
    if (data.epoch !== 1) return;
    this.validateVersion(data.protocol_version);
    this.targetVersion = data.protocol_version;
    this.pending.clear();
    this.reinit(data.protocol_version);
  }

  recover(id) {
    if (this.recovering || this.closed) return;
    this.recovering = true;
    this.failures = 0;
    this.pending.clear();
    this.sendJSON({ op: Op.MLS_INVALID_COMMIT_WELCOME, d: { transition_id: id } });
    this.reinit();
  }

  binary(op, data) {
    if (this.closed || !this.session) return;
    if (op === Op.MLS_EXTERNAL_SENDER) {
      this.session.setExternalSender(data);
    } else if (op === Op.MLS_PROPOSALS) {
      if (data.length < 2 || data[0] > 1) throw new RangeError('Invalid MLS proposals');
      const { commit, welcome } = this.session.processProposals(data[0], data.subarray(1), [...this.clients]);
      if (commit) this.sendBinary(Op.MLS_COMMIT_WELCOME, welcome ? Buffer.concat([commit, welcome]) : commit);
    } else if (op === Op.MLS_ANNOUNCE_COMMIT_TRANSITION || op === Op.MLS_WELCOME) {
      if (data.length < 3) throw new RangeError('Truncated MLS transition');
      const id = data.readUInt16BE(0);
      try {
        if (op === Op.MLS_WELCOME) this.session.processWelcome(data.subarray(2));
        else this.session.processCommit(data.subarray(2));
      } catch {
        this.recover(id);
        return;
      }
      this.pending.set(id, this.targetVersion);
      // The binding switches its sender ratchet while processing a commit. Pause sending until EXECUTE.
      this.blocked = true;
      if (id === 0) this.execute(id);
      else this.signalReady(id);
    }
  }

  encrypt(frame, codec = 'OPUS') {
    if (this.closed || !this.negotiated) return null;
    // The protocol's Opus silence marker is exempt from frame encryption, including while joining.
    if (codec === 'OPUS' && SILENCE_FRAME.equals(frame)) return frame;
    if (this.blocked) return null;
    if (this.version === 0) return frame;
    if (!this.session?.ready) return null;
    const api = binding();
    if (api.Codec[codec] === undefined) throw new RangeError(`Unsupported DAVE codec: ${codec}`);
    return this.session.encrypt(codec === 'OPUS' ? api.MediaType.AUDIO : api.MediaType.VIDEO, api.Codec[codec], frame);
  }

  decrypt(frame, userId, video = false) {
    if (this.closed || !this.negotiated) return null;
    if (!video && SILENCE_FRAME.equals(frame)) return frame;
    if (this.version === 0 && !this.session?.ready) return frame;
    if (!this.session?.ready) return null;
    try {
      const plain = this.session.decrypt(userId, video ? 1 : 0, frame);
      this.failures = 0;
      return plain;
    } catch {
      if (++this.failures >= 36 && !this.pending.size && this.version > 0) this.recover(this.lastTransition ?? 0);
      return null;
    }
  }

  get voicePrivacyCode() {
    return this.version > 0 ? this.session?.voicePrivacyCode || null : null;
  }

  getVerificationCode(userId) {
    if (!this.session?.ready) return Promise.reject(new Error('No active DAVE group'));
    return this.session.getVerificationCode(userId);
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.blocked = true;
    this.session?.reset();
    this.session = null;
    this.pending.clear();
    this.clients.clear();
  }
}

module.exports = DAVE;
