'use strict';

const { Buffer } = require('node:buffer');
const { generateKeyPairSync, sign } = require('node:crypto');
const DAVE = require('../src/client/voice/networking/DAVE');
const { VoiceOpcodes: Op } = require('../src/util/Constants');

// Offline delivery-service fixture using RFC 9420 sections 5.1.2 and 6.1.
// All identities and keys are generated/test-only. MLS group cryptography is performed by davey.
function vector(bytes) {
  const prefix = Buffer.alloc(bytes.length < 64 ? 1 : 2);
  if (prefix.length === 1) prefix[0] = bytes.length;
  else prefix.writeUInt16BE(bytes.length | 0x4000);
  return Buffer.concat([prefix, bytes]);
}

function gateway() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const publicBytes = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const external = Buffer.concat([vector(publicBytes), Buffer.from([0, 1]), vector(Buffer.from([0]))]);
  return {
    external,
    proposal(channelId, keyPackage, epoch = 0n) {
      const group = Buffer.alloc(8);
      group.writeBigUInt64BE(BigInt(channelId));
      const epochBytes = Buffer.alloc(8);
      epochBytes.writeBigUInt64BE(epoch);
      const framed = Buffer.concat([vector(group), epochBytes, Buffer.from([2, 0, 0, 0, 0, 0, 2, 0, 1]), keyPackage]);
      const tbs = Buffer.concat([Buffer.from([0, 1, 0, 1]), framed]);
      const signature = sign(
        'sha256',
        Buffer.concat([vector(Buffer.from('MLS 1.0 FramedContentTBS')), vector(tbs)]),
        privateKey,
      );
      return vector(Buffer.concat([tbs, vector(signature)]));
    },
  };
}

function group() {
  const channelId = '100000000000000001';
  const aliceId = '100000000000000002';
  const bobId = '100000000000000003';
  const aliceSent = [];
  const bobSent = [];
  const alice = new DAVE(
    aliceId,
    channelId,
    packet => aliceSent.push(packet),
    (op, payload) => aliceSent.push({ op, payload }),
  );
  const bob = new DAVE(
    bobId,
    channelId,
    packet => bobSent.push(packet),
    (op, payload) => bobSent.push({ op, payload }),
  );
  alice.initialize(1);
  bob.initialize(1);
  alice.clients.add(bobId);
  bob.clients.add(aliceId);
  const service = gateway();
  alice.binary(Op.MLS_EXTERNAL_SENDER, service.external);
  bob.binary(Op.MLS_EXTERNAL_SENDER, service.external);
  const proposal = service.proposal(channelId, bobSent.find(p => p.op === Op.MLS_KEY_PACKAGE).payload);
  const { commit, welcome } = alice.session.processProposals(0, proposal, [...alice.clients]);
  alice.binary(Op.MLS_ANNOUNCE_COMMIT_TRANSITION, Buffer.concat([Buffer.from([0, 1]), commit]));
  bob.binary(Op.MLS_WELCOME, Buffer.concat([Buffer.from([0, 1]), welcome]));
  alice.execute(1);
  bob.execute(1);
  return { alice, bob, aliceId, bobId, channelId, service, aliceSent, bobSent };
}

module.exports = { group, gateway };
