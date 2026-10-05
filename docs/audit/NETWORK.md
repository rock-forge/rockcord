# Network, client lifecycle, remote authentication, and sharding audit

Audit phase only. Runtime source files were not changed. Reviewed 93 assigned JavaScript files: all 7 `src/rest/*.js`, `src/client/Client.js`, `src/client/BaseClient.js`, both gateway manager/shard files, all 78 gateway handler files including their registry, all 3 `src/sharding/*.js`, and `src/util/RemoteAuth.js`. Also read `src/WebSocket.js` and inspected relevant constants/options/proxy helpers.

## Verification

Run `node docs/audit/repro/network.cjs` from the repository root. On Node v24.15.0 it exits 0 and prints 12 confirmations covering the 10 findings below. This harness evaluates the unmodified repository source with controlled CommonJS module stubs, fake event emitters, fake HTTP responses, and fake sockets. It never connects to Discord, opens a real proxy, or uses real credentials. The invite proof extracts the original method body to avoid constructing the full client. Stubbed enum values are internally consistent, rather than tests of third-party enum definitions.

These are executable regression demonstrations, not live service compatibility tests. They establish local control flow, state, privacy, and cleanup failures; they do not establish current acceptance of private Discord endpoints, rate-limit protocols, or QR-auth protocol behavior. No live account, production traffic, stress benchmark, or optional compression binding was tested.

Priorities: P1 = high security/reliability impact in the affected path; P2 = functional or lifecycle bug that should be repaired. These IDs are local to this audit and can be renumbered in the combined report.

## NET-01 — P1: Full account token enters gateway debug logs

**Evidence:** `src/client/websocket/WebSocketShard.js:768-775`; token payload creation at `:713-717` and `:740-744`. `WebSocketManager.debug` forwards the string through the client's debug event at `src/client/websocket/WebSocketManager.js:120-121`.

**Trigger and impact:** Adding a normal `client.on('debug', console.log)` listener exposes the complete IDENTIFY or RESUME token. Both `_send` success and unavailable-connection branches stringify the entire packet. `Client.login` masks one debug message, but the next gateway send defeats that masking. Anyone who receives persisted logs receives usable account credentials. Voice-server packets are independently logged in `src/client/websocket/handlers/VOICE_SERVER_UPDATE.js:4-5`; the voice audit covers that related leak.

**Reproduction result:** A fake open socket and `identifyNew()` with the sentinel `FAKE_TOKEN_ONLY` produce a debug string containing that exact full token.

**Recommended fix:** Emit packet opcode/event and nonsensitive metadata, or run logging through a shared recursive secret redactor. Cover both `_send` branches and other sensitive logging. Never mutate the actual outgoing payload while redacting.

**Regression:** Capture debug while identifying, resuming, and failing to send; assert no account token occurs, while the fake socket still receives the original token. Add the same assertion to voice-token and MFA-code logging.

## NET-02 — P1: REST retry limit becomes unbounded after CAPTCHA retries

**Evidence:** `src/rest/RequestHandler.js:211-217`, `:442-448`, and `:385-386`. `retryLimit` defaults to 1 and `captchaRetryLimit` to 3 in `src/util/Options.js:166` and `:187`.

**Trigger and impact:** The same `request.retries` counter counts CAPTCHA, MFA, network, and server retries. Network and 5xx branches stop only when it is exactly equal to `retryLimit`. Two CAPTCHA retries move it to 2; with a retry limit of 1, subsequent network/5xx failures increase the counter forever and never reach 1. The request monopolizes its route queue and repeatedly retries until an external success or process termination. Fractional/negative limits are also accepted by `_validateOptions`, producing the same equality problem without CAPTCHA.

**Reproduction result:** Two simulated CAPTCHA challenges followed by four simulated network failures and eventual success result in 7 calls and `request.retries === 6`, despite `retryLimit === 1`. The bounded fixture eventually succeeds to avoid an endless test.

**Recommended fix:** Keep separate counters for transport/server, CAPTCHA, and MFA retries. Use `>=` for all upper bounds and validate configured counts as finite nonnegative integers. Preserve the solved challenge context when replaying an otherwise retryable request; current generic recursion drops `captchaKey` and `captchaToken`.

**Regression:** Inject consecutive CAPTCHA challenges followed by repeated network and 503 failures; assert a finite terminal error and release of the next queued request. Verify CAPTCHA retries do not silently consume a distinct transport retry budget.

## NET-03 — P1: First client's proxy settings control every later client

**Evidence:** `src/rest/APIRequest.js:9`, `:34-47`, `:147`. There is one module-scoped `agent`; initialization only examines the first caller's `client.options.http.agent`.

**Trigger and impact:** Two clients in one process configure different REST proxies. Whichever performs a request first determines both clients' dispatcher. If the first is direct, a later client configured to use a proxy sends directly; if the first uses proxy A, later clients configured with B send credentials and traffic through A. This violates client configuration isolation and can disclose traffic to an unintended proxy or cause authentication/network failures. Changing a client's agent later is likewise ineffective.

**Reproduction result:** Requests from fake clients configured with proxy A and proxy B receive the exact same dispatcher object, configured for A.

**Recommended fix:** Own a dispatcher in each RESTManager, constructed from that client's endpoint and agent options. Define an explicit lifecycle for reconfiguration and close/destroy it during client teardown. The current direct dispatcher also hardcodes `https://discord.com`; ensure a custom REST endpoint uses an appropriate origin without assuming every request targets that origin.

**Regression:** Interleave two clients with distinct fake proxy dispatchers, and a direct client; assert each uses its own dispatcher. Verify teardown of one client does not close the other's transport.

## NET-04 — P1: Non-resumable INVALID_SESSION after readiness stalls the gateway

**Evidence:** `src/client/websocket/WebSocketShard.js:471-490`; `src/client/websocket/WebSocketManager.js:222-224`. The temporary listener in `WebSocketShard.connect` is removed after successful readiness (`:211-230`), so initial connection requeue logic no longer applies.

**Trigger and impact:** A READY connection receives opcode 9 with `d: false`. The shard clears its sequence/session and sets RECONNECTING, but sends no new IDENTIFY and does not close the socket. The manager's listener only emits a notification; it does not requeue the shard or call `reconnect`. The account can remain permanently stuck on an open, heartbeating socket. The manager status remains READY, so `Client.isReady()` can still report true while its shard is RECONNECTING.

**Reproduction result:** On a ready fake socket, the packet sends no data and leaves the socket open with the shard RECONNECTING. With the manager's real `createShards` listener registration, the shard queue remains empty after the same event.

**Recommended fix:** Schedule exactly one new identification/reconnect for a non-resumable invalid session and align manager readiness with shard state. Avoid duplicate work with the initial connection promise's rejection path. Keep appropriate protocol delay/backoff in the gateway lifecycle.

**Regression:** Reach READY, deliver both resumable and non-resumable invalid-session packets, and assert recovery happens once, resumes only when valid, and readiness reflects the unavailable shard until recovery.

## NET-05 — P2: RemoteAuth teardown is a no-op, and QR cancellation never settles login

**Evidence:** `src/util/RemoteAuth.js:51`, `:90-97`, `:159-165`, `:276-283`, `:302-305`. HTTP-token failures are additionally swallowed at `:364`.

**Trigger and impact:** The socket lives in private `#ws`, but `destroy()` checks and closes nonexistent public `this.ws`, so it always returns early. Cancellation and successful completion therefore leave the socket open and do not emit CLOSED. Heartbeat timeouts are untracked (`:183-187`). A QR login returned through `connect(client)` waits only for FINISH; cancellation, socket close, errors, and expiration never resolve or reject it. The constructor records expiration but does not enforce it.

**Reproduction result:** `connect()` followed by `destroy()` leaves the fake socket unclosed and emits no `closed` event. Injecting `cancel` into `connect(fakeClient)` leaves its returned promise unsettled.

**Recommended fix:** Close and null `#ws`, track and clear heartbeat/expiration timers, and make teardown idempotent. Give QR login a settle-once completion/cancel/error/close/expiry contract and propagate HTTP-token failures instead of swallowing them. Ensure listeners are installed before connection activity and removed on settlement.

**Regression:** Assert cancellation, explicit destroy, socket error/close, expiration, token fetch failure, and success each settle once, close once, release timers/listeners, and do not invoke client login with an empty token.

## NET-06 — P2: REST request timeout excludes response-body consumption

**Evidence:** `src/rest/APIRequest.js:138-150`; body parsing occurs later in `src/rest/RequestHandler.js:25-28`, `:312-314`, and `:356-359`.

**Trigger and impact:** The timeout is cleared as soon as `fetch` returns its Response, before `res.json()` or `res.arrayBuffer()`. A response can return headers immediately and deliver its body slowly or never finish within `restRequestTimeout`. The route queue remains occupied beyond the configured request deadline. This also applies to error-response JSON and CAPTCHA/MFA parsing.

**Reproduction result:** A 5 ms timeout with immediately returned headers and a 30 ms body succeeds; the attached signal remains un-aborted after the body completes. No network is needed for this control-flow proof.

**Recommended fix:** Scope the request abort/deadline to the complete fetch and body processing, with cleanup only after consumption/cancellation. Make queue/cancellation behavior explicit and release response resources on all retry/error paths. Avoid leaving bodies unread when handling 429 or 5xx responses.

**Regression:** A controlled transport should provide immediate headers and a stalled body; assert rejection near the configured deadline and release of a queued follow-up. Also verify normal bodies clear their deadline and that retry responses are consumed or canceled.

## NET-07 — P2: Destroyed gateway manager can reconnect on a late non-1000 close

**Evidence:** `src/client/websocket/WebSocketManager.js:191-219`, `:268-272`, and `:314-320`; shard shutdown always schedules a close watchdog at `src/client/websocket/WebSocketShard.js:853-860`, whose expiry emits close code 4009 at `:587-620`.

**Trigger and impact:** Manager teardown marks `destroyed = true`, but the close listener checks this flag only for code 1000 and `reconnect()` never checks it. A shutdown handshake can time out, or a late non-1000 close can arrive; it adds the shard back to the queue and creates a connection after `Client.destroy()` has cleared the token. If a socket never acknowledges shutdown, the library's own watchdog supplies that non-1000 close. `readyTimeout` is also not cleared in the shard's destroy routine, permitting late readiness callbacks.

**Reproduction result:** Attach listeners with `createShards`, mark the manager READY, call `destroy`, and inject a 4009 close. The fake `createShards` call count increases to 1 while `destroyed === true`.

**Recommended fix:** Guard every close/destroy/reconnect/createShards recovery entry point on the destroyed flag. Clear readiness/heartbeat/rate-limit/close timers during terminal teardown, distinguish terminal teardown from reconnect teardown, and prevent late async completion from reviving the manager.

**Regression:** Destroy a ready manager, simulate delayed close and watchdog expiry, and assert no new shard/socket or ready event. Repeat destroy and delayed close events to verify idempotence.

## NET-08 — P2: Fresh group-DM invite acceptance returns a boolean

**Evidence:** `src/client/Client.js:618-624`, `:694-695`; its return contract is documented as a Guild/DMChannel/GroupDMChannel at `:614`.

**Trigger and impact:** An invite joins a group DM that was not already cached. The method ends with `channels.cache.has(...)`, returning true/false instead of a channel object. An already cached invite returns the actual channel, so the public API's type varies with cache state and callers such as `(await client.acceptInvite(code)).send(...)` fail after fresh joins. If the gateway cache update lags the REST response, the boolean is false despite a successful join.

**Reproduction result:** A fake REST response inserts the new channel into the cache; `acceptInvite` returns `true`.

**Recommended fix:** Return a resolved channel object via `cache.get`, add the returned REST channel data when possible, or await/fetch the channel with an explicit timeout if gateway hydration is needed. Address the analogous guild cache race consistently.

**Regression:** Cover already cached group DM, newly joined group DM with REST data, and delayed gateway hydration; every successful result should have the documented channel identity and type.

## NET-09 — P2: Clearing a relationship nickname leaves stale cache data

**Evidence:** `src/client/websocket/handlers/RELATIONSHIP_UPDATE.js:20-26`.

**Trigger and impact:** A `RELATIONSHIP_UPDATE` contains `nickname: null` or an empty string to clear a previously set nickname. The truthiness check skips the update, so `friendNicknames` retains the old value while the emitted event describes the cleared value. Consumers observe inconsistent event/cache state.

**Reproduction result:** Start with `Old nickname`, apply `{ id: 'u1', nickname: null }`, and the cache still contains `Old nickname`.

**Recommended fix:** Check property presence (`'nickname' in data`) and store the nullable value or delete the entry according to the manager's declared contract. Use presence checks consistently for optional patch fields rather than truthiness.

**Regression:** Verify null/empty values clear a nickname, while a packet lacking the nickname field preserves it. Assert event new data agrees with post-update cache state.

## NET-10 — P2: Child exit strands pending shard IPC promises and listeners

**Evidence:** `src/sharding/Shard.js:240-267`, `:280-307`, `:402-414`.

**Trigger and impact:** `fetchClientValue` or `eval` waits for a child response, then the child exits. `_handleExit` clears Maps of promises without rejecting them and without removing their message listeners. Existing callers wait forever; `broadcastEval`/`fetchClientValues` can hang even after the child respawns. Cache clearing is not promise cancellation.

**Reproduction result:** Start a fetch through a fake child emitter, call `_handleExit(false)`, and the returned promise remains unsettled with one `message` listener attached. Eval uses the same pattern.

**Recommended fix:** Represent each in-flight IPC request with resolve/reject and listener cleanup; on death reject all with a shard-exit error, remove listeners, and restore listener limits. Add configurable deadlines and correlation IDs so stale responses cannot complete a new request.

**Regression:** Exit during both property fetch and eval; assert immediate rejection, empty pending maps, no added child listeners, and safe behavior after respawn. Include a child that remains alive but never responds to exercise deadlines.

## Architecture assessment and revamp implications

- Strengths: separate REST request construction, rate-limit scheduling, gateway orchestration, event handlers, and managers make targeted fixes possible without rewriting the entire public API. `RequestHandler.push` uses `try/finally` to release the route queue when execute settles. Cookies are scoped to RESTManager, unlike the dispatcher. Gateway dispatch parsing has a local malformed-payload guard.
- Highest-value revamp: unify connection lifecycle and cancellation, define explicit gateway states, make transport resources client-owned, and introduce a safe observability layer that redacts secrets. Add small offline fixtures for packets, HTTP responses, reconnects, and shutdown; successful login alone does not cover recovery paths.
- Separate transport retries, rate-limit handling, CAPTCHA/MFA recovery, and body decoding so one counter or timeout cannot accidentally govern unrelated state machines. Transport injection would remove the need for CommonJS stubs in tests.
- Deprecated bot-sharding implementation remains exported alongside a Client that forcibly sets shards `[0]` and shardCount `1` (`src/client/Client.js:916-919`). Thus multiple ShardingManager children do not partition gateway work as their API suggests. Decide whether to explicitly reject multi-shard use for this user-client package, remove it in a breaking release, or support a documented separate bot client. Do not mechanically restore bot sharding for a private user gateway.
- `READY.js:109-120` sends every DM subscription before awaiting its index-based sleep, so `DMChannelVoiceStatusSync` does not actually space outgoing sends; it merely delays readiness after the burst. This is an additional static defect, not one of the 10 primary reproduced findings.
- `USER_REQUIRED_ACTION_UPDATE.js:11-33` automatically accepts revised terms and privacy agreements in response to a gateway notification. The revamp should emit a required-action event and leave consent to the application/user rather than silently performing that account change. No such request was made during this audit.
- Other static cleanup needs: RESTManager does not own/close the global dispatcher; QR token fetch bypasses RESTManager's configurable proxy, timeout, and cookie handling; duplicated bot-only/deprecated gateway handlers refer to `client.application` even though this Client never initializes it. Assess retained compatibility features against actual supported behavior.

The assigned scope was fully read, but a file read is not exhaustive verification of every method. Voice encryption/streaming, structures/managers, dependency advisories, package/publish automation, full TypeScript compatibility, and current remote API protocol conformance belong to the parallel audits or later validation.
