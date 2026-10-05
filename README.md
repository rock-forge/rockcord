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

> [!WARNING]
> **Rock Forge and the Rockcord maintainers take no responsibility for Discord accounts blocked, suspended, or terminated after using this module. Use it at your own risk.**

> [!CAUTION]
> **Automating a normal Discord user account (a self-bot) is prohibited by [Discord's self-bot policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) and can result in account termination.**

## Installation

```sh
npm i rockcord
```

Requires **Node.js 22.19.0 or newer**; tested on Node.js 22 and 24. Import with `require('rockcord')` or TypeScript imports from `'rockcord'`.

Media playback also requires FFmpeg and a supported Opus binding. Keep optional dependencies enabled so npm can install DAVE's native binary for your platform.

## Features

- Familiar Discord.js v13 client, manager, and collection APIs.
- Repaired message edits, attachment handling, forwarded snapshots, pins, polls, and cache updates.
- Components V2 support and checked runtime exports with TypeScript declarations.
- Bounded REST retries, request deadlines, credential redaction, and connection cleanup.
- Native DAVE/MLS encryption for audio and video, complete received video frames, and voice privacy verification codes.
- Screen-share connections and H264, VP8, and H265 playback and recording with Opus audio.
- Adaptive video packet pacing using authenticated receiver loss reports, bounded retransmission, and buffered audio reception.

The **4.0.0 stable release** includes the media repairs and reviewed dependency updates. See the [media options](https://github.com/rock-forge/rockcord/blob/main/docs/MEDIA.md), [dependency review](https://github.com/rock-forge/rockcord/blob/main/docs/audit/DEPENDENCY_REVIEW.md), and [implementation report](https://github.com/rock-forge/rockcord/blob/main/docs/audit/IMPLEMENTATION.md) for configuration and verification coverage.

## Project links

- [Changelog](https://github.com/rock-forge/rockcord/blob/main/CHANGELOG.md)
- [Examples](https://github.com/rock-forge/rockcord/tree/main/examples)
- [Contributing](https://github.com/rock-forge/rockcord/blob/main/CONTRIBUTING.md)
- [Releases](https://github.com/rock-forge/rockcord/releases)
- [Report an issue](https://github.com/rock-forge/rockcord/issues)

## Credits and license

Rockcord is maintained independently by [Rock Forge](https://github.com/rock-forge) and [devrock07](https://github.com/devrock07). It builds on [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) and [discord.js](https://github.com/discordjs/discord.js). Original source attribution and licensing are preserved; this repository starts with fresh Rock Forge commit history.

Licensed under [GPL v3](https://github.com/rock-forge/rockcord/blob/main/LICENSE). Dependencies retain their own licenses.
