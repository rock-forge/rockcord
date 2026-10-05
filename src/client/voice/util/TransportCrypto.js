'use strict';

const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const secretbox = require('./Secretbox');

const states = new WeakMap();

// RTP, RTX and RTCP all share a nonce space for a negotiated session key.
function encrypt(connection, payload, header) {
  const { secret_key: key, mode } = connection.authentication;
  let state = states.get(connection);
  if (!state || !state.key.equals(Buffer.from(key))) {
    state = { key: Buffer.from(key), value: 0 };
    states.set(connection, state);
  }
  if (state.value >= 0xffffffff) throw new RangeError('Voice encryption nonce exhausted; establish a new session key');
  const nonce = Buffer.alloc(mode === 'aead_aes256_gcm_rtpsize' ? 12 : 24);
  nonce.writeUInt32BE(++state.value);
  let ciphertext;
  if (mode === 'aead_aes256_gcm_rtpsize') {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header);
    ciphertext = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  } else if (mode === 'aead_xchacha20_poly1305_rtpsize') {
    ciphertext = Buffer.from(secretbox.methods.crypto_aead_xchacha20poly1305_ietf_encrypt(payload, header, nonce, key));
  } else {
    throw new RangeError(`Unsupported encryption method: ${mode}`);
  }
  return [ciphertext, nonce.subarray(0, 4)];
}

function decrypt(connection, packet, headerSize) {
  const { secret_key: key, mode } = connection.authentication;
  if (!key || packet.length < headerSize + 20) throw new RangeError('Truncated encrypted media packet');
  const header = packet.subarray(0, headerSize);
  const nonce = Buffer.alloc(mode === 'aead_aes256_gcm_rtpsize' ? 12 : 24);
  packet.copy(nonce, 0, packet.length - 4);
  const ciphertext = packet.subarray(headerSize, packet.length - 4);
  let plain;
  if (mode === 'aead_aes256_gcm_rtpsize') {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header);
    cipher.setAuthTag(ciphertext.subarray(-16));
    plain = Buffer.concat([cipher.update(ciphertext.subarray(0, -16)), cipher.final()]);
  } else if (mode === 'aead_xchacha20_poly1305_rtpsize') {
    plain = Buffer.from(secretbox.methods.crypto_aead_xchacha20poly1305_ietf_decrypt(ciphertext, header, nonce, key));
  } else {
    throw new RangeError(`Unsupported decryption method: ${mode}`);
  }
  return Buffer.concat([header, plain]);
}

module.exports = { encrypt, decrypt };
