# Build, dependency, type, and release audit

Checked on 4 October 2026 against `bf38318902cea8d0110d638e1dfadc01aec6b7cc`, package version 3.7.1. Environment: Windows PowerShell, Node 24.15.0, npm 11.12.1. Source and package configuration were left unchanged.

## What actually passed

| Check | Observed result | Meaning |
| --- | --- | --- |
| `npm install --ignore-scripts --no-audit --no-fund` | Installed 778 packages | Installation succeeds on this runtime; optional native/media backends were not exercised. |
| Public entrypoint import and constructing an offline Client | 157 exports; Client constructed | Basic import/constructor work. No login occurred. |
| `npm run test:typescript` | Exit 0 | `skipLibCheck:true` skips declaration checking; the `tsd` consumer-test file is empty. This result gives little assurance. |
| `npm run lint:typings` | Exit 0 | Legacy declaration lint passes. |
| `npm run lint` | Exit 1; 49,945 formatting reports | Windows checkout uses CRLF while Prettier requires LF; this is not 49,945 logic defects. |
| ESLint with only `prettier/prettier` disabled | Exit 0; zero errors/warnings across 357 files | Other configured rules pass. |
| `npm run docs:test`, fresh install | Exit 1 | Old JSDoc calls removed Node 24 `util.isRegExp`. |
| Apply existing `patch-package`, then `npm run docs:test` | Exit 0, with documentation warnings | CI already applies a working compatibility patch; ordinary install/test does not. |
| `npm pack --dry-run --json` | 364 package entries, 432,278 compressed bytes, 2,006,427 unpacked bytes | Packaging works; no package was published. |
| `npm audit --omit=dev --json` | Zero reported vulnerabilities | Current resolved production dependencies have no registry-reported advisory findings. This is not a security guarantee. |
| `npm audit --json` | 25 affected package entries: 22 high, 1 moderate, 2 low | Findings are in the development/tooling dependency graph, including propagated effects. These are not 25 distinct exploitable runtime bugs. |

Raw local diagnostic files are under `.tmp/audit-root/`. The dependency snapshot is specific to this install because the repository has no committed lockfile. Important resolved versions include Undici 7.30.0, ws 8.22.0, discord-api-types 0.38.56, TypeScript 5.9.3, ESLint 8.57.1, JSDoc 3.6.11, and docgen 0.11.1.

## B01 — P1: publishing has no validation gate and deprecates first

**Evidence:** `.github/workflows/release.yml:28–49`. The job does not install dependencies, run tests, apply the docs patch, or validate an artifact. It deprecates the currently published version before attempting the new publication. Tag matching is broad (`3*`) and is not checked against `package.json.version`.

**Consequence:** An unverified checkout can be published; if publication fails, the previous working release has already been marked deprecated. Independent lint and release workflows do not establish that the release job waits for checks on the same commit.

**Fix:** Build a release dependency graph: frozen install, full checks, package dry-run and artifact smoke test, then publication of that tested artifact. Validate tag/version/name. Deprecate only specific intentionally unsupported releases after a successful replacement. Use least-privilege registry authentication appropriate to the selected registry.

**Acceptance:** A failing check prevents publication; a simulated publish failure never deprecates a previous release; a tag/version mismatch fails before registry writes. Exercise these with mocked commands, not a real registry publication.

## B02 — P1: tests do not exercise runtime behavior or public type usage

**Evidence:** `package.json:9–11`, zero-byte `typings/index.test-d.ts`, `.gitignore:70`. The test script runs lint, documentation generation, and declaration checking only. The entire `test/` directory is ignored.

**Consequence:** The confirmed payload, cleanup, crypto, cache, and public-export defects all coexist with passing declaration checks. Future contributors may accidentally leave runtime tests untracked.

**Fix:** Add tracked runtime tests using Node's built-in test runner. Replace the blanket test-directory ignore with ignores for local credentials/fixtures that truly need exclusion. Fill `tsd` with public import, constructor, send/edit, poll, component, event, and nullable-state examples. Check runtime exports alongside declaration use.

**Acceptance:** Each confirmed bug has a failing behavioral regression before its fix and a passing regression after it. Type tests reject invalid inputs and accept supported public usage. Tests run without credentials or a Discord connection.

## B03 — P2: dependency installs and CI are not reproducible

**Evidence:** `.gitignore:84–85` ignores both npm/yarn locks; lint CI uses `npm install` at `.github/workflows/lint.yml:24`. Package ranges float. The local install generated an ignored npm lock.

**Consequence:** Developers and CI can resolve different transitives from the same source commit. A later advisory or incompatible update changes the result without a source change.

**Fix:** Choose one package manager, commit its lockfile, and use frozen installs in CI. Review dependency updates in grouped, testable changes. Preserve a minimal supported runtime matrix.

**Acceptance:** Two clean installs from the same lock have identical dependency versions; CI rejects lock/package drift. Test upgrades against behavioral fixtures, not only lint.

## B04 — P2: advertised Node support is stale and inconsistent with Undici

**Evidence:** `package.json:70–71` accepts Node >=20.18 and README promises 20.18.0, while Undici 7 supports >=20.18.1. CI tests 24, release uses 22, neither tests the claimed minimum.

The [Undici support table](https://github.com/nodejs/undici/blob/main/README.md#long-term-support) documents its minimum. The [Node release schedule](https://github.com/nodejs/Release#release-schedule) marks Node 20 end of life on 30 April 2026. As of this audit, Node 22 and 24 remain supported LTS lines.

**Fix:** For the revamp, target supported Node 22/24 LTS and document exact minimums backed by the dependency graph. If a legacy branch retains 20, correct the patch-level minimum and state its support status. Keep README, engine declaration, CI, and publishing runtime aligned.

**Acceptance:** Import and runtime tests pass at the supported minimum and latest patch of each supported major. Unsupported versions fail with an actionable engine requirement.

## B05 — P2: the existing JSDoc patch is not part of the ordinary developer workflow

**Evidence:** `patches/jsdoc+3.6.11.patch`; package scripts have no patch step; lint CI manually runs `npx patch-package` at line 25.

**Proof:** Fresh-install docs generation failed at `util.isRegExp`; applying the committed patch fixed it. Only `node_modules` was patched for this check.

**Fix:** Prefer moving to a compatible, maintained documentation tool. During transition, make the required patch application explicit and automatic for development installs/validation, without making production installs depend on development-only tools.

**Acceptance:** A documented clean checkout can run checks without an undocumented manual step; API docs still contain supported types and methods. Remove obsolete patches after migrating.

## B06 — P2: Windows line endings break the default lint command

**Evidence:** `.gitattributes:2` contains `* text=auto`; ESLint's Prettier rule requests LF. This machine has `core.autocrlf=true`, so checkout materialized CRLF.

**Fix:** Add explicit LF attributes for source/config/text formats and a matching EditorConfig. Renormalize intentionally in a dedicated formatting change so functional diffs remain reviewable.

**Acceptance:** Fresh Windows and Linux checkouts pass the same lint command. Do not dismiss real lint failures by globally disabling formatting; that override was used only to isolate the audit result.

## B07 — P2: fork identity and documentation still point to the archived upstream

**Evidence:** `package.json:30–33`, `:49–53`; README installation, badges, contribution/help links, and archive notice. Package metadata points to `aiko-chan-ai`, although the reviewed repository is `devrock07`.

**Fix:** Decide the maintained fork's package identity and registry, retain upstream attribution/license notices, and align package metadata, docs, issues, examples, and release target. Publish only under an identity the maintainer controls. State supported and unverified features explicitly.

**Acceptance:** Users can locate this fork's source, issues, docs, and supported installation from the package. Release scripts derive the package name instead of hard-coding the upstream name.

## Tooling cleanup

ESLint 8, TSLint, dtslint, and the documentation dependency stack are old; dtslint is installed but is not invoked. The development audit includes vulnerable transitive packages in these tools. Plan migrations individually, starting with unused tooling removal and the docs generator, then ESLint flat configuration and consolidated type checks. Do not apply `npm audit fix --force` wholesale: the registry's suggested replacements include major changes and even downgrades that require independent review.

Public declarations are maintained separately from runtime CommonJS exports. An AST screen found numerous declared classes/functions absent from the entrypoint; the concrete component and voice examples are documented in [MODELS.md](MODELS.md) and [VOICE.md](VOICE.md). Decide which constructors are truly public, then generate or validate their declarations and export manifest.

## B08 — P2: declaration errors are hidden by the current type-check setup

A standalone check with declaration checking enabled produced 14 diagnostics: seven in this repository's `typings/index.d.ts` and seven in dependency declarations. The package errors include two imports no longer exported by the installed `discord-api-types/v10`, incompatible `IntegrationApplication.bot` inheritance, and interaction/channel constraint mismatches. The same check against the reference fork produced 1,042 diagnostics, including 1,035 in its own declaration file; that fork removed definitions still referenced throughout the API.

To reproduce the baseline independently of the repository's `skipLibCheck:true`:

```powershell
node node_modules/typescript/bin/tsc --noEmit --skipLibCheck false --module commonjs --moduleResolution node --target ES2022 typings/index.d.ts
```

These counts depend on the resolved dependency versions. Raw logs are in `.tmp/audit-models/original-types.log` and `fork-types.log`. Use real public consumer projects as well as declaration checks; distinguish package errors from third-party ambient declaration conflicts, and remove unnecessary development ambient types from consumer validation.

**Fix and acceptance:** Reconcile imported API types and inheritance, restore complete definitions in any selected fork code, and validate public examples with a clean consumer configuration. The type suite must fail on missing exported names and wrong public signatures even when a consumer chooses `skipLibCheck`.

No complete CI run on Linux, minimum-runtime run, package publication, optional codec build, or live service integration was performed.
