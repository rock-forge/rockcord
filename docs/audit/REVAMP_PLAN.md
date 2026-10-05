# Revamp plan

The goal is a maintained library whose supported behavior is documented, tested, and consistent across its runtime API and types. Rockcord's local repair candidate includes DAVE, complete pin pagination, runtime/type export parity and warning-free documentation. Completed changes and remaining integration/release work are recorded in [IMPLEMENTATION.md](IMPLEMENTATION.md). The sections below retain the original roadmap; historical findings and evidence are indexed in [README.md](README.md).

## 1. Establish the test and release foundation

- Pick supported Node LTS versions and one package manager. Commit a lockfile and normalize source line endings.
- Add tracked offline runtime tests and real `tsd` usage tests. Turn the audit demonstrations into assertions of correct behavior; their present success means a defect was reproduced, not that the library is healthy.
- Make install/check/docs commands work from a clean checkout; modernize documentation tooling and remove unused legacy checks deliberately.
- Gate release jobs on the tested source and package artifact. Validate package identity/tag/version and stop deprecating before publication.

**Done when:** Windows/Linux and supported Node versions run the same meaningful checks, public-export parity is checked, and failed tests or publication leave previous releases untouched.

## 2. Repair credentials, destructive payloads, and lifecycle state

- Centralize secret-safe logging for account tokens, voice tokens, MFA and authorization payloads.
- Give each client its own HTTP dispatcher and deterministic disposal; apply request deadlines through body consumption.
- Separate transport/challenge retry budgets, use finite validated limits, and release queued requests on cancellation/error.
- Fix invalid-session recovery and prohibit reconnection after destroy. Make QR login settle on success/cancel/error/expiration.
- Repair attachment retention and forwarded-snapshot isolation before expanding messaging features.
- Fix Promise consistency, pins, poll voters, components, reaction reconciliation, partial patches, settings, high user flags and cache limits.

**Done when:** The corresponding behavior tests pass for success, failure, cache hits, omitted/null fields, retries and repeated destruction. No real account is needed for these tests.

## 3. Rebuild the voice boundary around current protocol requirements

Separate transport and authenticated key state from player/codec state. Use a vetted DAVE binding or maintained DAVE-capable voice implementation, with explicit codec support and MLS/transition behavior. The youtsuho fork provides implementation material to examine, but its voice changes require fixes and verification before reuse; see [FORK_COMPARISON.md](FORK_COMPARISON.md).

Share transport nonce allocation across all media dispatchers using the same key. Validate/drop malformed UDP at the boundary. Own WS/UDP/streams/FFmpeg resources in one idempotent lifecycle. Use a monotonic playback clock and tested incremental video parsers; do not wrap scheduling time with RTP sequence counters. Make absent FFmpeg/codecs fail through predictable API errors.

**Done when:** Binary gateway/MLS fixtures, transition/reconnect sequences, unique nonce tests, malformed packet fixtures, randomized video chunk boundaries, simulated long playback and process cleanup pass. A separately authorized live interoperability check is still required to claim tested voice/video compatibility; offline fixtures alone cannot establish it.

## 4. Reduce duplication and make contracts explicit

Keep the existing manager/action/structure separation where useful. Introduce explicit boundaries for HTTP transport, gateway lifecycle, payload serialization, cache patching, and optional voice/media. Centralize upload resolution and retained/new attachment merging. Distinguish immutable historical snapshots from live mutable cache entities.

Define partial patch semantics once: omitted fields preserve existing state; explicit null clears fields where supported; false and zero are meaningful values. Use canonical API fixtures to test round trips. Put account-specific undocumented routes behind clearly labeled feature modules and avoid claiming compatibility based only on copied constants.

Migrate modules to TypeScript incrementally if that is the chosen redesign. Establish the public export manifest first, then derive declarations from source where possible. Preserve a compatibility entrypoint and provide migration examples for intentional breaking changes. Define ESM/CommonJS packaging from tested consumer examples, not as an untested bulk conversion.

**Done when:** Each supported public import exists at runtime, docs/types describe its actual constructor/options/results, and create/edit/forward/cache behavior uses one tested contract per operation.

## 5. Add performance changes only with correctness tests and measurements

Capture startup time, idle memory, cache growth, sustained gateway processing, event-loop lag and active resource counts. Build fixture benchmarks before adding eager worker pools or batching. Keep consumers' cache/event ordering guarantees explicit. Start optional CPU workers only for measured expensive tasks, with correct task-ID correlation, cancellation and termination.

The reference fork's batching and worker changes have reproduced regressions. Repair them in isolation if selected; do not inherit them merely because they are described as optimizations. Do not defer background sweepers in a way that disables configured cleanup.

**Done when:** Benchmarks show an improvement under stated conditions, event/cache results match the unoptimized reference, and idle or destroyed clients retain no extra worker/socket/timer resources.

## 6. Finish the product surface

Update the fork name/registry/source links, feature-support matrix, README quick start, secure configuration examples, contribution guide, security-reporting route, API reference and changelog. Keep optional voice/video and experimental account-specific features visibly scoped. Publish migration notes with the first breaking release.

**Done when:** A new user can install, import, configure and use the supported API using documented examples, and every advertised capability has a meaningful automated check or an explicitly recorded integration limitation.

## Selecting changes from the reference fork

Prefer small reviewed ports of specific fixes, attributed to their original commits. DAVE integration, preserved voice endpoint ports, send-after-HELLO sequencing, and small payload fixes deserve focused review. Preserve the upstream license/attribution when reusing source. The comparison report identifies inherited bugs and new regressions. The fork is a useful reference, not a validated drop-in upgrade.

This order intentionally gives data integrity and reliable foundations precedence over new features. It is a work sequence with acceptance criteria, not a promise that a full protocol rewrite can be completed or proven in one edit.
