# Media options

Playback and recording support H264, VP8 and H265. Recording combines the selected video codec and Opus into Matroska. FFmpeg must support the selected codecs.

## Recording

```js
const recorder = connection.receiver.createVideoStream(userId, 'capture.mkv', { codec: 'VP8' });
recorder.on('error', error => console.error(error.message));
// After recording:
await recorder.stop();
```

The third argument is optional; H264 remains the default. `output` may also be a Writable stream. Choose the codec actually being transmitted by the recorded participant. Each recorder uses a single selected video codec and Opus; it does not transcode or switch codecs during a recording. `ready` signals bound receiving ports and `stop()` waits for FFmpeg to finalize the output.

## Adaptive video pacing

```js
const dispatcher = connection.playVideo('video.mp4', {
  fps: 30,
  bitrate: 2000,
  congestionControl: { minBitrate: 128 },
});
dispatcher.on('congestion', state => {
  console.log(state.targetBitrate, state.loss, state.reason);
});
```

Configuration rates are in **kbps**; the reported `targetBitrate` is in **bits per second**. Pacing is enabled by default, with a 2,000 kbps ceiling when no numeric playback bitrate is supplied and a 128 kbps floor (or the ceiling, if lower). `congestionControl.bitrate` can override the pacing ceiling separately from the encoder's initial bitrate. Set `congestionControl: false` to disable adaptive pacing.

Authenticated RTCP receiver reports drive loss-based AIMD: loss of at least 10% reduces the target by 25%; loss of at least 2% reduces it by 10%; healthy reports permit gradual recovery up to the ceiling. Updates occur at most once per second. Stale reports are ignored, and the worst recently active reporter controls the rate. Without recent receiver reports, repeated unique NACKs can reduce the target but cannot increase it.

Primary video packets and retransmissions share a paced schedule. Backpressure preserves complete encoded frames; under sustained congestion it may slow video playback. Audio is independent after initial DAVE startup. This controller adjusts packet transmission, not the running FFmpeg encoder's bitrate, and does not implement delay-based GCC/TWCC. A frame is limited to 4 MiB or 4,096 packets; destroyed dispatchers and changed transport keys stop queued transmission.
