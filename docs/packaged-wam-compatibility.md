# Packaged WAM compatibility gate (G009)

**Status: enabled-file — the trusted catalog contains immutable Burns Simple Delay and Burns Simple EQ artifacts plus first-party Orbitronica Filter and Orbitronica Overdrive, plus first-party Orbitronica Compressor.**

## Decision

Orbitronica may use only the catalog entries committed under `public/wam/`:
immutable **Burns Simple Delay** and **Burns Simple EQ** payloads, plus
first-party **Orbitronica Filter**, **Orbitronica Overdrive**, and **Orbitronica Compressor** payloads.
It is not an installer and accepts no project-, preference-, IPC-, or
user-supplied plugin URL. **Orbitronica Overdrive is the sole bundled
distortion/overdrive path; Burns Distortion is not bundled.** Vite copies the
catalog into `dist/wam/`; Electron Builder packages the result because
`dist/**/*` is its only renderer input. The gate is limited to these audited
file-origin artifacts and does not authorize arbitrary WAM modules.

| Frozen candidate evidence | SHA-256 |
| --- | --- |
| `burns-audio-wam@0.2.54` tarball | `03dbe1a9891482e43b16392832eeea675e8468d019d4a212cf5d6dda2300595d` |
| Simple Delay index | `a1504e26e0591e3795b248cf42c9897f694558ca541f85e168e2a2664eef3457` |
| Simple Delay descriptor | `179fd4c0a60af4a8647e935e53bb6a61f652991058a849f392ffd735ef661435` |
| Simple Delay screenshot | `a5a1c2035a53c2e650121488321b1970d869f2c845e781dc24772f3fed8a03f6` |

- Source: `https://github.com/boourns/burns-audio-wam`
- Package/version: `burns-audio-wam@0.2.54`
- License: MIT (as declared by the package registry)
- Plugin descriptor: `com.sequencerParty.simpleDelay`, version `1.0.0`, stereo
  effect (`isInstrument: false`, audio input/output enabled).
- WAM SDK: `@webaudiomodules/sdk@0.0.12`.

The `public/wam/*/manifest.json` files are the allowlist. Vendored Burns
manifests record their complete hash-locked payloads and first-party manifests
are copied byte-for-byte from their canonical source. `npm run verify:wam-assets`
hashes the source catalog; `npm run verify:wam-assets -- dist` repeats the same
check on build output. Any additional, missing, renamed, or changed asset fails
verification.

## Packaged file-origin proof

Run `npm run smoke:packaged-wam`. It builds with `electron-builder --dir`,
verifies copied hashes, then launches the unpacked executable with
`--wam-smoke` (not `--dev`). The production renderer loads each catalog entry
from `file://…/dist/wam/` and proves all of the following on one real
`AudioContext`:

1. recorder `orbitronica-pcm-capture` worklet registration and WAM host
   registration coexist;
2. every catalog entry imports its descriptor and creates an instance;
3. state round-trips; the seven Burns EQ controls use its exposed upstream
   parameter-manager state API and the four Orbitronica Overdrive controls use
   its first-party state API;
4. asynchronous `createGui()` returns an `HTMLElement`, followed by
   `destroyGui(gui)`;
5. the WAM audio node is destroyed and the context closes.

Most recent proof: **2026-07-13**, macOS arm64 unpacked output, marker:

```json
{"status":"pass","origin":"file:","recorderAndWamSharedContext":true,"stateRoundTrip":true,"asyncGuiLifecycle":true,"destroyed":true,"sharedArrayBuffer":false}
```

The proof deliberately reports `sharedArrayBuffer: false`: COI/SAB remains an
optional Phase 5B optimization and is not a requirement for this enabled-file
gate.

## Boundaries that remain closed

This proof does **not** validate `app://`, CSP/COEP, WASM, remote imports, or
any unlisted plugin. It also does not add runtime queue,
loader deadline, retry/circuit-breaker, persistence, or user-install policy.
Those requirements remain mandatory before catalog expansion. If the package,
manifest hash, Electron, WAM SDK, Vite asset handling, or builder layout
changes, set this gate back to `disabled` until the smoke is rerun.

## Timing compensation exclusion

Plugin delay compensation (PDC), including `audioNode.getCompensationDelay()`,
is intentionally excluded from this MVP. Chains run correctly within an orbit,
but different orbit chains may have different plugin latency and can cause
inter-orbit drift. Do not imply sample-accurate inter-orbit alignment
until a separate compensation design and regression matrix are approved.
