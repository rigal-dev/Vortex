#!/usr/bin/env node
/**
 * Builds public/cyclones.json from NOAA IBTrACS (v04r01, since 1980).
 *
 *   npm run data
 *
 * - Downloads the ~145 MB CSV once into scripts/.cache (re-used afterwards).
 * - Keeps storms with 1-min sustained wind >= 96 kt (Saffir-Simpson Cat 3+) at any point.
 * - Uses 6-hourly main-track fixes only.
 * - Computes dx/dy (km from genesis), rx/ry (rotated so the first-24h heading is due north),
 *   sinuosity and total_km.
 *
 * Requires Node 20+ (global fetch). No dependencies.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scripts', '.cache');
const CSV_PATH = join(CACHE, 'ibtracs.since1980.list.v04r01.csv');
const OUT_PATH = join(ROOT, 'public', 'cyclones.json');
const URL =
  'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv';

const MIN_PEAK_KT = 96;
const MIN_SEASON = 1980;
const KM_PER_DEG = 111.19;
const D2R = Math.PI / 180;
const BASINS = new Set(['NA', 'WP', 'EP', 'SI', 'SP', 'NI']); // South Atlantic (SA) is excluded

async function download() {
  if (existsSync(CSV_PATH)) {
    console.log(`Using cached ${CSV_PATH}`);
    return;
  }
  mkdirSync(CACHE, { recursive: true });
  console.log('Downloading IBTrACS (~145 MB)…');
  const res = await fetch(URL);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(CSV_PATH));
  console.log('Download complete.');
}

const num = (s) => {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s-])(\w)/g, (_, a, b) => a + b.toUpperCase());

async function readStorms() {
  const rl = createInterface({ input: createReadStream(CSV_PATH), crlfDelay: Infinity });
  let col = null;
  let lineNo = 0;
  /** @type {Map<string, any>} */
  const storms = new Map();

  for await (const line of rl) {
    lineNo++;
    if (lineNo === 1) {
      col = Object.fromEntries(line.split(',').map((h, i) => [h.trim(), i]));
      for (const k of ['SID', 'SEASON', 'BASIN', 'NAME', 'ISO_TIME', 'LAT', 'LON', 'TRACK_TYPE']) {
        if (!(k in col)) throw new Error(`Missing expected column ${k}`);
      }
      continue;
    }
    if (lineNo === 2 || line.trim() === '') continue; // units row

    const f = line.split(',');
    if (f[col.TRACK_TYPE]?.trim() !== 'main') continue;
    const time = f[col.ISO_TIME];
    const hour = Number(time.slice(11, 13));
    const minute = Number(time.slice(14, 16));
    if (hour % 6 !== 0 || minute !== 0) continue;

    const lat = num(f[col.LAT]);
    const lon = num(f[col.LON]);
    if (lat === null || lon === null) continue;

    const wind = num(f[col.USA_WIND]) ?? num(f[col.WMO_WIND]);
    const pres = num(f[col.USA_PRES]) ?? num(f[col.WMO_PRES]);

    const sid = f[col.SID].trim();
    let s = storms.get(sid);
    if (!s) {
      s = {
        id: sid,
        name: f[col.NAME].trim(),
        season: Number(f[col.SEASON]),
        basin: f[col.BASIN].trim(),
        rows: [],
      };
      storms.set(sid, s);
    }
    s.rows.push({ time, lat, lon, wind, pres });
  }
  return [...storms.values()];
}

/** Linear-interpolates missing wind values; extends nearest known value to the ends. */
function fillWinds(rows) {
  const w = rows.map((r) => r.wind);
  const known = w.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length === 0) return null;
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== null) continue;
    let a = -1;
    let b = -1;
    for (const k of known) {
      if (k < i) a = k;
      if (k > i) {
        b = k;
        break;
      }
    }
    if (a < 0) w[i] = w[b];
    else if (b < 0) w[i] = w[a];
    else w[i] = w[a] + ((w[b] - w[a]) * (i - a)) / (b - a);
  }
  return w;
}

const r1 = (v) => Math.round(v * 10) / 10;

function build(storm) {
  if (!BASINS.has(storm.basin) || storm.season < MIN_SEASON) return null;
  const rows = storm.rows.sort((a, b) => (a.time < b.time ? -1 : 1));
  if (rows.length < 8) return null;

  const wind = fillWinds(rows);
  if (!wind) return null;
  const peak = Math.max(...wind);
  if (peak < MIN_PEAK_KT) return null;

  const dx = [0];
  const dy = [0];
  let total = 0;
  for (let i = 1; i < rows.length; i++) {
    let dLon = rows[i].lon - rows[i - 1].lon;
    if (dLon > 180) dLon -= 360;
    else if (dLon < -180) dLon += 360;
    const midLat = (rows[i].lat + rows[i - 1].lat) / 2;
    const east = dLon * KM_PER_DEG * Math.cos(midLat * D2R);
    const north = (rows[i].lat - rows[i - 1].lat) * KM_PER_DEG;
    dx.push(dx[i - 1] + east);
    dy.push(dy[i - 1] + north);
    total += Math.hypot(east, north);
  }
  const n = rows.length;
  const straight = Math.hypot(dx[n - 1], dy[n - 1]);
  if (straight < 50 || total < 300) return null; // stationary / degenerate tracks

  // Heading over the first 24h (4 steps), falling back to the first non-zero displacement.
  let k = Math.min(4, n - 1);
  while (k < n - 1 && Math.hypot(dx[k], dy[k]) < 1) k++;
  const theta = Math.atan2(dx[k], dy[k]);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const rx = dx.map((x, i) => x * cos - dy[i] * sin);
  const ry = dx.map((x, i) => x * sin + dy[i] * cos);

  const pressures = rows.map((r) => r.pres).filter((p) => p !== null && p > 800);
  const minPres = pressures.length ? Math.min(...pressures) : Math.round(1010 - (peak - 25) * 0.7);

  const named = storm.name && storm.name !== 'NOT_NAMED' && storm.name !== 'UNNAMED';
  // Genesis time as a decimal year (UTC), used by the timeline view.
  const d0 = new Date(rows[0].time.replace(' ', 'T') + 'Z');
  const yStart = Date.UTC(d0.getUTCFullYear(), 0, 1);
  const yEnd = Date.UTC(d0.getUTCFullYear() + 1, 0, 1);
  const t0 = d0.getUTCFullYear() + (d0.getTime() - yStart) / (yEnd - yStart);
  return {
    id: storm.id,
    name: named ? titleCase(storm.name) : 'Unnamed',
    season: storm.season,
    basin: storm.basin,
    hemi: rows[0].lat >= 0 ? 'N' : 'S',
    peak_wind: Math.round(peak),
    min_pres: Math.round(minPres),
    sinuosity: Math.round((total / straight) * 100) / 100,
    total_km: r1(total),
    dx: dx.map(r1),
    dy: dy.map(r1),
    rx: rx.map(r1),
    ry: ry.map(r1),
    lat: rows.map((r) => r1(r.lat)),
    lon: rows.map((r) => r1(r.lon)),
    wind: wind.map(Math.round),
    t0: Math.round(t0 * 1000) / 1000,
  };
}

await download();
console.log('Parsing…');
const storms = await readStorms();
const out = storms
  .map(build)
  .filter(Boolean)
  .sort((a, b) => a.season - b.season || (a.id < b.id ? -1 : 1));

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(out));
const byBasin = out.reduce((m, c) => ((m[c.basin] = (m[c.basin] ?? 0) + 1), m), {});
console.log(`Wrote ${out.length} cyclones to ${OUT_PATH}`, byBasin);
