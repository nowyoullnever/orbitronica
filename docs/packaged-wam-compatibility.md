# Packaged WAM compatibility gate (G002)

**Status: disabled — no bundled trusted effect is approved.**

## Decision

Orbitronica does not ship or enable an effect catalog in this release. The
existing `WamHost` is an injected, development-only boundary: it initializes
the pinned WAM SDK for each `AudioContext`, accepts a caller-supplied loader,
and can insert the resulting node before an orbit fader. It contains neither a
bundled plugin asset nor a plugin URL resolver. Consequently it cannot prove
that a WAM module (and all its worklet, WASM, GUI, and import assets) loads
from the packaged renderer's `file://` origin.

One **internal-alpha, frozen-artifact candidate** has passed a production
Electron `file://` temp-path probe, but is not selected or enabled for the
catalog: **Burns Simple Delay** from `burns-audio-wam@0.2.54` (MIT). The probe
covered `fetch(file:)`, host initialization, instance creation, state,
GUI, and destruction without `SharedArrayBuffer`. It does not make the effect
packaged: its assets are not under `dist`, and the builder artifact has no
candidate-specific executable smoke. The WAM API's internal alpha.4 and host
alpha.6 compatibility is accepted only for this exact frozen artifact; rerun
the smoke on every upgrade.

| Frozen candidate evidence | SHA-256 |
| --- | --- |
| `burns-audio-wam@0.2.54` tarball | `03dbe1a9891482e43b16392832eeea675e8468d019d4a212cf5d6dda2300595d` |
| Simple Delay index | `a1504e26e0591e3795b248cf42c9897f694558ca541f85e168e2a2664eef3457` |
| Simple Delay descriptor | `179fd4c0a60af4a8647e935e53bb6a61f652991058a849f392ffd735ef661435` |

## Compatibility requirements before enablement

An effect may be added only when all of the following have been recorded for
the exact source revision and packaged asset set:

1. **WAM 2 contract:** its loader exposes `createInstance(context)` and each
   instance supplies `audioNode`, `getState()`, and `setState()` as required by
   `src/renderer/audio/wamHost.ts`. Any optional GUI must be independently
   safe to mount.
2. **License and provenance:** the upstream URL, immutable revision, license
   text/SPDX identifier, and redistribution terms permit bundling every
   plugin-owned asset (including transitive worklets/WASM).
3. **Packaged asset layout:** files live under the Electron Builder `files`
   output, are addressed with URLs derived from the packaged renderer rather
   than dev-server paths, and their manifest lists each worklet/WASM/import
   dependency.
4. **`file://` smoke:** an `electron-builder --dir` artifact launches without
   `--dev`, loads the exact module and its `AudioWorklet` assets, instantiates
   it in a real `AudioContext`, exercises state round-trip and cleanup, and
   records console/network failures.
5. **Failure limits:** a future catalog must define bounded loader timeout,
   queue/backpressure, and retry/circuit-breaker behavior. The current host
   caches only successful/in-flight per-context module promises and retries a
   rejected load; it supplies none of those limits.

## Current pinned evidence

| Component | Declared version | Resolved version | Lock integrity |
| --- | --- | --- | --- |
| `@webaudiomodules/sdk` | `0.0.12` | `0.0.12` | `sha512-8eV+7wX8Wjrkjs3sIysq508ehS4mBEkLdwk8xinY3IXGi/zvWIfoipbWfvQ+AsaKnN3hBMGZI0AgLf1GlApBIA==` |
| Electron | `^33.2.1` | `33.4.11` | `sha512-xmdAs5QWRkInC7TpXGNvzo/7exojubk+72jn1oJL7keNeIlw7xNglf8TGtJtkR4rWC5FJq0oXiIXPS9BcK2Irg==` |
| Electron Builder | `^25.1.8` | `25.1.8` | `sha512-poRgAtUHHOnlzZnc9PK4nzG53xh74wj2Jy7jkTrqZ0MWPoHGh1M2+C//hGeYdA+4K8w4yiVCNYoLXF7ySj2Wig==` |

The package configuration packages `dist/**/*`, `dist-electron/**/*`, and
`package.json`. There is currently no plugin asset directory, origin manifest,
or third-party effect hash to verify. The SDK npm integrity above authenticates
the SDK tarball only; it does not authenticate a future effect.

## Packaged proof gate

`npm run build` is the artifact-producing smoke prerequisite: it type-checks,
verifies the preload, builds Vite, then invokes `electron-builder --dir`. It
passed on 2026-07-12 and produced `dist/mac-arm64`, but it is not candidate WAM
proof because Burns Simple Delay is neither bundled nor invoked from that
artifact. The enabled gate therefore remains **disabled**, with the precise
blocker: the frozen candidate's assets are absent from `dist` and no
builder-executable `file://` loader/asset smoke harness exists.

## Limits of existing code

`WamHost`'s retry-on-rejection behavior is covered by unit tests. It does not
provide a timeout, queue limit, circuit breaker, asset hash verification,
license validation, or a production catalog. Do not infer any of those from
the development insertion API.
