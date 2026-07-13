<div align="center">

# 🪐 Orbitronica

**Make music by drawing orbits.**
Planets circle their paths, cross a trigger bar, and a sound fires. No timeline — you sequence with *space and motion*.

<!-- TODO: replace with a real animated GIF of orbits playing. This is the single most important asset in the README. -->
<!-- ![Orbitronica in motion](docs/hero.gif) -->
`▲ add a hero GIF here — a screen recording of planets orbiting and triggering samples ▲`

[Concepts](#core-concepts) · [Quick Start](#quick-start) · [How to Play](#how-to-play) · [Effects](#wam-effects-rack) · [Tech](#tech-stack)

</div>

---

## What is Orbitronica?

Orbitronica is a desktop instrument for **spatial, generative music**. Instead of arranging notes on a horizontal timeline, you draw **elliptical orbits** on a canvas and drop **planets** onto them. Each orbit carries an audio sample; each planet travels at its own speed and direction. When a planet sweeps across a **trigger bar**, the sample plays. Speed becomes pitch, geometry becomes rhythm, and layered orbits become a living, self-playing arrangement.

It sits at the intersection of a **geometric generative toy** (in the spirit of *Otomata* or circular sequencers) and a **compact DAW** — with scenes, per-orbit effects, and WAV rendering — packaged as an offline Electron app.

## Highlights

- 🌀 **Orbit / planet sequencing** — freeform elliptical orbits, multiple planets per orbit, independent speed and direction.
- 🎯 **Trigger bars** — place *play* and *stop* bars anywhere on an orbit; a passing planet fires the sample.
- 🎞️ **Tape-style pitch** — planet speed maps to playback rate and pitch (powered by SoundTouchJS), or set pitch in cents directly.
- ✂️ **Sample trimming & splicing** — set a playback window into any sample, or splice an orbit into equal alternating bar/gap segments.
- 🎬 **Scenes** — Excel-sheet-style scenes let you build variations; inactive scenes freeze so only the active one plays.
- 🎛️ **Per-orbit WAM effects rack** — chain trusted [Web Audio Modules 2.0](https://www.webaudiomodules.com/) plugins per orbit (see [WAM Effects](#wam-effects-rack)).
- 🔴 **WAV recording** — render your live mix straight to a WAV file (PCM16 / PCM24).
- 💥 **Collisions & motion** — planets react on collision, adding evolving, non-repeating variation.
- 🖥️ **Offline desktop app** — runs fully local via Electron; your samples and projects never leave your machine.

## Core Concepts

| Term | What it is |
| --- | --- |
| **Orbit** | An elliptical path on the canvas. Holds one audio sample and its playback settings (volume, pan, trim, effects). |
| **Planet** | A body that travels around an orbit at a given speed and direction. Its speed sets playback rate/pitch. |
| **Trigger Bar** | A marker on an orbit. A `play` bar starts the sample when a planet crosses it; a `stop` bar halts it. |
| **Scene** | An independent arrangement of orbits, planets, and bars. Switch scenes like sheets in a spreadsheet. |

<!-- TODO: a single labeled diagram (orbit + planet + trigger bar) would make this section click instantly. -->

## Quick Start

**Requirements:** Node.js 18+ and npm.

```bash
# 1. Install dependencies (also downloads the UI font — see Fonts & Licensing)
npm install

# 2. Run in development (Vite + Electron with hot reload)
npm run dev

# 3. Build a packaged desktop app
npm run build
```

> `npm install` runs a `postinstall` step that downloads the **Mapo Flower Island** font
> from its official source. If you are offline it is skipped safely and the app falls back
> to a system font; run `npm run fetch:font` later to install it.

Other useful scripts:

```bash
npm test                 # run the unit test suite
npm run smoke:packaged-wam   # build + verify the packaged WAM effect end-to-end
```

## How to Play

1. **Draw an orbit** — pick the orbit tool and drag an ellipse onto the canvas.
2. **Load a sample** — drop a `.wav`, `.mp3`, or `.ogg` file onto the orbit.
3. **Add a planet** — place a planet on the orbit and set its speed and direction.
4. **Place a trigger bar** — drop a bar on the orbit; the sample fires each time a planet passes it.
5. **Layer & perform** — add more orbits, split into scenes, tweak pitch and effects, then hit record to render a WAV.

## WAM Effects Rack

Each orbit can host a chain of [Web Audio Modules 2.0](https://www.webaudiomodules.com/) effect plugins. To keep the app safe by default, Orbitronica ships a **trusted, allow-listed rack** rather than an open plugin loader: bundled plugins are pinned by content hash and loaded only from immutable, verified files — no user-, project-, or IPC-supplied plugin URLs are ever executed.

The current bundled effect is **Burns Simple Delay** (from [burns-audio-wam](https://github.com/boourns/burns-audio-wam), MIT). Its integrity is enforced by `npm run verify:wam-assets` and proven end-to-end in a real `AudioContext` by `npm run smoke:packaged-wam`. See [`docs/packaged-wam-compatibility.md`](docs/packaged-wam-compatibility.md) for the full compatibility gate.

## Tech Stack

- **UI:** React 18 + TypeScript
- **Build/Dev:** Vite 6
- **Desktop shell:** Electron 33
- **Audio:** Web Audio API, [Web Audio Modules 2.0 SDK](https://www.webaudiomodules.com/), [SoundTouchJS](https://github.com/cutterbl/SoundTouchJS) (time-stretch / pitch)

## Project Structure

```
src/
  main/                 Electron main process (windowing, file IPC)
  renderer/
    audio/              audio engine, WAM host/rack, WAV encoder
    components/         canvas, toolbar, panels, transport
    state/              scenes, types, history
    project/            project (de)serialization
public/wam/             bundled, hash-verified WAM plugin assets
docs/                   design & compatibility notes
```

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR. For changes that touch audio or the WAM rack, also run `npm run smoke:packaged-wam`.

## Fonts & Licensing

### Application code

The Orbitronica source code is released under the **[MIT License](LICENSE)**.

### Mapo Flower Island font (마포꽃섬)

Orbitronica's interface is set in **Mapo Flower Island (마포꽃섬)**, a typeface created and provided free of charge by **Mapo-gu District (마포구)**, Seoul.

- Source: <https://noonnu.cc/font_page/381>
- Free for personal **and commercial** use, including embedding within this application.
- **The font file itself may not be redistributed, modified, or sold.** Copyright remains with Mapo-gu (마포구).

Because the license prohibits redistributing the font file, **it is not committed to this repository.** Instead, `npm install` runs `scripts/fetch-font.mjs`, which downloads it from noonnu's official web-font CDN into `MapoFlowerIsland.woff` (git-ignored). You can re-run it any time with `npm run fetch:font`. If the download is unavailable, the app simply falls back to a system sans-serif.

> 이 프로젝트는 마포구청이 제공한 **마포꽃섬** 서체를 사용합니다. 서체의 저작권은 마포구에 있으며, 폰트 파일의 수정·재배포·판매는 금지되어 있어 저장소에 포함하지 않고 설치 시 공식 출처에서 자동으로 내려받습니다.
