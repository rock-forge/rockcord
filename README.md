<p align="center">
  <img src="https://raw.githubusercontent.com/rock-forge/rockcord/main/docs/assets/rockcord-banner.png" alt="Rockcord.js banner with the otter mascot" width="1000">
</p>

<h1 align="center">Rockcord.js</h1>

<p align="center">
  <strong>Familiar v13 APIs. Encrypted audio and video.</strong><br>
  A maintained Discord client library by <a href="https://github.com/rock-forge">Rock Forge</a>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/rockcord"><img src="https://img.shields.io/npm/v/rockcord?color=5865F2&style=flat-square" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.19 or newer"></a>
  <a href="https://github.com/rock-forge/rockcord/actions/workflows/lint.yml"><img src="https://img.shields.io/github/actions/workflow/status/rock-forge/rockcord/lint.yml?branch=main&label=checks&style=flat-square" alt="Unit, lint, documentation and type checks"></a>
  <a href="https://github.com/rock-forge/rockcord/actions/workflows/media.yml"><img src="https://img.shields.io/github/actions/workflow/status/rock-forge/rockcord/media.yml?branch=main&label=media&style=flat-square" alt="FFmpeg integration checks"></a>
  <a href="https://github.com/rock-forge/rockcord/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-5865F2?style=flat-square" alt="GPL-3.0-only license"></a>
</p>

<p align="center">
  <a href="#installation">Install</a> ·
  <a href="#example">Example</a> ·
  <a href="#features">Features</a> ·
  <a href="https://github.com/rock-forge/rockcord/blob/main/docs/MEDIA.md">Media guide</a> ·
  <a href="https://github.com/rock-forge/rockcord/releases">Releases</a>
</p>

---

> [!WARNING]
> **Rock Forge and the Rockcord maintainers take no responsibility for Discord accounts blocked, suspended, or terminated after using this module. Use it at your own risk.**

> [!CAUTION]
> **Automating a normal Discord user account (a self-bot) is prohibited by [Discord's self-bot policy](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots) and can result in account termination.**

## Installation

```sh
npm i rockcord
```

Requires **Node.js 22.19.0 or newer**; tested on Node.js 22 and 24. CommonJS and TypeScript imports are supported.

Media playback also requires FFmpeg and a supported Opus binding. Keep optional dependencies enabled so npm can install DAVE's native binary for your platform.

## Example

```js
const { Client } = require('rockcord');
const client = new Client();

client.once('ready', () => {
  console.log(`${client.user.username} is ready!`);
});

client.login(process.env.DISCORD_TOKEN);
```

Set `DISCORD_TOKEN` in your local environment before running. Keep account tokens out of source files and commits. Find more examples in the [examples directory](https://github.com/rock-forge/rockcord/tree/main/examples).

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>🧩 Familiar APIs</h3>
      Discord.js v13 client, manager and collection APIs, with TypeScript declarations and checked runtime exports.
    </td>
    <td width="50%" valign="top">
      <h3>💬 Messages & components</h3>
      Components V2, message edits, attachments, forwarded snapshots, pins and polls, with repaired cache updates.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>🔐 Encrypted media</h3>
      Native DAVE/MLS encryption for audio and video, complete received video frames and voice privacy verification codes.
    </td>
    <td width="50%" valign="top">
      <h3>🎥 Playback & recording</h3>
      Screen-share connections and H264, VP8 or H265 playback. Record a selected video codec with Opus to a Matroska file or Writable stream.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>📶 Adaptive delivery</h3>
      Video packet pacing responds to authenticated loss feedback, with bounded retransmission and buffered audio reception.
    </td>
    <td width="50%" valign="top">
      <h3>🛠️ Reliability repairs</h3>
      Bounded REST retries, request deadlines, credential redaction and connection cleanup, covered by regression checks.
    </td>
  </tr>
</table>

<details>
<summary><strong>Media example: adaptive video playback</strong></summary>

With an established voice or screen-share connection:

```js
const video = connection.playVideo('video.mp4', {
  fps: 30,
  bitrate: 2000,
  congestionControl: { minBitrate: 128 },
});

video.on('congestion', ({ targetBitrate, loss }) => {
  console.log(`Video pacing: ${targetBitrate} bits/s; loss: ${loss}`);
});
```

Configuration rates use kbps. The reported target uses bits per second. Adaptive pacing adjusts packet delivery; the running encoder retains its initial bitrate. See the [media guide](https://github.com/rock-forge/rockcord/blob/main/docs/MEDIA.md) for recording options, codec selection and controller limits.

</details>

## Verified in 4.0.0

- **79 regression tests**, plus lint, documentation and strict TypeScript checks on Node.js 22 and 24 across Linux, Windows and macOS.
- **Real FFmpeg checks** for H264, VP8 and H265 playback and six recording combinations: each codec to a file and a Writable stream.
- **Focused live media checks** covering VP8 loss/retransmission and H265 delivery; clean npm consumer checks for runtime exports, native DAVE loading and declarations.

The [implementation report](https://github.com/rock-forge/rockcord/blob/main/docs/audit/IMPLEMENTATION.md) documents the results and remaining verification limits. The [dependency review](https://github.com/rock-forge/rockcord/blob/main/docs/audit/DEPENDENCY_REVIEW.md) explains adopted and deferred upgrades.

## Project links

| Explore | Contribute |
| --- | --- |
| [Media guide](https://github.com/rock-forge/rockcord/blob/main/docs/MEDIA.md) | [Report an issue](https://github.com/rock-forge/rockcord/issues) |
| [Examples](https://github.com/rock-forge/rockcord/tree/main/examples) | [Contributing guide](https://github.com/rock-forge/rockcord/blob/main/CONTRIBUTING.md) |
| [Changelog](https://github.com/rock-forge/rockcord/blob/main/CHANGELOG.md) | [Pull requests](https://github.com/rock-forge/rockcord/pulls) |
| [Releases](https://github.com/rock-forge/rockcord/releases) | [Dependency decisions](https://github.com/rock-forge/rockcord/blob/main/docs/audit/DEPENDENCY_REVIEW.md) |

## Credits and license

Rockcord is maintained independently by [Rock Forge](https://github.com/rock-forge) and [devrock07](https://github.com/devrock07). It builds on [discord.js-selfbot-v13](https://github.com/aiko-chan-ai/discord.js-selfbot-v13) and [discord.js](https://github.com/discordjs/discord.js). Original source attribution and licensing are preserved; this repository starts with fresh Rock Forge commit history.

Rockcord modifications are copyright © 2026 Rock Forge and devrock07. Original source credits remain with their respective authors.

Licensed under the [GNU General Public License v3.0 (`GPL-3.0-only`)](https://github.com/rock-forge/rockcord/blob/main/LICENSE), without warranty. Redistribution and modifications follow the terms in the license. Dependencies retain their own licenses.

---

<p align="center">
  <img src="https://raw.githubusercontent.com/rock-forge/rockcord/main/docs/assets/rockcord-mascot.png" alt="Rockcord's otter mascot holding a rock" width="130"><br>
  <strong>Rockcord.js</strong> · Made by <a href="https://github.com/rock-forge">Rock Forge</a>
</p>
