# Contributing

Use Node 22 or 24 and the committed npm lockfile. Run `npm ci`, make a focused change, then run `npm test`. `npm run build` also generates the API documentation. Runtime fixtures belong in `test/` and must run without Discord credentials. Public declaration usage tests belong in `typings/index.test-d.ts`.

For protocol changes, include recorded/synthetic fixtures for success, failure, cancellation, reconnects and resource disposal. Keep wire data separate from credential-safe diagnostics. Message edits must distinguish omitted fields, explicit null, zero/false, and empty attachment lists.

Run `npm run bench` before proposing performance changes and record the runtime, workload, event/cache correctness, and measurements for both versions. The benchmark is an offline fixture, not evidence of live gateway throughput.

Preserve source attribution and the GPL license. Do not add credentials, generated documentation, package tarballs or personal account data to commits. CI builds a release candidate artifact; publishing requires a separately reviewed package identity and release version.
