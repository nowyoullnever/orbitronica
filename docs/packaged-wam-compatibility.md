# Packaged WAM compatibility gate (G008)

**Status: enabled-file.** The trusted production catalog has nine hash-locked effects: immutable Burns Simple Delay and Burns Simple EQ; first-party Orbitronica Overdrive, Compressor, Bitcrusher, Flanger, Phaser, Reverb, and Filter.

## Catalog and provenance

Only entries committed beneath `public/wam/` can load. No project, preference, IPC, or user-supplied URL can add a WAM. Burns tarball SHA-256: `03dbe1a9891482e43b16392832eeea675e8468d019d4a212cf5d6dda2300595d`. Burns payload assets remain byte-locked to `burns-audio-wam@0.2.54`; each Burns directory also carries a distribution `NOTICE.txt` sidecar, hash-listed in its manifest, so package attribution is retained without changing upstream executable payloads. Orbitronica Overdrive is the sole bundled distortion path; Burns Distortion is not bundled.

First-party bundles are built with exact `esbuild@0.25.12`. `npm run verify:plugins-deterministic` performs two clean, isolated temporary builds and recursively compares every generated relative path, file type, and SHA-256; it never uses mutable `public/wam` output as evidence. `npm run verify:wam-assets` verifies the nine manifests and hashes, and repeats against `dist` before packaged smoke.

## Executable production evidence

`npm run smoke:packaged-wam` builds the unpacked Electron application and loads all nine catalog entries from `file://…/dist/wam/`. For every entry it proves import, descriptor/instance creation, state round trip, GUI lifecycle when provided, removal/destruction, and 25 repeated rack lifecycle cycles. Every first-party effect additionally proves non-default parameter state restoration and strict atomic rejection of direct arrays/scalars, `params` arrays/scalars, and nested dangerous keys.

`npm run test:wam-dsp` runs Chromium `OfflineAudioContext` metrics at 44.1 and 48 kHz. It covers the compressor, bitcrusher, flanger, phaser, and reverb controls, bounded/stereo behavior, equal-power mixing, state restoration, and sample-rate behavior. The smoke marker must report `origin: "file:"`, every event successful, `rackRemovalCompleted: true`, and `cleanupDidNotBlockHost: true`.

## Boundaries that remain closed

The host retains its bounded loader queue and circuit-breaker protections. The gate does not authorize remote imports, arbitrary modules, app://, CSP/COEP, WASM, or optional SharedArrayBuffer use. PDC, including `audioNode.getCompensationDelay()`, remains excluded: different orbit chains may cause inter-orbit drift until a dedicated PDC design is approved.
