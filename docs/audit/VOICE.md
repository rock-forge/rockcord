# Voice and utility audit — original devrock07 checkout

Audit date: 2026-10-04. No runtime source changes. No credentials, Discord login, or Discord requests were used. Run the offline evidence with `node docs/audit/repro/voice.cjs` from the repository root. All 11 reproduced defect checks passed on Node v24.15.0 after the parent installed dependencies.

## Highest-priority findings

### V01 — P1 — Current voice protocol lacks mandatory DAVE support

Locations: `src/client/voice/networking/VoiceWebSocket.js:117`, `:139`, `:169`; `src/util/Constants.js:270`; `src/client/voice/dispatcher/BaseDispatcher.js:398`; `src/client/voice/receiver/PacketHandler.js:75`.

The Identify payload omits `max_dave_protocol_version`; every incoming voice WS message is unpacked as JSON; there are no DAVE/MLS transition handlers or media-frame encryption/decryption. `rg -n "DAVE|dave|MLS|max_dave_protocol" src/client/voice src/util/Constants.js` returns no matches. Transport AEAD alone does not supply DAVE.

Discord's [official voice documentation](https://github.com/discord/discord-api-docs/blob/main/developers/topics/voice-connections.mdx) states E2EE-only calls began March 1, 2026 and omission of the Identify field denotes no DAVE support. The [Discord rollout announcement](https://discord.com/blog/bringing-dave-to-all-discord-platforms) corroborates the migration. These facts plus code inspection identify a present protocol blocker; live compatibility was not tested.

Fix: use a maintained DAVE-capable voice implementation or integrate a vetted libdave binding behind a dedicated voice transport boundary. Add binary opcode, MLS epoch/transition, frame crypto, and reconnect fixture tests before claiming support. Merely adding an Identify version flag is insufficient.

### V02 — P1 — AEAD nonce repeats whenever a new dispatcher is created

Locations: `src/client/voice/dispatcher/BaseDispatcher.js:36`, `:305–335`; new dispatcher creation in `src/client/voice/player/MediaPlayer.js:282`, `:296`.

`_nonce` starts at zero in each audio/video dispatcher, while encryption uses the same `voiceConnection.authentication.secret_key`. Starting another playback or simultaneous audio/video repeats nonce 1, 2, etc. under one key. AES-GCM and XChaCha20 require unique key/nonce pairs; repeated values disclose relationships between plaintexts and break cryptographic security.

Offline proof: two BaseDispatchers sharing one fixed test AES key both produce nonce `00000001`; the XOR of their first eight ciphertext bytes equals the XOR of distinct plaintexts. No secret or network packet was involved.

Fix: own transport nonce allocation in the authenticated connection/key generation, shared across audio/video dispatchers. Preserve it across playback replacements and reconnects that retain a key, reset only for a new key, and reject/rekey before exhaustion. Regression: sequential playback, concurrent media, same-key reconnect, key rotation, and exhaustion.

### V03 — P1 — Malformed or unauthenticated UDP packets can throw out of the socket event

Locations: `src/client/voice/receiver/PacketHandler.js:232`, `:84`, `:104`; `src/client/voice/networking/VoiceUDPClient.js:106`, `:146`.

`push()` reads a four-byte SSRC at byte 8 without checking length. AES `decipheriv.final()` throws for bad tags. Neither parser nor UDP callback catches these errors; the discovery callback likewise throws directly for short/wrong handshake packets. This allows bad datagrams to reach the application's uncaught-exception path. Source address is not checked in the callbacks.

Offline proof: a one-byte packet throws RangeError; a 32-byte packet with a known test SSRC and invalid tag throws `Unsupported state or unable to authenticate data` through `PacketHandler.push()`.

Fix: validate minimum/declared lengths and RTP/header layout, verify expected source/port, and catch authentication/parse failures at the datagram boundary. Drop invalid input or emit a bounded diagnostic. Regression: truncations, unknown SSRC, wrong source, invalid tag, malformed discovery, and valid packet fixtures.

### V04 — P1 — Missing FFmpeg errors are unhandled in the recorder

Locations: `src/client/voice/receiver/Recorder.js:59`, `:74`, `:109–117`, `:149`.

Recorder invokes asynchronous `init()` without retaining/catching it and never installs a ChildProcess `error` listener. If FFmpeg is missing, its ENOENT event can terminate the process; the package does not ship FFmpeg. Destroying immediately before `init()` resumes also accesses an undefined `this.stream`.

Offline proof: mocked ChildProcess emits `spawn ffmpeg ENOENT` and the event escapes; mocked `destroy()` also leaves its UDP resource open (the separate lifecycle defect below).

Fix: expose/catch startup completion, attach process and stdin/stderr error/exit listeners before writing, emit recorder errors predictably, and make destroy idempotent during startup and after exit. Regression: FFmpeg absent, output unwritable, early destroy, premature exit.

### V05 — P2 — Playback loses pacing after 65,536 frames

Location: `src/client/voice/dispatcher/BaseDispatcher.js:214–227`.

`count` drives absolute scheduling from `startTime` but resets to zero after 65535. RTP sequence counters may wrap; elapsed playback frame counts cannot. At 20ms audio frames this happens after about 21m50.72s, and at 30fps video about 36m24.53s. Subsequent scheduled delays become strongly negative and Node clamps them, sending buffered media far faster than real time.

Offline proof with mocked monotonic clock/timers: consecutive delays around wrap are `[20, -1310700]` milliseconds.

Fix: keep an unbounded monotonic frame/time accumulator and wrap only RTP sequence and codec picture IDs. Regression: simulate wrap with a clock; assert adjacent sends remain one frame interval apart.

### V06 — P2 — Annex B splitter loses initial and final video data

Locations: `src/client/voice/player/processing/AnnexBNalSplitter.js:195–213`, class ending `:214`.

Before its first complete start code, `_transform()` discards any chunk that contains no full `00 00 01`. A start code split across the first chunks loses the first NALU, commonly SPS/PPS necessary to decode. There is no `_flush()` to process `_buffer` and emit the last `_accessUnit`, so the final frame is always discarded and one-frame inputs produce no output.

Offline proof: an AUD + IDR one-frame input emits zero access units. Splitting the first start code after two bytes changes output from `000000026742` (SPS) to `0000000209f0000000026511`, demonstrating the missing SPS.

Fix: retain the suffix/prefix needed to recognize boundary-spanning start codes; implement flush of the final NALU/access unit and explicit truncation handling. Regression: feed identical encoded input as one chunk, every byte boundary, randomized chunking, and a one-frame clip; require identical access-unit output.

### V07 — P2 — Server-initiated disconnect loses an open UDP socket and receive resources

Locations: `src/client/voice/ClientVoiceManager.js:72–76`; `src/client/voice/VoiceConnection.js:486–518`; `src/client/voice/receiver/PacketHandler.js:248`.

When a server voice-state update has no channel, ClientVoiceManager calls `_disconnect()` directly. `_disconnect()` calls `cleanup()`, which shuts down WS but only removes UDP error listeners and then nulls its reference. UDP shutdown is tied to `closing`, which this path never emits. Receive streams/timers are also not cleaned up by the general connection cleanup path.

Offline proof calling the actual cleanup method with a tracked fake UDP client: shutdown call count remains 0 and `sockets.udp` becomes null. The server-initiated path follows that exact method.

Fix: have one idempotent cleanup owner close both transports, dispose receive streams/timeouts, remove connection hooks, and destroy child stream/watch connections, regardless of disconnect initiator. Regression: local disconnect, server kick/move, startup failure, reconnect, and repeated cleanup.

### V08 — P2 — Video playout-delay extension is all padding

Locations: `src/client/voice/dispatcher/BaseDispatcher.js:273–301` (especially `:288–299`); called by VP8 and AnnexB dispatchers.

The comment before `data[0]` ends with `/` rather than `*/`; the ID/length assignment is inside a comment. The only executable write stores zero in bytes 1–2. `createPayloadExtension()` returns `00 00 00 00`, representing padding, although the RTP header advertises an extension and the code documents playout delay as required. The commented implementation also refers to nonexistent `ext.len` instead of the defined `length`.

Offline proof: the actual method returns hex `00000000`. [RFC 5285 section 4.2](https://www.rfc-editor.org/rfc/rfc5285#section-4.2) defines ID zero as padding; this contains no playout-delay element.

Fix: build the one-byte element header and three-byte playout-delay value correctly, calculate the word count, and validate serialized bytes with an independent RTP parser. Verify interoperability after fixing DAVE; live video behavior was not tested.

### U01 — P2 — High user flags are silently truncated by 32-bit operators

Locations: `src/util/UserFlags.js:89–101`; `src/util/BitField.js:29`, `:47`, `:79`, `:95`, `:159`; related types `typings/index.d.ts:3802`, `:8030`.

UserFlags declares Number masks from bit 33 through 51, but inherits Number bitwise operations that coerce to 32 bits. `has`, `any`, add/remove, arrays, serialization, and toArray cannot preserve these advertised flags. The typings omit the added flags entirely.

Offline proof: `new UserFlags(UserFlags.FLAGS.VERIFIED_EMAIL).has('VERIFIED_EMAIL')` returns false; adding that flag to an empty field yields zero.

Fix: implement UserFlags with BigInt internally (with deliberate compatibility conversion/serialization) or use an explicit width-safe implementation. Match declaration names to supported flags. Regression: every advertised flag alone and in mixed low/high combinations, add/remove, JSON round trip.

### T01 — P2 — Public voice declarations do not match runtime exports or constructors

Locations: `typings/index.d.ts:1012`, `:1029`, `:1060`, `:1113`, `:1123`, `:1197`, `:1211`, `:1229–1231`, `:1246`; `src/index.js:48–49`, `:169–172`; `src/client/voice/dispatcher/VideoDispatcher.js:15`; `src/client/voice/receiver/Recorder.js:23`.

The declaration file exposes constructor values for VoiceConnection, StreamConnection, StreamConnectionReadonly, VoiceReceiver, AudioDispatcher, VideoDispatcher, BaseDispatcher, VolumeInterface, VolumeMixin, and Speaking that are absent from runtime exports. `new VideoDispatcher(player, {highWaterMark:12})` matches declarations but the runtime class expects a number; Recorder declarations require `{ffmpegArgs, channels, frameDuration}` while runtime expects `{userId, portUdpH264, portUdpOpus, output}`. Recorder itself is exported; the other missing names were confirmed against all of src/index.js. This can let valid TypeScript compile and then fail at runtime.

Fix: choose public values deliberately, export the supported ones, represent internal types without claiming exported runtime constructors, and align exact constructor/options/nullability/event signatures. Add runtime export parity assertions and useful tsd examples using public factories and constructor values.

## Additional reproduced defects

### U02 — P2 — LimitedCollection iterable bypasses cache limits

Location: `src/util/LimitedCollection.js:57–65`, `:99`.

`super(iterable)` invokes overridden `set()` before maxSize/keepOverLimit are initialized. Initial entries bypass limit enforcement, and subsequent inserts only delete one entry, preserving an oversized cache. Proof: maxSize 1 with two initial entries has size 2; maxSize 0 with one entry has size 1.

Fix: call `super()` first, initialize policy fields, then insert iterable entries through `this.set()`. Regression: empty iterable, zero/one capacity, over-limit input, retained entries, subsequent additions.

### U03 — P2 — Deferred interaction success leaks the listener allowance

Location: `src/util/Util.js:930–959`.

INTERACTION_SUCCESS removes handlers and stores the parent, but does not decrement the max-listener allowance; the timeout's successful early return likewise skips cleanup. Every deferred-success interaction permanently raises the client's maxListeners and hides later genuine leaks. Proof: success with matching nonce resolves and allowance stays 11 after beginning at 10.

Fix: use one once-only settle/cleanup helper on all outcomes. Resolve immediately on the success event unless waiting for another result is explicitly required. Regression: normal success, deferred success, timeout, error, and duplicate events all restore allowance/listeners.

### V09 — P2 — Destroyed manual receive streams remain cached

Location: `src/client/voice/receiver/PacketHandler.js:53–58`.

Stream cache removal listens to `end`, not `close`; the documented manual path is to destroy a stream. A manually destroyed unread stream remains cached and the next createStream returns that destroyed stream. Proof uses actual makeStream/destroy and returns the same destroyed object afterward.

Fix: clear the matching cached entry on close/destroy as well, and ensure old stream completion cannot delete a newer stream. Regression: destroy then recreate, unread stream, already ended stream, repeated creation.

### V10 — P2 — Recorder destroy never closes its UDP socket

Location: `src/client/voice/receiver/Recorder.js:57`, `:149–159`.

Destroy searches/kills FFmpeg but does not close the UDP sending socket or any StreamOutput server. Once feed binds the UDP socket, stopping the recorder leaks a handle and can retain the process. Fixed ports 65506/65510 in `PacketHandler.js:66–67` also mean multiple recordings share FFmpeg input endpoints.

Offline proof with mocked resources: successful process lookup/destroy leaves socket close false. Fix: track all owned resources and dispose them directly/idempotently on startup error, exit, and destroy; allocate/reserve unique UDP port pairs per recorder. Add resource-close and concurrent-recording tests.

## Lower-priority observations / follow-up checks

- `src/client/voice/util/Function.js:86–90`: findPort closes a socket and then calls address(), which will throw ERR_SOCKET_DGRAM_NOT_RUNNING on a successfully bound socket. Internal helper appears unused; read address before close and close in finally.
- `src/client/voice/networking/VoiceWebSocket.js:195` references `VoiceOpcodes.CLIENT_CONNECT`, absent from `src/util/Constants.js:270–288`; numeric client-connect events fall through and do not initialize the SSRC map. Include in opcode fixture coverage.
- `src/client/voice/VoiceConnection.js:1059–1077`: StreamConnection.update emits incoming paused state but does not assign this.isPaused (Readonly variant does). Confirmed source inconsistency; add state-update fixture.
- `src/util/Util.js:18`, `:819–831`: sortable text types contain misspelled GUILD_ANNOUCMENT and refer to GUILD_ANNOUNCEMENT although this repo's channel constant is GUILD_NEWS. Check channel reorder behavior with announcement/media fixtures.
- `src/util/Util.js:859`: upload metadata uses random file_size instead of actual bytes. Coordinate with the media/upload audit before recording this as a separate issue.
- Required XChaCha transport mode is advertised even though sodium/libsodium-wrappers/@stablelib is not a declared dependency; stock installs on an XChaCha-only server will hit NoLib. Pin/test an available backend and initialization readiness. No live server negotiation was attempted.
- Raw stream gateway listeners installed at VoiceConnection.js:686 and :800 are anonymous and not removed on closing. Long-running repeated stream sessions retain stale connection objects.

## Scope and limits

Reviewed all 22 JS files beneath src/client/voice, all 26 src/util JS files except separately-assigned RemoteAuth, src/WebSocket.js, and relevant voice/utility declarations in typings/index.d.ts. Cross-checked index exports and inspected Constants mappings and their generator helpers. Literal API constants were not independently revalidated one-by-one against all current Discord schemas. Relevant declaration searches found no voice regression tests in index.test-d.ts.

The checks use actual code paths with deterministic synthetic data; the scheduler, recorder resources, and child process are mocked to avoid waiting 22 minutes, spawning FFmpeg, or sending media. Packet crypto uses only a fixed test key. No live FFmpeg codec validation, native opus/sodium backend execution, DAVE integration, Discord login, voice join, UDP interoperability, or channel API mutation was performed. Protocol compatibility is an inference from current official requirements and missing code, clearly distinct from a measured live failure.

Revamp direction: decouple supported client/cache/REST surfaces from a maintained voice transport, centralize lifecycle and connection cryptographic state, replace copied video helpers with validated media pipelines, and add focused offline regression fixtures before UI/docs polish or expanding codec claims.
