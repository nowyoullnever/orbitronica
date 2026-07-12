# Packaged WAM compatibility gate (G009)

**Status: enabled-file — Burns Simple Delay is the sole bundled, trusted catalog candidate.**

## Decision

Orbitronica may use **Burns Simple Delay** only from the immutable files in
`public/wam/burns-simple-delay/`. It is not an installer and it accepts no
project-, preference-, IPC-, or user-supplied plugin URL. Vite copies that
folder into `dist/wam/burns-simple-delay/`; Electron Builder packages the
result because `dist/**/*` is its only renderer input. The gate is limited to
this exact file-origin artifact and does not authorize a general WAM catalog.

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

`public/wam/burns-simple-delay/manifest.json` is the allowlist and records the
complete three-file payload. `npm run verify:wam-assets` hashes the source
payload; `npm run verify:wam-assets -- dist` repeats the same check on build
output. Any additional, missing, renamed, or changed asset fails verification.

## Packaged file-origin proof

Run `npm run smoke:packaged-wam`. It builds with `electron-builder --dir`,
verifies copied hashes, then launches the unpacked executable with
`--wam-smoke` (not `--dev`). The production renderer loads
`file://…/dist/wam/burns-simple-delay/index.js` and proves all of the following
on one real `AudioContext`:

1. recorder `orbitronica-pcm-capture` worklet registration and WAM host
   registration coexist;
2. Simple Delay imports its descriptor and creates an instance;
3. `audioNode.getState()` / `setState()` round-trip;
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
any plugin other than the frozen candidate. It also does not add runtime queue,
loader deadline, retry/circuit-breaker, persistence, or user-install policy.
Those requirements remain mandatory before catalog expansion. If the package,
manifest hash, Electron, WAM SDK, Vite asset handling, or builder layout
changes, set this gate back to `disabled` until the smoke is rerun.
