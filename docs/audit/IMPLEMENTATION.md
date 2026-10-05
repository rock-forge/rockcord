# Revamp implementation status

Rockcord stable release: `4.0.0`, based on original commit `bf38318902cea8d0110d638e1dfadc01aec6b7cc`. The standalone repository is [rock-forge/rockcord](https://github.com/rock-forge/rockcord); the package name, repository metadata, examples and documentation use `rockcord`. [Rockcord is published publicly on npm](https://www.npmjs.com/package/rockcord), with `rockforge:developers` granted read-write access. Original attribution and licenses are retained. Historical audit reports describe the original source, not the repaired candidate.

## Implemented

- Independent transport/CAPTCHA/MFA retry budgets; finite input validation; retained challenge context; support for string and `{ token }`/`{ data }` solver results.
- Per-client/per-origin HTTP dispatchers, disposal, aborted pending requests/rate-limit waits, and deadlines through response-body consumption.
- Credential-safe gateway/voice logging and redacted request/error diagnostics, including webhook paths, passwords and authorization headers.
- Non-resumable gateway recovery, serialized shard creation, accurate reconnect readiness, and destruction guards/watchdog cleanup.
- QR login settlement on cancel/error/close/destroy/expiry, socket/timer cleanup, and surfaced token-fetch errors.
- IPC fetch/eval rejection and listener cleanup when the child exits or is killed.
- Attachment retention versus explicit removal, retained/new upload merging, actual byte lengths, shared create/edit/forum upload resolution, correct forum attachment nesting, and no mutation of caller attachment arrays.
- Pin wrapper hydration and complete pagination with deduplication, cache-option preservation and cursor progress checks; poll voter REST routing; Promise consistency for cached fetches; isolated historical snapshots.
- Components V2 public exports, file/media serialization and container color copy/round trips. Existing concrete interaction/manager/voice classes missing from the root entrypoint are now exported. Select-menu types now describe the actual runtime class; absent specialized select/TOTP constructors and the absent public VolumeMixin function are removed.
- Nested select-menu lookup with digit-containing IDs and predictable invalid option errors. Button/menu submission errors reject their interaction promises and release listeners.
- Authoritative reaction refreshes and separate normal/burst state; explicit null decoration/collectible clearing; preservation of partial member state; restricted-guild transactional edits; null custom status clearing; nickname clearing.
- Shared voice transport nonces across audio/video/playback restarts, exhaustion protection, stable packet buffers, monotonic scheduling, correct RTP timestamp wrap, and cancellation of pending audio/video synchronization listeners/timers.
- Authenticated packet rejection without escaping UDP callbacks, sender filtering, discovery bounds checks, recreated manual receive streams and receive/timer cleanup.
- Annex B split start-code handling and final frame flush for H264/H265; valid video extension bytes; voice endpoint ports, HELLO sequencing, heartbeat ACK monitoring and zero sequence updates.
- Idempotent FFmpeg/UDP/output socket cleanup, early destruction and spawn failure handling, dynamic recording ports, and temporary Unix socket paths.
- High numeric flags without 32-bit truncation, limited-cache constructor enforcement, interaction listener cleanup, stream pause state and announcement-channel sorting corrections.
- Node 22/24 support, tracked lockfile/tests, LF checkout policy, strict declaration/consumer checks, modern documentation generator/JSDoc, removal of dtslint/tslint/tsd/patch-package dependencies, read-only checks/builds and package-only release workflow.
- Environment-based example, updated README/contribution guide and offline startup/event/resource benchmark. Original attribution is retained.
- DAVE protocol 1 through the pinned `@snazzah/davey` native binding: binary gateway messages, recognized membership, key packages, proposals, commit/welcome processing, transition readiness/execution, epoch resets and invalid-transition recovery. Unsupported future versions fail explicitly.
- DAVE Opus encryption before RTP transport protection, codec-aware whole-frame H264/H265/VP8 encryption before fragmentation, bounded video reassembly before decryption and plaintext repacketization for recording. Receive handles sequence wrap and a final fragment arriving first. Encryption errors never trigger automatic plaintext fallback; Opus silence and explicit gateway downgrades follow protocol exemptions.
- Voice privacy codes, peer verification codes and a typed `videoFrame` event. Generated two-party MLS fixtures exercise real native cryptography and actual dispatcher-to-receiver RTP pipelines without account credentials.
- Declaration merging replaces four phantom public text-channel/webhook mixin factory exports. Regression checks cover declared public classes and functions; strict consumer tests cover concrete mixin members and DAVE APIs.
- Documentation tag/parent cleanup and disabled stale JSDoc cache reuse; documentation validation/generation runs without warnings.

## Live media repairs

Live tests exposed additional defects: playback reset RTP counters, reconnect replaced UDP sockets without closing them, H264 splitting removed emulation-prevention bytes, native UDP video extensions omitted RID and used the wrong delay ID, receivers did not subscribe to video SSRCs, and RTX packets were not restored to their primary stream. These are repaired. Video assemblies retain overlapping timestamps and suppress already-completed duplicate frames. Remaining voice-server token logging is redacted.

Screen-share DAVE uses its separate media session identity. Camera-off voice-state acknowledgement now precedes STREAM_CREATE, preventing a late update from cancelling the new stream. Server identity is assigned before authentication in either gateway event order. Concurrent startup calls share the pending ready promise; disconnects and 15-second timeouts reject and remove listeners, timers and child connections. Authorized camera-to-screen-share tests now pass.

Video delivery keeps default audio subscriptions enabled. Audio completion no longer disables concurrent video. Transport probes are rejected before DAVE decryption, and repeated video-source announcements preserve in-flight frames. Frame assemblies remain available after failed authentication so late leading fragments can repair them.

Encrypted RTCP generic NACK feedback and RTX retransmission now use bounded caches and retry limits: 512 cached outgoing video packets for up to two seconds; up to 128 missing sequences per source, three feedback attempts, and a 500 ms recovery deadline. RTP, RTX and RTCP share a nonce counter for each negotiated key. Audio has a 40 ms initial playout window with bounded reordering, duplicate rejection, sequence wrap handling and silence padding.

Recorder readiness follows bound RTP ports, not the first FFmpeg log line. SDP probing uses actual parameter sets, idle recording stays open, and RTCP BYE lets FFmpeg drain and finalize its Matroska trailer. `await recorder.stop()` waits for completion and reports failures; file and Writable outputs are verified. Windows temporary-file cleanup waits for child exit. Recording supports H264, VP8 or H265 video with Opus audio, in both file and Writable outputs. Local RTP sequence normalization preserves initial codec frames and VP8 picture IDs advance per frame.

H264, VP8 and H265 are negotiated according to the selected codec. H265 now reaches its FFmpeg encoder and dispatcher; All three codecs use regular keyframes; VP8 disables lookahead. H26x uses regular keyframes and video FPS is checked before spawning FFmpeg.

## Remaining limitations

Targeted checks establish the behaviors below. Long-call, large-group and high-resolution testing was excluded from this release at the maintainer’s request. Loss-based adaptive packet pacing now consumes authenticated RTCP receiver reports, with bounded NACK fallback and a shared primary/RTX pacing budget. It applies backpressure while preserving whole frames; it does not dynamically retune FFmpeg or implement delay-based GCC/TWCC. Each recorder handles one selected codec (H264, VP8 or H265) plus Opus; codec switching and transcoding during recording are unsupported. Platform media CI exercises generated fixtures without Discord credentials; live tests use Windows and two authorized accounts. See [media options](../MEDIA.md) and the [dependency review](DEPENDENCY_REVIEW.md).

Every declared public class/function has a runtime entrypoint export checked by regression tests. This is not proof that every historical declaration matches every live Discord object. DAVE requires the platform's native binary. Hosted Linux/Windows CI on Node 22/24 passed for the organization migration; its run metadata is archived locally with the original repository backup.

For `4.0.0-dev.5`, all six Node 22/24 platform checks and FFmpeg integration on all three platforms passed before repository recreation. Run metadata is archived locally. A fresh development archive consumer passed 203 runtime export checks, native DAVE initialization and strict TypeScript checks; publication dry-run and credential exclusion checks passed for all 369 packaged files. The npm advisory snapshot reported zero vulnerabilities.

No worker/batching/backup/quest subsystem was imported from the reference fork. Source and prereleases are available on GitHub. The `4.0.0-dev.4` npm archive passed clean installation, 203 export checks, native DAVE initialization, strict TypeScript checks, publication dry-run and credential exclusion checks. After publication, a fresh `npm i rockcord` consumer passed the same runtime/native/type checks; the registry integrity matches the release archive. The checkout stays at F:\djs; the repository and package identity are rockcord.

The GitHub repository is managed independently and has been recreated with fresh Rock Forge commit history. Original history, release archives and repository metadata were backed up locally before recreation. Source attribution and licensing are preserved in the redistributed files and credits.

## Stable release changes

- Adaptive packet pacing, authenticated receiver loss reports, stale-report rejection, rate bounds and cancellation checks. RTX recovery does not conceal primary-path loss from the controller.
- All three recording codecs, file/Writable finalization, regular VP8 keyframes and native DAVE initial-frame ordering across synchronized audio/video.
- Twelve dependency PRs reviewed together; compatible migrations preserve synchronous TOTP and Node 22/24 consumer support. jsdoc-to-markdown 8.0.3 avoids the unpatched advisory introduced by the proposed v9 tree.
- Group-DM invite resolution and Samsung presence cleanup repaired. ESLint 10, import-x, Prettier 3 and asynchronous JSDoc parsing are in use.

## Verification

Stable candidate verified locally on Windows on 2026-10-05:

- All 79 regression tests, source/declaration formatting, warning-free documentation generation and strict TypeScript checks passed after a clean lockfile install.
- Real FFmpeg integration received and decoded all 10 frames for each video codec, plus 192,000 PCM bytes from 50 Opus packets. All six H264/VP8/H265 × file/Writable recordings retained every frame and decoded audio after idle input and graceful finalization.
- npm audit reported zero vulnerabilities after the compatible documentation dependency selection.
- All six hosted Node 22/24 platform checks passed ([run](https://github.com/rock-forge/rockcord/actions/runs/37251169991)); FFmpeg playback and all six codec/output recordings passed on Linux, Windows and macOS ([run](https://github.com/rock-forge/rockcord/actions/runs/37251170054)). Windows CI downloads FFmpeg directly after a Chocolatey feed timeout.
- A fresh 4.0.0 archive installation loaded all 203 runtime exports and native DAVE. Strict consumer checks cover H265/VP8 recording options and adaptive pacing. The publish dry-run and credential exclusion checks passed for all 370 packaged files.
- Short live VP8 test: all 80 frames received, decoded and recorded with concurrent audio, nine deliberately dropped primary packets and 21 retransmissions. Authenticated loss feedback reduced the pacing target from 2,000,000 to 461,321 bits/s. No video DAVE decrypt failures occurred.
- Short live H265 test: all 40 frames received, decoded and recorded with concurrent audio. The target recovered from 1,800,000 to 2,000,000 bits/s after healthy reports. Both accounts disconnected cleanly after each test. These are functional checks, with no long-call, large-group or high-resolution benchmark requirement.

Earlier verification on 2026-10-04 and 2026-10-05:

- Clean npm install from the lockfile, including the Windows native DAVE binary.
- Node 24.15.0: all 69 runtime tests, source lint, declaration formatting, documentation validation and strict TypeScript checks passed for the media repairs.
- Node 22.23.3: all 55 runtime tests passed. Declaration/documentation checks passed in the preceding candidate validation.
- npm audit: zero reported vulnerabilities including development dependencies. This is an advisory snapshot; ESLint 8 and some transitive packages still report deprecation warnings.
- FFmpeg 9.0.2: real local MediaPlayer/codec/DAVE/RTP/receive/decode pipeline passed for 50 audio packets and 10 frames each of H264, VP8 and H265. Audio decoded to 192,000 nonzero PCM bytes; each video decoded to 288,000 YUV bytes. File and Writable recordings each retained all 10 H264 frames and the decoded audio, including after idle input.
- Authorized private-channel live tests using two test accounts: DAVE protocol 1 with matching privacy codes, generated audio in both directions, H264 camera video reception and FFmpeg decoding, participant leave/rejoin, fresh voice WebSocket negotiation after forced interruption, and post-transition audio passed. Both accounts disconnected and the process exited cleanly.
- Live H265 negotiated correctly and decoded 29 frames. VP8 negotiated correctly during a 12-second incoming-loss test; recovery feedback and RTX restored deliberately dropped packets, and screen sharing decoded 29 frames. A ten-second concurrent H264/audio recording decoded and recorded all 100 frames. Generated video is 160x120 at 10 FPS with regular keyframes; this is not a high-resolution quality benchmark. No text messages or DMs were sent.
- Three-minute live H264 test with 216 outgoing video packets deliberately dropped: 1,799 complete frames received and recorded, 1,770 frames decoded from the captured elementary stream, 415 RTX retransmissions, simultaneous audio reception, subsequent screen sharing, participant rejoin and forced reconnect all passed. Both accounts disconnected cleanly. This does not establish multi-hour stability.
- Hosted FFmpeg integration passed on Linux, Windows and macOS before recreation, including all three codecs and both recording outputs. Node 22 test harness waits now keep a bounded deadline referenced while awaiting intentionally unreferenced media timers.
- Fresh archive installation: CommonJS exports, native DAVE loading and a strict TypeScript consumer checked separately.
- Earlier offline benchmark delivered all 20,000 fixture events; after destruction only the console PipeWrap remained. Results from one machine are not a cross-platform performance claim.

Credentials and generated media/results stay in ignored local files, outside the npm package. No token values are printed by the maintained live harness. Run npm ci and npm test for routine offline checks, npm run test:media for FFmpeg integration, and npm run test:live with private environment settings for the authorized two-account scenario. Optional settings include TEST_SCREENSHARE=1, TEST_RECORDING=1 (selected codec), VIDEO_CODEC=H264/VP8/H265, TEST_PACKET_LOSS=incoming/outgoing, and TEST_VIDEO_SECONDS=1..600. Live checks are separate from builds and CI.

The historical docs/audit/repro programs intentionally assert old defects. Use them against the original audited commits when reproducing baseline findings; repaired behavior can make them fail.
