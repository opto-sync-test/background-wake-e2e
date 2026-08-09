# DEN-2132 external connectivity proof

This repository is an independent consumer of the connectivity implementation proposed in `opto-sync/opto-sync-clients#73`. It does not trust a mutable branch or rerun only the implementation repository's own unit tests.

`proof-source.json` pins one exact 40-character source commit. CI verifies that the commit is still the open draft PR head, checks out its recursive engine gitlinks, and then consumes the APIs from this separate `opto-sync-test` organization.

## Proof matrix

### TypeScript and JavaScript

- 5,000 deterministic connectivity/offline-mode operations checked against an independent model.
- Real Dexie/fake-IndexedDB durable queue commits.
- Immediate generic and verified-online save hooks.
- Hook exception and rejected-promise isolation.
- Queue-full rejection proving that failed writes emit no save event.
- Metadata leak check using a sentinel payload.
- Real headless Chromium, IndexedDB, browser `online`/`offline` events, and a local HTTP reachability endpoint.
- Probe suppression while total-offline mode is active.
- Single-wake assertion when automatic connectivity is restored.
- Listener teardown assertion after the browser watcher stops.

### Dart and Flutter

- 5,000 deterministic pure-Dart operations checked against the same state model.
- Post-commit wrapper success and failure semantics.
- Offline, link-only, and verified-internet wake behavior.
- Flutter MethodChannel proof with no Material or Cupertino dependency.
- Credential-bearing probe URL rejection.
- Blank consumer app compilation through the public Flutter API.

### Rust and WebAssembly

- 5,000 deterministic operations checked against an independent model.
- Eight concurrent consumer threads delivering 2,000 save and online-save events.
- Panic isolation after durable saves.
- Failed durable-operation suppression.
- Native formatting, tests, and Clippy.
- External `wasm32-unknown-unknown` consumer compilation with the browser feature enabled.

### Android and Apple native builds

- A generated Android Flutter application imports and invokes the public Java facade from Kotlin, then builds a debug APK.
- A generated iOS Flutter application imports the plugin module, invokes the public Swift connectivity and background APIs, compiles the Objective-C bridge sources through CocoaPods, and builds without code signing.

## Running

The GitHub Actions workflow checks out the source tree under `source/`, so local runs use the same layout:

```text
node scripts/resolve-proof-source.mjs
OPTO_SYNC_SOURCE="$PWD/source" node --test tests/typescript/connectivity-proof.test.cjs
cd tests/dart && dart pub get && dart test
cd tests/rust && cargo test --all-targets
cd tests/flutter && flutter pub get && flutter test
```

The scheduled workflow keeps the proof pin honest: if PR #73 moves, this repository fails until it is reviewed and repinned to the new exact commit.
