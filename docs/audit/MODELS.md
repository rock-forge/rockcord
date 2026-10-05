# Models, managers, and actions audit

Audit-only review on 2026-10-04. Runtime source and published typings are unchanged. All reproduction requests are local stubs, with no Discord login, token, or network request.

## Scope and evidence

- Inventory/pattern screening: 38 manager files (7,420 lines), 111 structure/interface files (24,171 lines), 61 action files (2,110 lines). Total: 210 JavaScript files and 33,701 lines.
- Deep review concentrated on messages, payload construction, uploads, components, polls, reactions, user/member patches, settings, threads, cache managers, channel/guild management, and the related action/declaration paths.
- Matching public declarations were examined in `typings/index.d.ts`; the public export map in `src/index.js` was checked against new component classes.
- Offline evidence: `docs/audit/repro/models.cjs`, run successfully with Node v24.15.0 using installed dependencies. The script logs 17 observations for the failure groups below. It is an audit demonstration, not a passing regression test suite. Outputs explicitly reproduce current buggy behavior.
- This is broad screening plus focused review, not an exhaustive proof that every one of the 210 files is correct. No live Discord, gateway session, upload, payment, account-setting write, or moderation operation was attempted. Current official API contracts were inspected where needed; undocumented user-account endpoints remain unverified.

## Prioritized confirmed bugs

### M01 — P1: content-only edits request deletion of every attachment

**Location:** `src/managers/MessageManager.js:150` (the upload block starts at line 131); `src/structures/MessagePayload.js:208` holds the retained attachment array before it is overwritten. `src/structures/Message.js:728` explicitly documents preservation when attachments are omitted.

**Trigger:** `message.edit({ content: 'updated text' })`, or editing with `attachments` set to an explicit list of existing attachment IDs.

**Proof:** `Util.getUploadURL` returns `[]` for no files (`src/util/Util.js:855`). `MessageManager.edit` unconditionally assigns this upload list to `data.attachments`. The offline stub captures `{content:'plain content-only edit', attachments:[]}`. A second reproduction starts with a retained attachment ID and also captures `attachments:[]`.

**Impact:** Text edits, embed suppression and other edits can silently remove previously attached files. Explicit keep lists are discarded. File addition also fails to preserve requested existing files.

**Fix:** Preserve omission when neither retained attachments nor new files are provided. When files are uploaded, merge upload descriptors with the requested retained descriptors; do not replace the entire array. Decide the public default for adding files based on the existing preservation contract, including the uncached-message case.

**Regression:** Capture edit payloads for content-only edits, explicit keep lists, explicit empty lists, and retained-plus-new files. Assert omissions are distinct from `[]`, retained IDs survive, and requested deletions remain possible.

**API support:** [Discord Edit Message](https://docs.discord.com/developers/resources/message#edit-message) specifies that the attachment field selects files retained after editing.

### M02 — P1: reading a forwarded snapshot overwrites the live source cache

**Location:** `src/structures/Message.js:403` in snapshot parsing (lines 387–408).

**Trigger:** Receive or construct a forwarded message whose original channel and message are cached.

**Proof:** Snapshot data uses the source message ID, then calls the channel's normal `messages._add(snapshotData)` with caching enabled. `CachedManager._add` patches the existing source object (`src/managers/CachedManager.js:48`). Offline: the original content changes from `live original` to `past snapshot` during parsing; `forwarded.messageSnapshots.get(sourceId) === original` is true. Editing the original then changes the supposed snapshot to `new edit`.

**Impact:** A read of historical forwarded data corrupts the current source message, and historical content changes whenever the live object changes. Returning a source cache entry can also expose its author and unrelated live properties as snapshot data.

**Fix:** Build independent snapshot instances outside the live cache, preserving the snapshot's own timestamp. Avoid `messages._add` entirely for snapshots, including `cache:false` if that would clone existing live fields. Keep each snapshot independent of subsequent source patches.

**Regression:** Cache a source, parse an older forward, assert source content is unchanged and snapshot identity differs, update the source, assert snapshot content remains fixed. Also exercise uncached source/channel behavior.

**API support:** [Discord Message Reference Content Attribution](https://docs.discord.com/developers/resources/message#message-reference-content-attribution) describes snapshots as immutable copies.

### M03 — P1: the new pinned-message endpoint is parsed as the wrong object

**Location:** `src/managers/MessageManager.js:89`.

**Trigger:** `channel.messages.fetchPinned()` against the `/channels/:id/messages/pins` response.

**Proof:** The new endpoint returns pin wrappers containing `pinned_at` and `message`. The loop feeds the wrapper to `_add` and reads the wrapper's nonexistent `id`. An offline response with two pins becomes one entry keyed by `undefined`, containing a message with null content. This also pollutes the normal cache under `undefined`.

**Impact:** Pin fetching loses messages and inserts invalid cache entries. `has_more` is also ignored, so the API offers no means to retrieve pins after the first 50.

**Fix:** Unwrap each `pin.message` before constructing and keying a `Message`. Preserve any pin timestamp in a separate result model if exposed. Add explicit pagination options or fetch all pages while maintaining the legacy collection-return contract.

**Regression:** Stub zero, one and two wrappers and assert all real IDs/content are returned and no undefined cache key exists. Exercise `has_more:true` with a second page.

**API support:** [Discord Message Pin Object](https://docs.discord.com/developers/resources/message#message-pin-object) and [Get Channel Pins](https://docs.discord.com/developers/resources/message#get-channel-pins).

### M04 — P2: every poll-voter fetch throws before reaching the request layer

**Location:** `src/managers/MessageManager.js:415`; `src/structures/PollAnswer.js:77` delegates to it.

**Trigger:** `poll.answers.first().fetchVoters()` or `channel.messages.fetchPollAnswerVoters(...)`.

**Proof:** It calls `this.client.channels(...)`. `Client.channels` is a `ChannelManager` (`src/client/Client.js:122`), not the REST route function. Offline failure: `this.client.channels is not a function`.

**Impact:** The whole voter-fetch feature is unusable.

**Fix:** Route through `this.client.api.channels(this.channel.id).polls(messageId).answers(answerId)`, maintaining query and user-result mapping. Validate message and answer IDs consistently with the other manager methods.

**Regression:** Use a route spy and assert path, query, returned user collection and cache behavior. Confirm an omitted voters option object has the documented behavior.

**API support:** [Discord Poll Resource](https://docs.discord.com/developers/resources/poll#get-answer-voters).

### M05 — P2: Components V2 are declared publicly but nine constructors are absent at runtime

**Location:** `src/index.js` export map; declarations `typings/index.d.ts:2397`, `:2403`, `:2411`, `:2417`, `:2424`, `:2431`, `:2437`, `:2444`, and `:2461`.

**Trigger:** Import `ContainerComponent`, `FileComponent`, `SectionComponent`, `TextDisplayComponent`, `ThumbnailComponent`, `MediaGalleryComponent`, `MediaGalleryItem`, `UnfurledMediaItem`, or `SeparatorComponent` from the package.

**Proof:** Every listed value is `undefined` in the package's public exports, although all are public classes in the declarations. Offline reproduction imports the normal package entrypoint and records each missing export.

**Impact:** TypeScript accepts public imports that fail at runtime; users cannot construct the newly modeled components through the supported package entrypoint.

**Fix:** Export the classes consistently from the entrypoint and reconcile the related declarations as one feature. `SectionComponent.accessory` is singular at runtime but declared as `AccessoryType[]` (`typings/index.d.ts:2449`). `ContainerComponent` constructor accepts `ComponentInContainer` instead of a container instance (`:2462`). Message component options remain action-row-only (`:7314`, `:7442`), send flags exclude `IS_COMPONENTS_V2` (`:7449`), and `poll?: Poll` (`:7450`) should use creation data (`PollData` exists at `:2829`).

**Regression:** Public-entrypoint runtime import test plus meaningful `tsd` examples constructing and sending each new component, a single section accessory, Components V2 flags, and a poll creation payload. Derive/validate a public-export manifest to catch future declaration-only additions.

### M06 — P2: V2 serialization drops required file data and configured container color

**Location:** `src/structures/FileComponent.js:43`; `src/structures/ContainerComponent.js:62`.

**Trigger:** Serialize an API-shaped file component or colored container, including components read from messages and sent again.

**Proof:** `FileComponent.setup` stores `this.file` at line 28 but `toJSON` returns `file:this.content`, which is undefined. `ContainerComponent.setup` stores `this.accentColor` at line 35 but `toJSON` returns `accent_color:this.accent_color`, also undefined. Offline JSON for a real attachment reference has no `file` key; container JSON has no configured color.

**Impact:** File components generate invalid outbound payloads, and container appearance is lost on serialization. These are separate implementation mistakes within the same serialization feature.

**Fix:** Serialize `this.file.toJSON()` and `this.accentColor`. Roundtrip normalized properties consistently, including component IDs and copying from an existing component. `UnfurledMediaItem.toJSON` currently spreads its initial `data`, so changing the public `url` also does not update serialized output; cover that during the same work.

**Regression:** Construct every supported component from an API fixture, serialize, and compare the fields relevant to the API contract. Test color `0`, nonzero color, attachment URLs, copying from component instances and changing a media item's URL.

**API support:** [Discord File Component](https://docs.discord.com/developers/components/reference#file) and [Container Component](https://docs.discord.com/developers/components/reference#container) field contracts.

### M07 — P2: reaction counts do not decrement for the logged-in user or refresh from fetched data

**Location:** `src/structures/MessageReaction.js:166` and `:66`; related burst add gate at `:152`.

**Trigger:** Process removal of the current user's reaction, or refresh a reaction with a new total count.

**Proof:** `_remove` skips decrement when `this.me` is true and the user is the current user, then clears `this.me`. Offline: a normal count of 5 stays 5 after own removal, although `me` becomes false. `_patch` uses `this.count ??= data.count`, so an existing count of 5 stays 5 when fetched data says count 2; `countDetails.normal` does update to 2. The add gate likewise keys normal and burst changes off the normal `me` flag instead of the relevant type.

**Impact:** Counts become permanently stale or disagree with their normal/burst breakdown; removal and collector behavior become unreliable. Normal and burst reactions by one user can interfere.

**Fix:** Assign authoritative counts when patching fetched data. Distinguish normal and burst membership/state when handling optimistic REST updates and gateway add/remove events, then decrement the matching count for genuine removals. Avoid double counting when an optimistic response and gateway confirmation both occur.

**Regression:** Own and other-user add/remove, normal and burst, both types held by one user, optimistic-plus-gateway duplication, refresh from 5 to 2, and deletion when the count reaches zero.

### M08 — P2: cached message fetch violates its Promise return contract

**Location:** `src/managers/MessageManager.js:248`; public method `:66`; declaration `typings/index.d.ts:4823`.

**Trigger:** `channel.messages.fetch(id).then(...)` after that message has been cached and is complete.

**Proof:** `_fetchId` is not async and returns `existing` directly for a cache hit; only the uncached path returns a Promise. Offline `typeof result.then` is `undefined` for the cache hit.

**Impact:** A documented API example fails depending on cache state; the same code works on a first fetch and throws after caching.

**Fix:** Make `_fetchId` async, return `Promise.resolve(existing)`, or normalize the public fetch return to a Promise without changing the collection-fetch behavior.

**Regression:** Both cached and uncached `fetch(id)` return thenable results resolving to a Message; force and cache=false behaviors remain correct.

### M09 — P2: valid digit-bearing select-menu custom IDs are treated as row indexes

**Location:** `src/structures/Message.js:1133` and `:1137`.

**Trigger:** `message.selectMenu('menu1', ['a'])` for a present valid select component.

**Proof:** `/[0-4]/.test(menu)` matches any occurrence of a digit 0–4, so `menu1` is used as an array property. The subsequent `selectMenu.minValues` dereference throws. Offline fixture reproduces `Cannot read properties of undefined (reading 'minValues')`. The alternate string branch only searches one level of rows, even though button lookup already traverses V2 containers.

**Impact:** Common custom IDs containing digits cannot be used; selects nested in V2 containers cannot be found reliably. Missing, disabled, or malformed matches produce raw TypeErrors.

**Fix:** Distinguish integer row indexes by value/type rather than substring regex; define whether numeric strings represent custom IDs for compatibility. Reuse the recursive component resolver for string IDs, then validate matched component type, disabled state and option values before dereferencing.

**Regression:** Custom IDs `menu1`, `12345`, plain alphabetic IDs, valid integer indexes, missing IDs, disabled selects and nested V2 containers.

### M10 — P2: restricted-guild setting helpers reference an uninitialized property

**Location:** `src/managers/ClientUserSettingManager.js:354`, `:367`, `:368`; real property initialized at `:214`, declared at `typings/index.d.ts:4498`.

**Trigger:** Call `addRestrictedGuild` or `removeRestrictedGuild` after a settings patch containing `restricted_guilds`.

**Proof:** `_patch` initializes `disableDMfromGuilds`, but the helper methods use `disableDMfromServer`. The offline add helper throws when reading `.map`. Remove throws when reading `.delete` by the same reasoning.

**Impact:** Privacy-setting helpers fail before sending updates. If simply renamed without further changes, removal mutates the cache before awaiting the API and would still leave state incorrect on rejected requests.

**Fix:** Use the real property, initialize a collection for pre-fetch behavior, resolve guild objects/IDs as declared, and stage changes in a copy until the request succeeds. Use accurate error wording when a guild is already present or absent.

**Regression:** Add/remove with populated and empty settings, Guild object and ID inputs, duplicate/absent IDs, and rejected API writes preserving prior cache state.

## Additional reproduced issues worth including in the repair backlog

- **P2 — partial user/member patches lose correct field semantics.** `src/structures/User.js:145` uses a truthiness check around another identical check, so the branch that clears decoration data is unreachable. An explicit `avatar_decoration_data:null` leaves the old decoration. `src/structures/User.js:202` similarly preserves stale collectibles on an explicit null. `src/structures/GuildMember.js:108` resets `pending` to false on any patch that omits it, while `:134` clears a decoration on any patch that omits it. Offline a nickname-only patch clears a previously true pending flag and real decoration. Use field-presence checks, preserve omitted values, and clear explicit nulls. Test omission, null, false, zero and actual values across all patchers.
- **P2 — null custom status crashes.** `src/managers/ClientUserSettingManager.js:279` treats null as an object and eventually dereferences `options.text` at `:306`. Offline `setCustomStatus(null)` throws, despite nullable JSDoc at `:275`. Change to `options == null || typeof options !== 'object'` according to the intended clear-status contract and add a null regression/type example. The separate status write at `:327` is fire-and-forget and can cause an unhandled rejection; combine settings into a single awaited edit where possible.
- **P2 — selfbot forum uploads have the attachment descriptors in the wrong place (source-proven, not reproduced in this script).** `src/managers/GuildForumThreadManager.js:98` places uploaded file descriptors in top-level `attachments`, while the starter message body retains only placeholder IDs from MessagePayload. `GuildForumThreadManager.create` should pass the completed uploaded attachment descriptors in `message.attachments`. Shared upload preparation for sends, edits and forum posts would prevent this divergence. Verify this shape against the specific user API as part of implementation before relying on a live fix.

## Architecture and revamp direction

### Preserve the useful foundation

- Resource managers, structures and gateway actions already separate API methods, data representation and incoming-event cache updates. This offers useful seams for offline route/event fixtures and targeted repairs.
- `CachedManager` supports cache policy injection and return-without-caching behavior. Do not discard this merely to make the code look new; improve its explicit update/copy contract.
- Snowflake/string IDs and existing manager naming provide broad compatibility with a v13-style consumer API. A later breaking version can improve consistency after the faults are isolated by regressions.
- Polls, newer channel types, Components V2 and burst reactions have at least an initial model layer, so repairs can complete features already present instead of inventing another abstraction.

### Main risks to address

- Upload preparation is copied into channel send, message edit and forum create; different copies now disagree about attachment placement and preservation. Centralize resolved-file uploads and merge behavior with an explicit create/edit/post mode.
- API field names, normalized property names and declaration types drift independently. Use canonical payload schemas/serializers, fixture roundtrips and runtime-export/type parity checks.
- Patching semantics mix omission, null, false and defaults. Establish the invariant “omitted means preserve, explicit null means clear” wherever the API uses partial updates; audit all patchers under that invariant.
- Live caches and historical/copy structures are mixed. Keep forwarded snapshots outside live caches and ensure old/new event copies cannot share mutable nested data when independence is promised.
- Reaction behavior mixes optimistic REST updates, gateway events and normal/burst bookkeeping. Make the reconciliation rules explicit before expanding more interactions.
- Circular CommonJS requires make direct internal entrypoint loading fragile (the reproduction first failed when requiring Message before the package entrypoint, then succeeded through the normal public entrypoint). Public exports are the supported path; a module-dependency cleanup would improve independent testing and a future ESM transition.
- Undocumented account-specific endpoint behavior, older bot-era methods, newer official API models and hand-maintained declaration files share the same surface. Introduce clear supported-feature status and avoid claiming every declared method is currently functional.

Suggested order: attachment/snapshot/cache integrity first; broken public features and Promise behavior next; patch/reaction consistency after that; then deduplicate uploads, align public schemas/types/exports, and plan any breaking API redesign with migration examples.
