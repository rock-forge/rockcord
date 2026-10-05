# Stable release dependency review

Reviewed on 2026-10-05 against Rockcord's supported Node 22/24 environments. All twelve PRs change only package metadata and the lockfile. Compatible changes are integrated together under maintainer history, including the required code and tooling migrations.

| PR | Proposed update | Decision |
| --- | --- | --- |
| [1](https://github.com/rock-forge/rockcord/pull/1) | eslint-config-prettier 10 | Adopt with Prettier 3 / ESLint 10. |
| [2](https://github.com/rock-forge/rockcord/pull/2) | undici 8.11.2 | Adopt; raise the minimum Node version to 22.19.0. |
| [3](https://github.com/rock-forge/rockcord/pull/3) | TypeScript 7 | Retain 5.9: existing export checks use the JavaScript compiler API that v7 removes. |
| [4](https://github.com/rock-forge/rockcord/pull/4) | ESLint 10 | Adopt 10.12.0, migrate to flat configuration and replace the incompatible import plugin with import-x. |
| [5](https://github.com/rock-forge/rockcord/pull/5) | opusscript 0.1.1 | Retain 0.0.8 to satisfy prism-media 1.3.5's published peer range. No forced peer installation. |
| [6](https://github.com/rock-forge/rockcord/pull/6) | otplib 13.5.0 | Adopt through @otplib/v12-adapter. Preserve synchronous authentication and historical short MFA secrets; isolate each client's options. |
| [7](https://github.com/rock-forge/rockcord/pull/7) | Shapeshift 5 | Retain 4: v5 requires Node 26 and Node 26 declarations. |
| [8](https://github.com/rock-forge/rockcord/pull/8) | eslint-plugin-prettier 5 | Adopt with matching formatter/configuration. |
| [9](https://github.com/rock-forge/rockcord/pull/9) | jsdoc-to-markdown 9.1.3 | Upgrade to 8.0.3 instead. The v9 tree introduces unpatched braces through fast-glob; asynchronous documentation parsing remains supported. |
| [10](https://github.com/rock-forge/rockcord/pull/10) | tough-cookie 6.0.2 | Adopt; compatible with the existing fetch-cookie integration. |
| [11](https://github.com/rock-forge/rockcord/pull/11) | @types/node 26 | Retain 22 declarations so consumers cannot accidentally rely on APIs absent from the oldest supported runtime. |
| [12](https://github.com/rock-forge/rockcord/pull/12) | Prettier 3.9.9 | Adopt and format source/declarations. |

The documentation dependency decision follows [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), which lists no patched braces release. npm audit reports zero advisories after the compatible v8 selection. This is the advisory snapshot at review time.

Dependabot now groups weekly minor/patch updates, limits open PRs, and ignores the four incompatible major upgrades above and the affected documentation v9 series. Node 22/24 unit, lint, documentation and declaration checks and three-platform FFmpeg integration remain the release checks.

## Post-release tooling updates

Reviewed on 2026-10-05. These updates affect development tooling only; both PRs passed all nine platform checks before integration.

| PR | Proposed update | Decision |
| --- | --- | --- |
| [13](https://github.com/rock-forge/rockcord/pull/13) | eslint-import-resolver-node 0.4.0 | Adopt. The resolver now respects package exports by default; the existing import-x configuration passes with this behavior. |
| [14](https://github.com/rock-forge/rockcord/pull/14) | globals 17.13.0 | Adopt. Updated lint global definitions require Node 18 or newer, within Rockcord's Node 22.19+ requirement. |

Integrated together under maintainer history. The complete local test suite and npm audit are rerun for the combined dependency tree; published 4.0.0 retains its original release dependencies.
