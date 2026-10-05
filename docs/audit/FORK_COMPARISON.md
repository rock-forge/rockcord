# Comparison with youtsuho's continuation

Checked `fd66246dfd5750cf2a80e1a25355a093d3cfac7f` (3.7.8, latest commit dated 19 September 2026) against base `bf38318902cea8d0110d638e1dfadc01aec6b7cc` (3.7.1). This is a source-and-offline-test comparison, not a production certification of either project.

**Recommendation:** use the fork as a source of individually reviewed fixes and protocol work. Keep this revamp's own reliability, type and release foundation. A wholesale replacement would retain the tested inherited bugs and import new regressions.

| Area | Useful work in reference | Remaining problem or new regression | Adoption decision |
| --- | --- | --- | --- |
| DAVE voice | Binding, Identify version, binary MLS handling, transitions and audio frame path | Video takes AUDIO/OPUS paths; readiness/transition gating incomplete; old nonce, UDP, timing and cleanup defects remain | Study and repair as a dedicated voice project, then validate interoperability. |
| Voice gateway | Endpoint port preservation, HELLO/Identify sequencing, heartbeat ACK tracking, connection snapshot during synchronous close | Does not repair overall gateway/voice shutdown or session recovery | Port narrowly with lifecycle fixtures. |
| REST/challenges | Normalizes solver result; avoids one retry body mutation | New unconditional token guard blocks `auth:false` pre-login exchange; original unbounded retry and shared proxy bugs remain | Adapt small fixes; correct auth and retries independently. |
| Messaging | Select fields scoped by select type; poll helpers and some typing additions | Original attachment deletion, snapshot cache corruption, pins/poll-voter/Promise/component/reaction bugs remain; partial mentions can now throw | Selective serializer fixes only, with roundtrip and partial-message fixtures. |
| Event batching | Optional batching concept and telemetry | Enabled by default but bypasses packet handlers/cache mutation for batched events | Do not port current implementation. Measure first, preserve processing/order if redesigned. |
| Workers | CPU task API and pool concept | Initial callbacks use wrong worker record, so successful results time out; encryption uses removed Node crypto API; each Client starts threads eagerly | Do not port current implementation. Require correct bounded lifecycle and benchmarks. |
| Lazy managers | Deferred initialization of secondary managers | Configured background sweepers do not start until accessed | Consider only passive optional managers; initialize background services explicitly. |
| Backups | Added export/import capability | Default backup omits emoji/bans but restore clears them; restore races deletions; channel/thread types and valid zero settings lost | Redesign restore semantics and await operations before adoption. |
| Public types | More event signatures in some areas | Thousands of lines removed, leaving missing referenced definitions; 1,035 package declaration diagnostics | Keep/repair the complete base types, then derive types from implemented contracts. |
| Packaging/CI | Fork identity updated; committed pnpm lock | CI still uses floating npm install; publish targets/auth disagree; no runtime tests and empty type tests | Borrow identity clarity, rebuild CI/release around the chosen package manager and registry. |

## Reproduced high-impact regressions

- **Pre-login REST regression:** an `auth:false` credential-exchange fixture succeeds on the base and rejects `TOKEN_MISSING` on the fork without making a request. An accessToken-only client is also wrongly excluded. This does not demonstrate that ordinary WebhookClient sends or token-based gateway discovery are universally broken.
- **Dropped gateway processing:** a reaction packet passes through the fork's manager and batch flush, producing a raw uppercase event but zero packet-handler calls. Presence/member/reaction caches and the usual model events depend on those skipped handlers. The exported BatchEventHandler is never installed by the Client.
- **Ignored worker result:** the initial worker sends a successful task result, but the pool does not settle its promise; the timeout subsequently rejects it. Callback code passes a raw Worker where the handler expects a record holding `currentTask`.
- **Removed crypto call:** the default encryption worker calls `crypto.createCipher`, absent on the tested Node 24 runtime. Its generated IV is also unused by that call; redesign around explicit key/IV ownership and `createCipheriv`/`createDecipheriv`.
- **DAVE video wiring:** a synthetic video payload is passed to `encryptOpus`, while video receiving uses the audio media type. A native negotiated-protocol session that is not ready returns the input unchanged. The transport's existing encryption remains separate; this observation is about missing DAVE frame protection, not proof of plaintext on a real network.
- **Backup data loss/races:** local stubs show excluded emojis being deleted and bans removed, with clearGuild returning while role deletion remains pending. Forum/stage channels serialize as voice, and private-thread restore omits privacy/state fields.
- **Declaration breakage:** both normal type scripts pass, but checking declarations produces 14 total diagnostics on base versus 1,042 on fork. Seven versus 1,035 originate in the respective package declaration file; the remaining seven concern dependency declarations. Missing definitions include `ClientOptions`, `MessageOptions`, `MessageEditOptions`, and many referenced helper types.

Detailed evidence and source locations are in [FORK_NETWORK.md](FORK_NETWORK.md), [FORK_MODELS.md](FORK_MODELS.md), [FORK_VOICE.md](FORK_VOICE.md), and the runnable [fork-performance.cjs](repro/fork-performance.cjs).

## Other changes to reject or rework

`src/index.js:5–11` installs process-wide `unhandledRejection` and `uncaughtException` handlers merely by importing the library. A child-process import check changed each listener count from zero to one. These handlers print errors/promises and can make the host application continue after an uncaught exception. A library should leave process policy to the application, expose errors through documented objects/events, and avoid mandatory console banners.

Reference `package.json` names `@youtsuhodev/discord.js-selfbot-youtsuho-v13` and directs publication to `https://npm.pkg.github.com`, but its release workflow queries/deprecates unscoped upstream `discord.js-selfbot-v13` on npm, configures only npm registry credentials, and still labels publication as npm. README installation also names the unscoped package. Do not copy these release commands into this fork. Derive the name/registry from one reviewed configuration and test authentication/validation without registry mutations.

The reference commits a pnpm lock, but CI calls `npm install` rather than respecting it. Both consumer type-test files are zero bytes; neither package test script runs runtime tests. Non-formatting ESLint rules pass on both; this did not detect the behavioral regressions. The fork was linted with an explicit local configuration because its checkout is nested under the base's ESLint config, preventing parent-config plugin collisions.

## Useful port candidates

Relevant commits to examine, with their original authorship/history retained:

- [`67636a6`](https://github.com/youtsuhodev/discord.js-selfbot-youtsuho-v13/commit/67636a6): DAVE scaffolding and voice event routing. Treat this as integration material requiring the corrections above.
- [`8cc6627`](https://github.com/youtsuhodev/discord.js-selfbot-youtsuho-v13/commit/8cc6627): preserve voice endpoint port and Identify after HELLO.
- [`04a69c9`](https://github.com/youtsuhodev/discord.js-selfbot-youtsuho-v13/commit/04a69c9): guard against a socket reference cleared by synchronous close.
- [`7218e4c`](https://github.com/youtsuhodev/discord.js-selfbot-youtsuho-v13/commit/7218e4c): solver-result normalization and invite-code correctness.
- [`2ed0f4d`](https://github.com/youtsuhodev/discord.js-selfbot-youtsuho-v13/commit/2ed0f4d): examine the retry body-mutation repair separately from the problematic token guard.
- Select-menu type-specific serialization and real upload byte sizes deserve small standalone ports, backed by fixtures.

These are inspected references, not instructions to cherry-pick entire commits blindly. Protocol, state and dependency changes often need coordinated adaptation. Preserve license notices/attribution for reused source.

No performance improvement was measured, no backup was restored, no quest workflow ran, and no real account or voice session was used. The additional managers were screened for correctness and reviewed in selected paths; their undocumented endpoint behavior is not established by this comparison.
