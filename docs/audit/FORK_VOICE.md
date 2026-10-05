# Voice and utilities comparison — youtsuhodev fork

Reference checkout: `F:/djs/.tmp/reference-youtsuho`, commit `fd66246dfd5750cf2a80e1a25355a093d3cfac7f` (2026-09-19), package version 3.7.8. Compared against the original devrock07 checkout. Audit date 2026-10-04. Source was not edited.

The fork supplies meaningful DAVE audio plumbing, but does not resolve the original voice safety/lifecycle problems and its video DAVE wiring is incorrect. It is a source of individual ideas and patches, not a verified wholesale replacement.

## Changes worth retaining after review

- DAVE architecture: declared `@snazzah/davey` dependency, Identify `max_dave_protocol_version`, binary voice opcode parsing, participant set, MLS proposal/commit/welcome recovery, and a dedicated DAVESession wrapper. Locations: `src/client/voice/networking/VoiceWebSocket.js:105–173`, `:207–288`; `src/client/voice/util/DAVESession.js`; `src/util/Opcodes.js:71–81`. These close the original complete absence of DAVE, but require the correctness changes below and fixtures before advertising working E2EE.
- Heartbeat monitoring: ACK/ping tracking and closing after missed heartbeats are added at `VoiceWebSocket.js:218–222`, `:314–329`. Keep that direction and test close/reconnect/reset state, rather than copying the complete WebSocket rewrite without coverage.
- Opcode/constant files are split into smaller modules and `CLIENTS_CONNECT:11` is supplied. Keep generated or centrally-validated maps; repair the StageChannel regression introduced by the refactor.
- `Util.getUploadURL` replaces random file_size with `file.byteLength ?? file.size ?? 0` (`src/util/Util.js:859`). Actual-byte metadata is the correct direction, but ensure the files' real shape and stream handling are covered before porting this expression.
- `VoiceConnection.setTokenAndEndpoint` retains an explicit port (`src/client/voice/VoiceConnection.js:349`). Add hostname, optional port, malformed endpoint, and IPv6 fixtures before carrying over the regex.

The new WorkerManager/EventBatcher/LazyManagerRegistry helpers are being reviewed separately by the parent/network audit. This report makes no performance-improvement claim about those features.

## New DAVE correctness findings

### YV01 — P1 — Video is encrypted/decrypted as Opus audio and at the wrong boundary

Locations: `src/client/voice/dispatcher/BaseDispatcher.js:392–394`; `src/client/voice/util/DAVESession.js:172–181`; `src/client/voice/receiver/PacketHandler.js:132–146`; video fragmentation at `src/client/voice/dispatcher/AnnexBDispatcher.js:33–65` and `VPxDispatcher.js:44–48`.

The shared BaseDispatcher calls daveSession.encrypt() for every media packet. The wrapper always invokes native encryptOpus(), including for H264/VP8. The native dependency's installed `index.d.ts:164–170` explicitly defines encryptOpus as AUDIO + OPUS and exposes a separate mediaType/codec API. Receiving likewise passes every RTP payload, including video, to AUDIO decryption (`DAVESession.js:181`).

In addition, `_createPacket` runs after video fragmentation and after adding RTP payload extensions. DAVE is frame encryption before packetization; codec framing and RTP extensions cannot simply be treated as Opus content. [Discord's official voice guide](https://github.com/discord/discord-api-docs/blob/main/developers/topics/voice-connections.mdx) distinguishes frame E2EE from packet transport encryption.

Offline proof in `docs/audit/repro/fork-voice.cjs`: a video dispatcher with payload type 105 passes extension + H264 fragment `000000006511` to encryptOpus; video receive passes mediaType 0 (AUDIO) rather than 1 (VIDEO). The packet/receiver paths are actual fork code, and native method calls are instrumented. Native Davey 0.1.12 was inspected; live video interoperability was not tested.

Fix: model audio and codec-specific complete video frames separately, encrypt with the appropriate supported native media/codec operation before fragmentation, preserve mandated clear codec ranges and RTP metadata, and decrypt/reassemble video on its corresponding frame boundary. If the selected backend cannot support a codec, reject it explicitly instead of encrypting it as Opus. Add independent packet/frame round-trip fixtures for every advertised codec.

### YV02 — P1 — Negotiated E2EE can send unencrypted frames while DAVE is unready

Locations: `src/client/voice/util/DAVESession.js:172–179`; `src/client/voice/networking/VoiceWebSocket.js:207–216`; `src/client/voice/VoiceConnection.js:591–609`.

When protocolVersion is positive but native session.ready is false, encrypt() returns the original packet. The connection emits ready on transport Session Description/one silence frame, without awaiting MLS group/transition readiness, so consumers may immediately start sending raw media inside transport AEAD. The DAVE constructor/MLS startup failure is also caught and logged while connection initialization proceeds, leaving daveSession null.

Offline proof uses the actual installed native Davey: a reinitialized protocol-1 session reports ready=false and wrapper.encrypt(non-silence test frame) returns the identical input buffer. Actual VoiceConnection.onSessionDescription emits ready with a mocked unready DAVE session. This proves the lack of gating/fail-closed behavior; live server acceptance and timing were not measured.

Fix: track transport readiness separately from media/E2EE readiness; block or boundedly queue non-silence frames until the required DAVE state is active; propagate DAVE startup failure as connection failure. Never silently downgrade encryption after negotiating a positive protocol version. Regression: delayed welcome, absent external sender, MLS error, reconnect, playback starting immediately when join resolves.

### YV03 — P2 — Media can switch keys before transition execution

Locations: `src/client/voice/util/DAVESession.js:131–174`; `src/client/voice/networking/VoiceWebSocket.js:147–168`, `:257–260`.

processCommit/processWelcome update native state and record a pending transition, then send transition-ready. encrypt() consults native ready but does not gate on that pending transition or the execute event. Native API has no separate execution method: the wrapper must preserve/select active context or withhold media appropriately. Official protocol guidance identifies the execute transition as the point when senders begin using the new protocol context.

Offline proof with instrumented native session: processWelcome for transition 42 leaves it pending; encrypt immediately invokes encryptOpus before executeTransition(42). This confirms missing wrapper coordination; exact native key behavior under real MLS epochs was not exercised.

Fix: distinguish prepared and active media contexts, retaining the prior context until execution or queueing frames across the transition with a strict limit. Test multiple nonzero transitions, transitions during playback, invalid commit recovery, and reconnect.

## Original defects retained

Ran `node docs/audit/repro/voice.cjs .tmp/reference-youtsuho`. All 11 original defect checks still reproduce on the fork, with the same evidence:

| Original finding | Fork evidence/location | Status |
| --- | --- | --- |
| V02 transport nonce reuse | BaseDispatcher.js:36, :307–329 | Reproduced |
| V03 uncaught short/bad-tag UDP | PacketHandler.js:84, :104, :246; VoiceUDPClient.js unchanged | Reproduced |
| V04 recorder startup errors | Recorder.js unchanged | Reproduced with mocked ENOENT |
| V05 scheduling count rollover | BaseDispatcher.js:220–227 | Reproduced |
| V06 Annex B boundary/final loss | AnnexBNalSplitter.js unchanged | Reproduced |
| V07 missing UDP cleanup | VoiceConnection.js:517–535 | Reproduced |
| V08 zero video RTP extension | BaseDispatcher.js:273–301 | Reproduced |
| U01 truncated high UserFlags | UserFlags.js and BitField.js unchanged | Reproduced |
| U02 iterable cache bypass | LimitedCollection.js unchanged | Reproduced |
| U03 deferred listener allowance leak | Util.js:925–969 unchanged | Reproduced |
| V09 destroyed manual receiver cache | PacketHandler.js:53–58 unchanged | Reproduced |
| V10 recorder UDP cleanup | Recorder.js unchanged | Included in reproduced resource check |
| T01 voice type/runtime mismatch | typings/index.d.ts:1191–1421, :3606; src/index.js | Confirmed by source/export comparison |

DAVE does not fix the independent transport AEAD nonce-reuse bug: both encryption layers remain relevant.

## Constant-refactor regression

YV04 — P2 — `GUILD_STAGE_VOICE` was removed from TextBasedChannelTypes in both `src/util/Constants.js:18–27` and `src/util/ChannelTypes.js:34–43`, whereas the original includes it. Channel.isText() uses this list, so StageChannel text classification/cache sweep behavior changes. This delta was sent to the structures audit to validate and consolidate with public type-guard coverage. Restore parity and derive duplicate lists from one definition.

## Coverage and limits

Voice diff: five changed/added files among 23 fork voice JS files; all modified voice code was read. The unchanged voice paths were previously reviewed in the original and their defects rerun against the fork. Utility changes and added maps were compared; helpers overlapping parent/network scopes were handed off. src/WebSocket.js is identical. Public voice declarations retain the mismatches described above.

`docs/audit/repro/fork-voice.cjs` passed five DAVE checks: actual native unready passthrough plus instrumented media-type/transition and connection-ready wiring. The fork installed dependency resolved to Davey 0.1.12 from declared ^0.1.11; no native MLS group exchange or real codec encryption round trip was set up. There were no Discord credentials, voice joins, UDP sends, FFmpeg launches, account mutations, or source edits. The inherited test script imports the package but constructs no Client, so it creates no WorkerManager/Discord session.

Recommendation: port the reviewed DAVE audio boundary and ACK monitoring as an isolated, tested voice subsystem; first fix transport nonces, datagram safety, lifecycle, and readiness. Add actual video DAVE support only after selecting a backend that provides the needed codec semantics. Keep the existing API via adapters while making unsupported states/errors explicit.
