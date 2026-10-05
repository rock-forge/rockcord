# Repository audit and revamp assessment

**Audit date:** 4 October 2026. These findings describe the original audited commits. The local revamp candidate repairs many of them; see [IMPLEMENTATION.md](IMPLEMENTATION.md). Maintained regression checks run with `npm test`. The historical proof scripts assert baseline defects and are not candidate health checks.

| Repository | Reviewed commit | Package version |
| --- | --- | --- |
| [devrock07/discord.js-selfbot-v13](https://github.com/devrock07/discord.js-selfbot-v13) | `bf38318902cea8d0110d638e1dfadc01aec6b7cc` | 3.7.1 |
| [youtsuhodev/discord.js-selfbot-youtsuho-v13](https://github.com/youtsuhodev/discord.js-selfbot-youtsuho-v13) | `fd66246dfd5750cf2a80e1a25355a093d3cfac7f` | 3.7.8 |

The existing library has useful manager/action/model boundaries, but serious defects in credential logging, retry/lifecycle behavior, attachment preservation, cached snapshots, current voice compatibility, and crypto/resource ownership. The reference fork adds useful work, especially DAVE plumbing, but retains the original defects we tested and adds new correctness and declaration regressions. It should supply selectively reviewed changes, not serve as an assumed-stable replacement.

## Read the results

| Report | Contents |
| --- | --- |
| [NETWORK.md](NETWORK.md) | Ten prioritized network/authentication/client/sharding findings, proof, fixes, regressions and coverage. |
| [MODELS.md](MODELS.md) | Ten prioritized message/manager/component/reaction findings, extra patch/settings/upload issues and architecture recommendations. |
| [VOICE.md](VOICE.md) | Ten prioritized voice/utility/type findings, additional lifecycle/cache defects and current protocol gaps. |
| [BUILD.md](BUILD.md) | Eight build/type/release findings; actual lint, docs, dependency, packaging and type-check results. |
| [FORK_COMPARISON.md](FORK_COMPARISON.md) | Which reference changes are useful, which inherited defects remain, and what new regressions block adoption. |
| [REVAMP_PLAN.md](REVAMP_PLAN.md) | Implementation phases and concrete acceptance criteria. |

Findings include file/line evidence, trigger, impact, proposed fix, and verification expectations. P1 indicates high impact in an affected path; P2 indicates a functional or lifecycle repair. Priorities are engineering triage, not formal security ratings. Some findings group related mistakes; the reports are not a count of distinct vulnerabilities.

## Repair first

1. **Credential privacy and connection correctness:** account-token debug leaks, per-client proxy ownership, finite retry budgets, invalid-session recovery, destruction guards, and QR-auth settlement.
2. **Data integrity:** text-only edits currently send `attachments:[]`; forwarded snapshots overwrite cached source messages. Repair these before exposing more messaging features.
3. **Voice:** the base has no DAVE implementation, while current Discord calls require it. Both checkouts reuse transport nonces across new media dispatchers and retain malformed UDP/resource/timing/video-parser defects. The fork's DAVE video/readiness wiring needs review and correction too.
4. **Public API consistency:** missing runtime exports, broken pins/poll voters, Promise inconsistency, wrong component serialization, stale reaction counts and incorrect omission/null patch semantics.
5. **Verification and release:** meaningful tracked runtime and consumer type tests, declaration repair, reproducible installs, clean cross-platform checks and publication gated on a tested artifact.

The [current Discord voice requirements](https://github.com/discord/discord-api-docs/blob/main/developers/topics/voice-connections.mdx) support the DAVE compatibility finding. No live call was attempted; interoperability claims still require integration evidence.

## What was checked

The base checkout's 400 tracked files were inventoried. Review work screened the runtime subsystems in parallel, with focused source review and executable evidence for REST/gateway/auth/sharding, managers/structures/actions, and voice/utilities. Root review covered exports, errors, webhook construction, package metadata, typings, examples, documentation/build setup, CI, dependencies, and packaging. Each detailed report records its depth and limits; broad screening does not imply that every method is fully verified or that all bugs have been found.

All reproduction requests, sockets, account data, guilds and media fixtures are synthetic. Tests ran on Windows with Node 24.15.0/npm 11.12.1. Production dependency scans reported zero advisories for the resolved versions; development scans reported 25 affected package entries, mostly propagated through old tooling. Those results do not cover first-party source defects and change as dependency versions/advisories change.

The normal type commands passed on both checkouts because declaration checking is skipped and the consumer test file is empty. A standalone declaration check instead found 14 diagnostics in the base and 1,042 in the reference; see [BUILD.md](BUILD.md) for package-versus-dependency attribution. Normal Windows lint failed on CRLF formatting; other configured lint rules passed. Fresh-install docs failed on an old Node utility call, then passed after the existing JSDoc dependency patch was applied.

## Reproduce the findings

After installing the base dependencies, run these from the workspace root:

```powershell
node docs/audit/repro/network.cjs
node docs/audit/repro/models.cjs
node docs/audit/repro/voice.cjs
```

The evidence scripts deliberately assert or print **existing faulty behavior**. A successful exit establishes the observation; it is not a passing product test suite. Most transports/resources are replaced with controlled stubs, and model probes log observations that were reviewed against the source.

The reference snapshot is available locally at `.tmp/reference-youtsuho`. Its dependencies were installed with lifecycle scripts disabled. To exercise the comparison:

```powershell
node docs/audit/repro/network.cjs .tmp/reference-youtsuho
node docs/audit/repro/voice.cjs .tmp/reference-youtsuho
node docs/audit/repro/fork-network.cjs
node docs/audit/repro/fork-models.cjs
node docs/audit/repro/fork-voice.cjs
node docs/audit/repro/fork-performance.cjs
```

The native Davey readiness probe requires the reference dependency `@snazzah/davey`; it uses only a local synthetic session. The ignored reference clone and `.tmp` logs are not part of the published library. Preserve the reviewed commit if repeating comparisons later; running against a changed fork can legitimately produce different results.

No account login, guild/account modification, real proxy/media session, registry publication, GitHub push, or PR creation occurred. Optional codec/FFmpeg execution, Linux CI, minimum supported Node versions and live undocumented API compatibility remain unverified. The next implementation sequence is documented in [REVAMP_PLAN.md](REVAMP_PLAN.md).
