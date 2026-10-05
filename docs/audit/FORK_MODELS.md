# Youtsuho fork: models/managers/actions comparison

Compared `F:/djs` with `.tmp/reference-youtsuho`, commit `fd66246dfd5750cf2a80e1a25355a093d3cfac7f`, package version `3.7.8`, repository [youtsuhodev/discord.js-selfbot-youtsuho-v13](https://github.com/youtsuhodev/discord.js-selfbot-youtsuho-v13).

**Verdict for this scope:** the fork adds functionality, but it does not fix any of the ten prioritized model/manager failures in the original findings. Some additions introduce serious restore and declaration regressions. Select improvements are worth adapting; a wholesale replacement of the base would carry its known defects forward.

No runtime edits were made. No login, Discord requests, guild modifications, backup restoration against real data, or quest/reward operations were performed. Offline proof: `docs/audit/repro/fork-models.cjs` runs successfully with 10 observations using only stub objects. The original proof remains `docs/audit/repro/models.cjs`.

## Coverage

`git diff --no-index` comparison establishes:

- All 61 existing action files are unchanged.
- All 38 existing manager files are unchanged. Six manager/helper files were added, comprising 2,258 lines: `BackupManager.js`, `QuestManager.js`, and four `managers/backup` helpers.
- Six of 111 existing structure/interface files differ: DMChannel, GroupDMChannel, MessageMentions, MessageSelectMenu, Poll and TextBasedChannel. The remaining files, including Message, MessagePayload, User, GuildMember, MessageReaction and all V2 component structures, are unchanged.
- The public export map adds four optimization utility names and global process hooks, but no V2 component constructors.
- The declaration diff contains 508 inserted and 3,103 deleted lines. Added backup code was reviewed deeply. QuestManager was screened for state, async and cancellation behavior, without attempting the account-specific workflows. This report does not cover the fork's REST, worker, gateway or native voice internals; those need the complementary audits.

## What remains broken

The original finding IDs below refer to [MODELS.md](MODELS.md); their runtime locations are identical in the fork because the source files are unchanged.

| Original finding | Fork status | Evidence |
| --- | --- | --- |
| M01: content-only edits erase attachments | Remains | `managers/MessageManager.js:150` still overwrites attachments with the upload list. |
| M02: forwarded snapshot overwrites live source cache | Remains | `structures/Message.js:403` still calls the source channel's caching `_add`. |
| M03: pins parsed without unwrapping `pin.message` | Remains | `managers/MessageManager.js:89` unchanged. |
| M04: poll-voter fetch calls ChannelManager as function | Remains and exposed by another method | `managers/MessageManager.js:415` unchanged; new `Poll.fetchVoters` delegates to it at `structures/Poll.js:116`. |
| M05: V2 constructors missing from public exports | Remains | Nine component classes are still absent from `src/index.js`. New Quest, QuestManager, BackupCacheManager and BackupManager declarations also have no matching public exports. |
| M06: file/color serialization reads wrong properties | Remains | `structures/FileComponent.js:43` and `structures/ContainerComponent.js:62` unchanged. |
| M07: own-reaction removal/refresh count bugs | Remains | `structures/MessageReaction.js:66`, `:152`, `:166` unchanged. |
| M08: cache-hit message fetch returns non-Promise | Remains | `managers/MessageManager.js:248` unchanged. |
| M09: digit-bearing select IDs treated as indexes | Remains | `structures/Message.js:1133` unchanged; changing MessageSelectMenu serialization does not repair interaction lookup. |
| M10: restricted-guild helpers use wrong property | Remains | `managers/ClientUserSettingManager.js:354` and `:367` unchanged. |

The additional original patcher, null-custom-status and forum-attachment defects also remain unchanged.

## Improvements to consider selectively

- **Select serialization is more accurate by type.** `structures/MessageSelectMenu.js:90` builds a shared payload and adds `options` only for string selects, `channel_types` only for channel selects. The offline channel-select fixture shows the original includes an irrelevant `options:[]`, while the fork omits it. Worth adapting with roundtrip fixtures, explicit default/min/max handling and a fix for existing camel-case `channelTypes` input support.
- **Mention parsing removes use of a mutable shared regex cursor.** Replacing `.exec` loops with `matchAll` can simplify parsing, but the fork regresses null partial-message content. Adapt only with a string/null guard and tests; do not copy the change verbatim.
- **Poll convenience methods:** `Poll.active` (`structures/Poll.js:85`) and `Poll.fetchVoters` (`:115`) offer a small usable API improvement after repairing the manager. The declaration for Poll at `typings/index.d.ts:3294` contains neither new member. A fallback layout string is also added at `Poll.js:58`; preserve unknown future layouts intentionally instead of silently assuming all unknown layouts are the default.
- **DM and Group DM `stopRinging`:** added at `structures/DMChannel.js:164` and `structures/GroupDMChannel.js:321`. These should be evaluated against the relevant user API and declared on those types before adoption. The fork declares a separate Client helper but lacks the two channel methods.

The backup and quest additions represent new product scope, not repairs of the original model failures. They should not precede fixes to core payload/cache behavior.

## New confirmed problems

### F01 — P1: a default backup roundtrip deletes resources the default backup excluded

**Locations:** `managers/backup/index.js:18` defaults `doNotBackup` to bans and emojis; `:108` defaults `clearGuildBeforeRestore` to true; `managers/backup/util.js:352` deletes all cached emojis and `:364` unbans users. The excluded sections remain empty arrays in the backup (`backup/index.js:45–46`).

**Proof:** Offline default creation yields `emojis:[]` and `bans:[]`. The exact `clearGuild` used by default load nonetheless calls the emoji delete stub and unban stub. No excluded resources can subsequently be reconstructed from the default backup.

**Impact:** Normal default backup/load can permanently lose emojis and remove ban protections even though those resources were intentionally excluded. `doNotBackup` is not recorded as a restoration policy; passing an omission option at load does not stop clearGuild from clearing that resource.

**Fix:** Record a versioned manifest of included sections. Build a restore plan that only clears/replaces sections actually present and explicitly selected for replacement. Default to a nondestructive, validated restore plan; require explicit destructive restore intent in the product API. Validate the backup schema and target permissions before mutation begins.

**Regression:** Default and explicit exclusions preserve existing excluded resources. Empty-included and omitted sections are distinct. Reject invalid backups before any deletion stub is called.

### F02 — P1: private backup threads restore as public threads

**Location:** `managers/backup/util.js:321` restores only thread name and archive duration. Saved type/state fields are recorded at `:145–152` but ignored. Existing `managers/GuildTextThreadManager.js:72` defaults to public.

**Proof:** An offline saved `GUILD_PRIVATE_THREAD` with locked/archived state and slowmode produces a create payload containing only `{name:'confidential',autoArchiveDuration:1440}`.

**Impact:** Confidential thread data can move into a public thread during restoration. Archived, locked and slowmode settings are also lost. When a text parent has no restored messages, a webhook is never created; thread messages then are never restored (`util.js:303–326`).

**Fix:** Preserve supported thread type and state, validate target capabilities, and fail clearly when private preservation is impossible. Restore independent messages even when the parent has none. Maintain an old-ID-to-new-ID mapping, then restore membership/access decisions explicitly.

**Regression:** Private/public threads preserve their type and accessibility policy; archived/locked/slowmode state is restored; thread-only message histories survive with an empty parent history.

### F03 — P1: clearing returns before deletions finish, so restore races pending destructive work

**Location:** `managers/backup/util.js:340–389`, particularly unawaited deletion calls at `:344`, `:348`, `:352`, `:358` and `:364`, plus settings writes at `:367–388`.

**Proof:** The offline role-deletion stub remains pending, but `await clearGuild(guild)` finishes with `deleteFinished:false`. `backup.load` then immediately starts new config and role creation (`managers/backup/index.js:117`), assuming the clear has completed.

**Impact:** New config can be overwritten by late reset writes; old/new resources and caches overlap unpredictably. Errors are mostly swallowed, and the restore can return success after failing to clear or recreate resources.

**Fix:** Await bounded deletion/reset tasks, return a structured outcome for every operation, stop dependent restore stages on failure, and use explicit ID mappings rather than name guesses. Avoid unbounded simultaneous mutation when order matters.

**Regression:** Delayed deletion blocks the next restore stage; rejected deletion propagates or produces an explicit partial-failure result; no restore success is reported while destructive tasks remain pending.

### F04 — P2: unsupported channel types are silently converted into voice channels

**Location:** `managers/backup/create.js:109`, `managers/backup/util.js:53`.

**Proof:** `fetchAnyChannelData` recognizes only text/news, forwarding everything else to `fetchVoiceChannelData`, whose output hardcodes `GUILD_VOICE`. Offline both a forum and a stage channel are backed up as voice channels.

**Impact:** Forums/media channels lose post/tag defaults and are restored as unrelated voice resources; stage channels lose their type. Category child iteration also lacks the exclusion checks used for top-level channels.

**Fix:** Explicit serializers and restorers per supported type. Preserve numeric/string type identity; reject or mark unsupported resources in the manifest instead of converting them.

**Regression:** Forum, media, stage, text, news, category and voice fixture roundtrips preserve type and relevant settings; unsupported types produce visible warnings/failures in the planned result.

### F05 — P1: declaration rewrite removes hundreds of type definitions

**Location:** `typings/index.d.ts` deletion of core definitions; remaining references include ClientOptions at `:1009`, TopLevelComponent at `:2419`, MessageEditOptions at `:2460` and MessageOptions/MessageTarget at `:3197`/`:3205`.

**Proof:** Identical standalone compiler invocation and installed dependencies:

```text
node node_modules/typescript/bin/tsc --noEmit --skipLibCheck false --module commonjs --moduleResolution node --target ES2022 typings/index.d.ts
```

Original: 14 diagnostics (7 source and 7 dependency-library issues). The same command using `.tmp/reference-youtsuho/typings/index.d.ts`: 1,042 diagnostics (1,035 source and 7 dependency issues), with extensive TS2304 missing-name failures. Logs: `.tmp/audit-models/original-types.log` and `.tmp/audit-models/fork-types.log`. The normal package type-test command can nevertheless pass because `skipLibCheck:true` skips declaration checking and the tsd test file is empty; passing that command does not contradict these failures.

**Impact:** Consumers performing declaration checking cannot compile the package; common options, resource names and generic types are missing. Skipping library checks conceals the unresolved API surface rather than completing it.

**Fix:** Keep the complete original type definitions and merge individually reviewed new APIs. Repair baseline version compatibility separately. Add declaration checking and public export parity as required CI steps.

**Regression:** Both the package's type tests and a small downstream TypeScript consumer pass with declaration checking enabled; every declared runtime class has a public value export.

### F06 — P2: partial-message mentions now throw on null content

**Location:** `structures/MessageMentions.js:170` and `:186`.

**Proof:** The fork directly invokes `this._content.matchAll`. A partial Message has null content. Offline original getters return empty channel/user collections, while fork getters throw `Cannot read properties of null (reading 'matchAll')`.

**Impact:** Reading mentions on partial cached messages causes a new exception, including messages constructed from missing content and forwarded snapshots.

**Fix:** Parse only strings or use a guarded empty string where that matches the contract. Preserve fresh-regex iteration without assuming message completeness.

**Regression:** Null/undefined/empty content yields empty collections; valid mentions still resolve; shared regex cursor state does not alter subsequent results.

### F07 — P2: simulateTyping is added to User/GuildMember without its required method

**Location:** `structures/interfaces/TextBasedChannel.js:420` invokes `this.sendTyping`; `:531` attaches simulateTyping even in the minimal mixin. User and GuildMember receive that minimal mixin and no sendTyping.

**Proof:** Offline `new ForkUser(...).simulateTyping('hello')` rejects with `this.sendTyping is not a function` immediately, without any request or delay.

**Impact:** The new method is present but unusable on two of the resource types it is installed on. It is also missing from the public declarations.

**Fix:** Restrict the method to actual channels or explicitly resolve a DM before simulating typing for User/GuildMember. Add declarations and cancellation for the waiting period.

**Regression:** Channel, User and GuildMember variants route to the expected typing stub and can be interrupted; absent sendTyping does not produce an unexplained runtime TypeError.

### F08 — P2: numeric zero configuration values are skipped during restore

**Location:** `managers/backup/load.js:33`, `:36`, `:41`.

**Proof:** The offline loader receives valid numeric zero values for verification level, notifications and content filter but sends no settings writes because each guard is truthiness-based. The library's setters accept numeric enum values. Fresh native backups usually store named enum strings, so this primarily affects imported/normalized numeric backup data.

**Fix/regression:** Test field presence instead of truthiness, validate enums, and restore 0, named zero enums and nonzero values correctly.

## Other source-proven concerns to include in the backlog

- `managers/backup/load.js:102–116` silently drops category restore failures; `util.js:259–286` deletes old community channels even when the caller opted out of clearing the guild first. Use a reviewable restore plan and structured failure results.
- Backup permissions identify roles by name (`util.js:36`, `:186`, `:292`), and channel identity is also name-based. Discord allows duplicate names. Replace these joins with persistent original-ID mappings; preserve role position and permission overwrites for members, which currently are omitted.
- Saved base64 attachment contents (`util.js:91–99`) are passed back as raw string attachments (`:230`), which the existing resolver treats as a path/URL rather than binary. Store an explicit encoding marker and decode buffers before upload; test actual base64 fixtures.
- `QuestManager` has unbounded progress loops (`:632`, `:671`, `:722` in this revision) with no cancellation/deadline and launches all selected workflows concurrently (`:1080`). Concurrent voice operations share one client voice state. These are new long-running account workflows, not evidence of improved core correctness. Review cancellation, bounded execution and configuration preservation independently before exposing them as maintained features.
- `src/index.js:5` and `:9` install global unhandled-rejection and uncaught-exception listeners merely by importing the library. This changes every consuming application's failure policy and emits uncontrolled console output. Keep error ownership with the consuming application; logger hooks can be opt-in. The REST/client/voice audit should assess any other import side effects.

## Port recommendation

1. Repair the original attachment, snapshot, pin, poll-voter, reaction, public-export, Promise and selector bugs with offline regression fixtures first; the fork does not replace that work.
2. Adapt select-specific serialization, null-safe mention iteration, and small poll/DM helpers in separate changes with complete public declarations.
3. Preserve a complete declaration surface and run downstream type checks. Avoid importing the fork's truncated file wholesale.
4. Treat backup restoration as a separate feature requiring a versioned schema, preflight plan, correct identity mappings, awaited mutations and roundtrip tests. The current implementation is not a dependable revamp foundation.
5. Compare batching/workers/lazy-manager and DAVE code through their own audits before adopting them; the model scope establishes neither their performance benefit nor their safety/correctness.
