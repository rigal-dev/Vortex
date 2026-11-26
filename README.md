# Vortex: Shapes of Cyclones

An interactive visualization of the **morphology of global major cyclone tracks, 1980 to present**. Every tropical cyclone that reached at least 96 kt (Category 3+) is drawn as a glowing line, coloured by wind speed, and can be re-arranged into different "shapes" to reveal how storms curve, recurve and wander.

**Live demo:** https://rigal-dev.github.io/Vortex/

## Inspiration

This project takes large inspiration from **[Shapes of Rivers](https://dominicroye.github.io/shapes-of-rivers/)** by [Dominic Royé](https://dominicroye.github.io/), which turns river courses into abstract, comparable shapes. Vortex applies the same idea (strip away geography, compare form) to cyclone tracks. Full credit for the concept goes to that work; the code, data pipeline and interaction design here are independent.

## Features

- **~1,090 storms** from NOAA IBTrACS since 1980, six ocean basins, peak wind ≥ 96 kt.
- **Five shapes** (View):
  - **Radial**: every track starts at the centre, north-aligned, fanned out chronologically (earliest at the top, clockwise) with a year ring.
  - **Drop**: tracks rotated so genesis → dissipation points straight up.
  - **Flow**: tracks run left to right from a common start.
  - **Timeline**: time on the x-axis, tracks rising from the baseline.
  - **Map**: true geography on an equirectangular map with Natural Earth land.
- **Three length modes**: Equal (default), Real (true km, with 500/1000/2000 km rings) and Fixed ends.
- **Unified or split hemisphere** layout (north left, south right).
- **Filters**: basin, Saffir–Simpson category (3 / 4 / 5), year range and a sinuosity threshold.
- **Wind-coloured tracks** on a smooth ramp: blue → cyan → amber → red, with widths and opacity that swell at peak intensity.
- **Hover** a track to isolate it in white with its details; **zoom and pan** with wheel, pinch, drag, double-click to reset.
- **Mobile layout**: canvas above the controls, with a switcher for canvas only / both / controls only. Desktop uses a docked side panel.
- Adjustable **line intensity** and density-aware opacity so overlapping tracks build depth instead of washing out to white.

## Tech stack

React 19 · TypeScript · Vite 7 · Tailwind CSS v4 · HTML5 Canvas (a single `requestAnimationFrame` loop, `screen` compositing, DPR-aware). No backend: the data is a static JSON file.

## Getting started

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check and production build into dist/
npm run preview  # preview the production build
```

Requires Node 18+.

### Rebuilding the data

`public/cyclones.json` is committed, but you can regenerate it:

```bash
npm run data     # downloads IBTrACS (~145 MB, cached in scripts/.cache), writes public/cyclones.json
npm run land     # regenerates src/land.ts from Natural Earth 110m land polygons
```

`scripts/build-data.mjs` keeps storms with peak wind ≥ `MIN_PEAK_KT` (96 kt) and computes per-storm track offsets, sinuosity and total length. Lower `MIN_PEAK_KT` to include tropical storms and Category 1–2, then re-run `npm run data`.

## Project structure

```
src/engine.ts    Canvas engine: geometry, tweens, camera, rendering, hover
src/App.tsx      UI: controls, responsive layout, data loading
src/types.ts     Types, categories, basin groups, validators
src/mock.ts      Synthetic fallback storms shown while data loads
src/land.ts      Generated Natural Earth land outlines (do not edit by hand)
scripts/         Data and land generators
public/          cyclones.json
```

## Deployment

The site is static. Build with `npm run build` and serve `dist/` from any static host. For GitHub Pages, `vite.config.ts` uses a relative base (`./`) and the data is fetched relative to `import.meta.env.BASE_URL`, so it works under a sub-path.

## Data and credits

- **Cyclone tracks:** [NOAA IBTrACS](https://www.ncei.noaa.gov/products/international-best-track-archive) (International Best Track Archive for Climate Stewardship), v04r01. Knapp, K. R., Kruk, M. C., Levinson, D. H., Diamond, H. J., & Neumann, C. J. (2010). *The International Best Track Archive for Climate Stewardship (IBTrACS)*. Bulletin of the American Meteorological Society, 91, 363–376.
- **Land outlines:** [Natural Earth](https://www.naturalearthdata.com/) 110m, public domain.
- **Concept inspiration:** [Shapes of Rivers](https://dominicroye.github.io/shapes-of-rivers/) by Dominic Royé.

Best-track data are post-analysis estimates and wind speeds come from different agencies' conventions; treat this as a visual exploration, not an authoritative climatology.
</Content>
