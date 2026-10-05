# Changelog

## Unreleased

- Redesign the README with the Rockcord otter mascot, status badges, a client example, feature cards and links to media options and verification results.
- Review dependency PRs #13 and #14; update development-only globals to 17.13.0 and eslint-import-resolver-node to 0.4.0.

## 4.0.0 — Stable media and dependency repairs

- Add loss-based adaptive video packet pacing: authenticated RTCP receiver reports lower the send rate under loss and allow gradual recovery. NACK feedback provides a fallback; retransmissions share the pacing budget. Queues, timers, retries and rate bounds are finite.
- Record H264, VP8 or H265 with Opus to Matroska files or Writable streams. Preserve the existing H264 default, normalize local RTP sequence startup, and advance VP8 picture IDs.
- Serialize the initial complete encrypted media frame before concurrent audio/video encryption to preserve native DAVE startup nonce ordering. Prevent synchronization deadlocks and cancel startup waits during destruction.
- Give VP8 regular keyframes and disable encoder lookahead. Preserve whole encrypted frames under pacing and stop queued sends when the transport key changes.
- Review all twelve dependency PRs; update compatible tooling, cookies and HTTP transport. Use the synchronous otplib v12 adapter with independent client instances. Require Node 22.19.0 or newer.
- Migrate to ESLint 10 flat configuration, import-x and Prettier 3. Upgrade documentation generation to asynchronous parsing; use jsdoc-to-markdown 8.0.3 because the proposed v9 dependency tree introduces an unpatched advisory.
- Retain Node 22 types, Shapeshift 4, TypeScript 5.9 and opusscript 0.0.8 for existing platform/API/peer compatibility. Group routine Dependabot updates and reduce duplicate CI work.
- Repair group-DM invite code resolution and Samsung presence timer cleanup. Expand regression and real FFmpeg recording checks. See the implementation report for live and platform verification results.

## 4.0.0-dev.5 — Media reliability

- Recreate the public Rock Forge repository with fresh maintainer commit history; retain original source/license credits and a local backup of historical Git data and releases.
- Wait for camera state acknowledgement before starting screen sharing; authenticate the separate stream server correctly regardless of event order.
- Preserve simultaneous audio/video delivery and keep one dispatcher's completion from stopping the other media type.
- Add bounded encrypted NACK feedback, cached video RTX retransmission, and audio reordering with loss padding. RTP, RTX, and RTCP share transport nonces.
- Retain incomplete encrypted frames for late fragments and reject transport probes before DAVE decryption.
- Repair recorder readiness, codec probing, graceful finalization, temporary-file cleanup, and file/Writable output. Add `await recorder.stop()`; recording supports H264 and Opus.
- Negotiate the selected video codec correctly and enable the H265 playback path. Validate FPS before starting FFmpeg.
- Add codec/recording integration checks on Linux, Windows, and macOS, plus opt-in live recording, longer playback, and incoming/outgoing packet-loss scenarios.

## 4.0.0-dev.4 — npm release

- Simplify the README around `npm i rockcord`, remove the quick-start walkthrough, and use absolute links so the banner and project links work on npm.
- Publish `rockcord` publicly on npm with the `latest` install tag; retain the development version designation and grant `rockforge:developers` read-write team access.
- Verify the release archive in a clean consumer, including 203 runtime exports, native DAVE loading, and strict TypeScript checks.

Runtime behavior is unchanged from 4.0.0-dev.3. [The npm package](https://www.npmjs.com/package/rockcord) is listed under the `rockforge` organization. A fresh `npm i rockcord` installation from the registry passed runtime exports, native DAVE initialization and strict TypeScript checks.

## 4.0.0-dev.3 — Organization migration

- Move the standalone repository to [rock-forge/rockcord](https://github.com/rock-forge/rockcord).
- Update package repository, issue, homepage and release installation links to the organization.
- Preserve Git history, the previous prerelease and its archive, source attribution and licensing.

Runtime behavior is unchanged from 4.0.0-dev.2. Screen-share startup and the previously documented verification limits remain unresolved. This candidate is distributed through GitHub releases and has not been published to npm.

## 4.0.0-dev.2 — Live media repairs

- Preserve RTP sequence/timestamps across playback restarts and close replaced UDP sockets on reconnect.
- Preserve H264 emulation-prevention bytes, correct native UDP video extensions, and subscribe receivers to video sources.
- Restore RTX packets to primary video streams; retain overlapping frame assemblies and suppress completed-frame duplicates.
- Use the separate media session identity for screen-share DAVE groups, reject startup disconnects/timeouts, and remove parent gateway listeners on disconnect.
- Redact remaining voice-server token diagnostics.
- Add reusable real FFmpeg and opt-in two-account live media checks.

Live audio both ways, H264 camera video, participant rejoining and forced voice reconnects passed. Separate screen-share startup failed; actual recorder muxing and long-running calls remain unverified. This development candidate is distributed through GitHub; it has not been published to npm.

## 4.0.0-dev.1 — Rockcord development candidate

This candidate is local and unpublished. The GitHub repository is now [rock-forge/rockcord](https://github.com/rock-forge/rockcord), and the npm package identity is `rockcord`. Existing source attribution and license are retained.

- Add native DAVE/MLS negotiation, recognized membership, transition readiness/execution, epoch resets and recovery using `@snazzah/davey`.
- Encrypt audio before RTP transport protection; encrypt complete H264/H265/VP8 frames before fragmentation and reassemble before receive decryption.
- Expose voice privacy codes, peer verification codes and complete plaintext `videoFrame` events.
- Retain bounded video reassembly state when the final fragment arrives first; reject malformed or unauthenticated media and avoid plaintext fallback on encryption errors.
- Fetch every pinned-message page with duplicate elimination and cursor progress checks.
- Replace declaration-only public mixin factories with concrete class/interface declarations and verify runtime class/function exports.
- Remove documentation warnings and disable stale JSDoc cache reuse.
- Add generated, real two-party MLS fixtures and encrypted audio/video dispatcher-to-receiver tests.

Live Discord/FFmpeg interoperability is still unverified. See [implementation status](docs/audit/IMPLEMENTATION.md) for validation and limitations.

## 4.0.0-dev.0 — Initial repair phase

- Repair request deadlines, retries, challenge handling, credential redaction, isolated transports and client destruction.
- Repair gateway/QR/IPC settlement and resource cleanup.
- Repair attachments, snapshots, partial cache updates, reactions, Components V2, flags and public API exports.
- Repair voice nonce allocation, scheduling, receive boundaries, NAL parsing and media process cleanup.
- Establish Node 22/24 checks, a lockfile, strict declaration checks, offline regression tests, documentation builds and package artifact workflows.
