# Live recording automation handoff

## Checkpoint

- Branch: `feature/live-pcm-wav-mp3`
- Baseline commit: `9c16747` (master-output PCM capture and WAV export experiment)
- Follow-up checkpoint will add the restricted local sample loader used for automation.

## Completed

1. A packaged build exists at `release/automation-sample-loader/win-unpacked/Orbitonic MVP.exe`.
2. Its welcome screen includes a `Load local sample` text field and button.
3. The Electron preload/main bridge restricts this helper to audio files below `D:\샘플 사운드\녹음`; it does not expose arbitrary renderer filesystem access.
4. Candidate short source material was identified in that folder, including `idm 1.1.4.wav` and `Roland TR-707 Handclap.mp3`.
5. Computer Use successfully launched the sample-loader build and verified that the new loader control is visible in the accessibility tree.

## Remaining work

1. Use the loader field to import at least ten short samples. The current Computer Use session intermittently rejects input actions after a snapshot; begin with a fresh Computer Use session, obtain a fresh window state, then click/type one action at a time.
2. Place planets and bars for each imported orbit, start the transport, and make a short live arrangement.
3. Verify/fix the PCM WAV recorder before depending on it: the current implementation buffers worklet chunks in renderer memory and does not yet implement the required main-process temporary PCM streaming, save-settings modal, exact stop marker, PDC choice, or finite-tail logic.
4. Record the arrangement and save the WAV to the Desktop using the native save dialog.
5. Run TypeScript, tests, Vite build, Electron packaging, then commit and push the completed implementation.

## Exact resume point

Launch `release/automation-sample-loader/win-unpacked/Orbitonic MVP.exe` with Computer Use. In the welcome screen, focus the visible `Load local sample` edit field, enter a permitted path such as `D:\샘플 사운드\녹음\idm 1.1.4.wav`, and press `Load local sample`. Repeat with at least ten selected WAV/MP3/OGG files from the same folder.
