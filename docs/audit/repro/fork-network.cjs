'use strict';

// Bounded offline comparison. Uses real RequestHandler classes with controlled
// Response fixtures. Does not construct a Client or contact a remote service.
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const fork = path.join(root, '.tmp/reference-youtsuho');

function fixtureHandler(sourceRoot, options = {}, token = null) {
  const RequestHandler = require(path.join(sourceRoot, 'src/rest/RequestHandler.js'));
  return new RequestHandler({ client: { token, options: { retryLimit: 1, restTimeOffset: 0, captchaRetryLimit: 3, ...options },
    emit() {}, listenerCount: () => 0 }, globalLimit: Infinity });
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
async function unauthenticated(sourceRoot, accessToken) {
  const handler = fixtureHandler(sourceRoot);
  if (accessToken) handler.manager.client.accessToken = accessToken;
  let calls = 0;
  const request = { method: 'post', path: '/auth/login', route: '/auth/login', options: { auth: false }, retries: 0,
    make: async () => { calls++; return json({ token: 'FAKE_TOKEN_ONLY' }); } };
  try { return { data: await handler.push(request), calls }; }
  catch (error) { return { error: error.message, calls }; }
}
async function solver(sourceRoot) {
  const handler = fixtureHandler(sourceRoot, { captchaSolver: async () => ({ token: 'FAKE_CAPTCHA' }) }, 'FAKE_TOKEN_ONLY');
  let calls = 0;
  let receivedKey;
  const request = { method: 'post', path: '/audit', route: '/audit', options: {}, retries: 0,
    make: async key => {
      calls++;
      if (calls === 1) return json({ captcha_service: 'hcaptcha', captcha_key: ['captcha-required'] }, 400);
      receivedKey = key;
      return json({ success: true });
    } };
  try { return { data: await handler.push(request), calls, receivedKey }; }
  catch (error) { return { error: error.message, calls, receivedKey }; }
}
async function verificationInviteCode(sourceRoot) {
  const source = fs.readFileSync(path.join(sourceRoot, 'src/client/Client.js'), 'utf8');
  const method = source.slice(source.indexOf('  async acceptInvite('), source.indexOf('  redeemNitro('));
  const acceptInvite = vm.runInNewContext(`({${method}}).acceptInvite`, { DataResolver: { resolveInviteCode: x => x }, Error, Events: { DEBUG: 'debug' } });
  let captured;
  const fakeClient = { user: {}, fetchInvite: async () => ({ guild: { id: 'guild-test', verificationLevel: 'NONE' }, flags: { has: () => false } }),
    guilds: { cache: new Map() }, channels: { cache: new Map() }, emit() {},
    api: { invites: () => ({ post: async () => ({ show_verification_form: true }) }),
      guilds: () => ({ 'member-verification': { get: async opts => { captured = opts.query.invite_code; return { form_fields: [] }; } } }) } };
  await acceptInvite.call(fakeClient, 'offline-invite', { bypassOnboarding: false, bypassVerify: true });
  return captured;
}

async function main() {
  const baselineAuth = await unauthenticated(root);
  const forkAuth = await unauthenticated(fork);
  assert.equal(baselineAuth.calls, 1);
  assert.equal(baselineAuth.data.token, 'FAKE_TOKEN_ONLY');
  assert.equal(forkAuth.calls, 0);
  assert.equal(forkAuth.error, 'TOKEN_MISSING');
  console.log('CONFIRMED FORK REGRESSION: auth:false request with no account token fails before make()');
  const forkAccessToken = await unauthenticated(fork, 'FAKE_ACCESS_TOKEN');
  assert.equal(forkAccessToken.error, 'TOKEN_MISSING');
  assert.equal(forkAccessToken.calls, 0);
  console.log('CONFIRMED FORK REGRESSION: accessToken fallback does not bypass unconditional client.token guard');

  const baselineSolver = await solver(root);
  const forkSolver = await solver(fork);
  assert.equal(baselineSolver.calls, 1);
  assert.match(baselineSolver.error, /slice/);
  assert.equal(forkSolver.calls, 2);
  assert.equal(forkSolver.receivedKey, 'FAKE_CAPTCHA');
  console.log('CONFIRMED FORK IMPROVEMENT: captcha solver result {token: string} is normalized');

  assert.equal(await verificationInviteCode(root), undefined);
  assert.equal(await verificationInviteCode(fork), 'offline-invite');
  console.log('CONFIRMED FORK FIX: verification request sends locally resolved invite code');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
