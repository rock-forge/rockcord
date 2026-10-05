<p align="center">
  <img src="https://raw.githubusercontent.com/rock-forge/rockcord/main/docs/assets/rockcord-banner.png" alt="Rockcord.js" width="1000">
</p>

<p align="center">
  A Discord client library with familiar v13 APIs, TypeScript declarations, and DAVE media encryption.<br>
  Maintained by <a href="https://github.com/rock-forge">Rock Forge</a>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rockcord"><img src="https://img.shields.io/npm/v/rockcord" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/tested-Node%2022%20%7C%2024-339933" alt="Tested on Node.js 22 and 24"></a>
  <a href="https://github.com/rock-forge/rockcord/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL v3 license"></a>
</p>

## Installation

```sh
npm i rockcord
```

Requires **Node.js 22 or newer**; tested on Node.js 22 and 24. Import with `require('rockcord')` or TypeScript imports from `'rockcord'`.

Media playback also requires FFmpeg and a supported Opus binding. Keep optional dependencies enabled so npm can install DAVE's native binary for your platform.

## Features

- Familiar Discord.js v13 client, manager, and collection APIs.
- Repaired message edits, attachment handling, forwarded snapshots, pins, polls, and cache updates.
- Components V2 support and checked runtime exports with TypeScript declarations.
- Bounded REST retries, request deadlines, credential redaction, and connection cleanup.
- Native DAVE/MLS encryption for audio and video, complete received video frames, and voice privacy verification codes.
- Screen-share connections, H264/VP8/H265 playback, H264/Opus recording, video retransmission, and buffered audio reception.

This is a **development release**. Live audio, all three video codecs, screen sharing, H264 recording, and packet-loss recovery have passed targeted checks. See the [implementation report](https://github.com/rock-forge/rockcord/blob/main/docs/audit/IMPLEMENTATION.md) for coverage and limitations.

## Project links

- [Changelog](https://github.com/rock-forge/rockcord/blob/main/CHANGELOG.md)
- [Examples](https://github.com/rock-forge/rockcord/tree/main/examples)
- [Contributing](https://github.com/rock-forge/rockcord/blob/main/CONTRIBUTING.md)
- [Releases](https://github.com/rock-forge/rockcord/releases)
- [Report an issue](https://github.com/rock-forge/rockcord/issues)

## Credits and license

Rockcord is maintained independently by [Rock Forge](https://github.com/rock-forge) and [devrock07](https://github.com/devrock07). It builds on [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) and [discord.js](https://github.com/discordjs/discord.js). Original source attribution and licensing are preserved; this repository starts with fresh Rock Forge commit history.

Licensed under [GPL v3](https://github.com/rock-forge/rockcord/blob/main/LICENSE). Dependencies retain their own licenses.
