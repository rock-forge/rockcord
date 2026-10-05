# Network/authentication comparison with youtsuho fork

Compared local source snapshots read-only:

- Base: `devrock07/discord.js-selfbot-v13`, commit `bf38318902cea8d0110d638e1dfadc01aec6b7cc`.
- Reference: `youtsuhodev/discord.js-selfbot-youtsuho-v13`, commit `fd66246dfd5750cf2a80e1a25355a093d3cfac7f` (latest shallow checkout when examined).

The reference is not a ready-made reliability fix for this repository. All 10 primary network/auth/client-lifecycle findings remain, and its new event batching and authentication guard introduce regressions. Several small correctness changes are worth adapting independently.

## Verification and scope

`node docs/audit/repro/network.cjs` and `node docs/audit/repro/network.cjs .tmp/reference-youtsuho` both exit 0 and print the same 12 confirmations covering the original 10 findings. The harness accepts an alternate source root; the fork EventBatcher is replaced with a no-op stub only in the inherited lifecycle probes to isolate those unchanged control-flow failures.

`node docs/audit/repro/fork-network.cjs` exits 0 and confirms the new auth:false regression and accessToken fallback exclusion, plus the solver-result normalization improvement and corrected verification invite query. It loads real RequestHandler modules with fake HTTP Responses; it never constructs a Client, starts workers, connects to Discord, uses credentials, or opens proxy traffic.

The root audit additionally provides `node docs/audit/repro/fork-performance.cjs`, which confirms dropped reaction handler processing, ignored worker results, and the removed `crypto.createCipher` call on Node 24. These findings belong to the combined fork audit rather than duplicate network IDs here.

Read the complete diffs for the same 93 assigned source files. Changed files in that scope: RequestHandler, WebSocketManager, WebSocketShard, VOICE_STATE_UPDATE handler, RemoteAuth, and Client. Also read EventBatcher, LazyManagerRegistry, and WorkerManager, which the fork's new Client/gateway path imports. Other REST files, all sharding files, and remaining assigned handlers are unchanged. No live private API behavior or performance improvement was assumed from the fork's claims.

## Inherited findings: none of the 10 is fixed

| Base ID | Finding | Reference status and evidence |
| --- | --- | --- |
| NET-01 | Full gateway account-token debug logging | Still present. `src/client/websocket/WebSocketShard.js:770-775` and `:715/:741`; manager forwards at `WebSocketManager.js:133`. New voice traces do not redact the inherited logs. |
| NET-02 | Retry equality becomes unbounded after CAPTCHA retries | Still present. `src/rest/RequestHandler.js:214` and `:456` use equality; normalized CAPTCHA results still increment the same counter at `:398-399`. |
| NET-03 | First Client's REST proxy is reused by all clients | Still present. `src/rest/APIRequest.js` is byte-equivalent to base: module `agent` at line 9, one-time initialization at 35-47. |
| NET-04 | INVALID_SESSION false after READY has no recovery | Still present. `WebSocketShard.js:471-490`; manager listener at `WebSocketManager.js:234-236` only emits. |
| NET-05 | RemoteAuth destroy no-op and cancel promise unresolved | Still present. `src/util/RemoteAuth.js:303-304` references `this.ws` instead of `#ws`; FINISH-only await at `:276-283`. The QR generation error message change does not repair lifecycle. |
| NET-06 | REST timeout stops at headers, excludes body | Still present. `src/rest/APIRequest.js:139-150` is unchanged. |
| NET-07 | Destroyed manager reconnects on non-1000 close | Still present. `WebSocketManager.js:204` gates destroyed only on 1000; `:281` does not check destroyed. Shard's connection snapshot does not fix manager guards or timers. |
| NET-08 | Fresh GroupDM invite returns boolean | Still present at `src/client/Client.js:806`. Separate `invite_code` query typo is fixed. |
| NET-09 | Clearing friend nickname leaves stale cache | Still present. `src/client/websocket/handlers/RELATIONSHIP_UPDATE.js:25` is unchanged. |
| NET-10 | Child exit strands pending IPC promises/listeners | Still present. All `src/sharding/*.js` are unchanged. |

Deprecated multi-shard API also still conflicts with forcibly assigned shards `[0]` and shardCount `1` at reference `src/client/Client.js:1040-1043`. The DM synchronization loop still sends before sleeping in `READY.js:109-120`.

## New reference bugs or regression risks

### FORK-NET-01 — P1: Unauthenticated password login fails before the HTTP request

**Evidence:** Reference `src/rest/RequestHandler.js:209-213` unconditionally throws when `manager.client.token` is absent, regardless of `request.options.auth`. Client password login intentionally begins without an account token and calls `/auth/login` with `auth: false` (`src/client/Client.js:281-286`). Base `APIRequest.make` requires account authentication only when `options.auth !== false`; RESTManager also supports `client.accessToken` as a fallback (`src/rest/RESTManager.js:37-39`).

**Result:** The offline fixture's base unauthenticated request succeeds with one `make` call; the fork rejects `TOKEN_MISSING` with zero calls. Supplying only an accessToken still rejects. Therefore a fresh `client.passLogin(email, password)` cannot exchange its credentials through this REST layer, and other explicitly unauthenticated requests are blocked unnecessarily. Standalone WebhookClient sets its own token property and should not be claimed as universally broken by this check. Gateway discovery during normal `login(token)` already has a token and is likewise not the demonstrated failure.

**Fix:** Authenticate only requests that need account authentication, using RESTManager's token/accessToken semantics. Mark missing-credential errors nonretryable without applying a global token requirement to public/authentication endpoints. Add offline tests for pre-login auth:false, authenticated token, accessToken-only, and genuinely missing authenticated credentials.

### FORK-NET-02 — P1: Event batching bypasses cache updates and documented events

**Evidence:** Reference `src/client/websocket/WebSocketManager.js:363-378` routes handled packets to EventBatcher, and invokes handlers only if `addEvent` returns false. `src/util/EventBatcher.js:8-15` treats presence/member updates and all reaction mutation events as batchable; `:131-155` returns true. `flush` at `:178-194` emits raw uppercase events via `_emitImmediate` (`:170-172`) instead of dispatching the original packet handlers.

**Impact:** Reactions, member state, and presence caches stop receiving the corresponding updates. Consumers subscribing to documented events such as `messageReactionAdd` receive none from this path; they would need to opt into unrelated raw `MESSAGE_REACTION_ADD` events. Flushing does not repair the missing mutations. This is enabled for every new manager, not an opt-in feature. See root `fork-performance.cjs` for a bounded reproduction with a zero handler invocation count after explicit flush.

**Fix:** Preserve handler execution and state ordering. If batching is desirable, queue full packet-handler callbacks with shard references and run each once in order; emit optional batched telemetry after the normal state transitions. Avoid combining notifications with protocol processing or reordering dependent mutations. Prefer targeted benchmarks before adding complexity.

### FORK-NET-03 — P2: Lazy loading prevents configured background sweepers from starting

**Evidence:** Reference Client calls `_registerLazyManagers` at `src/client/Client.js:120`, registers sweepers as a lazy factory at `:383`, and creates a getter in `_setupLazyManagerGetters` (`:393-416`). Unlike base Client's immediate `new Sweepers`, it does not instantiate configured sweepers during construction/login. Sweepers creates its interval timers only inside its constructor (`src/util/Sweepers.js:42-63`).

**Impact:** An application that sets `options.sweepers` expects periodic cache cleanup, but its timers do not start until the application explicitly accesses `client.sweepers` or calls the deprecated sweepMessages helper. Ordinary event processing does not retrieve sweepers. Configuring cleanup can silently fail to bound cache growth. This is a static control-flow finding; no long-running memory benchmark was performed.

**Fix:** Start configured background lifecycle components eagerly, even if read-only managers are lazy. Add an offline fake-timer test asserting sweepers start from options without a manual getter access.

The new WorkerPool also passes raw Worker objects to callback methods that expect wrapper records, so successful results are ignored until timeouts; the root audit proves this separately. Adding up to four workers per Client before any CPU task is requested has unmeasured overhead, and should not be treated as demonstrated optimization.

## Selected changes worth adapting

1. **Correct invite verification query.** Reference `src/client/Client.js:794` changes `invite_code: this.code` to the locally resolved `code`. The offline comparison captures undefined in base and the supplied `offline-invite` in the reference. Port this small fix together with proper invite return values/cache hydration; it does not repair NET-08 by itself.
2. **Snapshot connection during teardown.** Reference `src/client/websocket/WebSocketShard.js:826-846` captures the connection before closing it and uses that reference for subsequent inspection/termination. This is useful defense against reentrant close callbacks nulling `this.connection`. Keep it with the stronger terminal lifecycle/timer fixes from NET-07 rather than presenting it as complete shutdown repair.
3. **Validate/normalize solver outputs at the adapter boundary.** Reference `src/rest/RequestHandler.js:377-399` accepts string or selected `{data|token|key}` output shapes and rejects non-string output. The controlled `{token: 'FAKE_CAPTCHA'}` fixture succeeds in the reference but throws a `.slice` error in base. Consider a documented adapter contract and matching typings; also reject empty output, redact challenge secrets, and fix independent retry budgets. Do not copy the unconditional token guard surrounding it.
4. **Report QR rendering errors clearly.** Reference `src/util/RemoteAuth.js:320-325` logs an error and returns instead of printing an undefined QR. Prefer emitting an error with a listener/Promise contract, and repair actual QR lifecycle first.

## Changes to redesign before considering a port

- EventBatcher as currently wired changes API semantics and drops required mutations. It is unsuitable to port in its present form.
- Lazy loading can be useful for optional managers, but sweepers, cleanup, circular dependencies, and synchronous getter compatibility need explicit tests. A priority registry does not itself show memory or startup gains.
- Worker pools need corrected task/result correlation, replacement and shutdown lifecycle, supported crypto primitives, and actual workload measurements before being integrated. Eagerly constructing a pool for every Client is not automatically faster.
- Reference OAuth app-install fallback attempts installation even when integration type configuration is absent, whereas base returns false. That is a behavior change, not an established fix; verify supported installation metadata/protocol and keep failure/unsupported states explicit.

Recommended revamp direction remains: stabilize security/privacy and transport state machines first, make changes measurable with offline tests, and selectively adapt small verified fixes. Replacing the project with this fork would retain the audited foundational bugs and import new failure paths.
