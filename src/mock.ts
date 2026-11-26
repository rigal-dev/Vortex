import type { Basin, Cyclone, Hemisphere } from './types';

/** Deterministic PRNG so the fallback looks identical on every load. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BasinProfile {
  basin: Basin;
  hemi: Hemisphere;
  count: number;
  lat: [number, number];
  lon: [number, number];
  /** initial compass heading (deg) */
  heading: number;
  /** +1 turns clockwise (NH recurvature), -1 counter-clockwise (SH) */
  turn: number;
  /** turning-rate multiplier */
  curl: number;
}

const PROFILES: BasinProfile[] = [
  { basin: 'WP', hemi: 'N', count: 120, lat: [8, 17], lon: [125, 168], heading: 292, turn: 1, curl: 1.0 },
  { basin: 'NA', hemi: 'N', count: 70, lat: [10, 20], lon: [-45, -18], heading: 285, turn: 1, curl: 1.15 },
  { basin: 'EP', hemi: 'N', count: 55, lat: [9, 16], lon: [-112, -92], heading: 282, turn: 1, curl: 0.45 },
  { basin: 'SI', hemi: 'S', count: 55, lat: [-18, -8], lon: [55, 100], heading: 250, turn: -1, curl: 1.0 },
  { basin: 'SP', hemi: 'S', count: 40, lat: [-18, -8], lon: [155, 185], heading: 232, turn: -1, curl: 1.05 },
  { basin: 'NI', hemi: 'N', count: 14, lat: [10, 16], lon: [65, 90], heading: 332, turn: 1, curl: 0.5 },
];

const NAMES = [
  'Andrew', 'Bola', 'Cleo', 'Dorian', 'Elena', 'Freddy', 'Gita', 'Haiyan', 'Irma', 'Joan', 'Kenna',
  'Linda', 'Maria', 'Nargis', 'Olga', 'Patricia', 'Quincy', 'Rai', 'Sandy', 'Tracy', 'Uma', 'Vance',
  'Wilma', 'Xavier', 'Yasi', 'Zeb', 'Amphan', 'Bopha', 'Chanchu', 'Dean', 'Eline', 'Fani',
];

const KM_PER_DEG = 111.19;
const D2R = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Generates plausible synthetic cyclone tracks following the real JSON contract. */
export function generateMockCyclones(currentYear: number = new Date().getFullYear()): Cyclone[] {
  const rnd = mulberry32(1992237);
  const out: Cyclone[] = [];
  let serial = 0;

  for (const p of PROFILES) {
    for (let s = 0; s < p.count; s++) {
      const n = 22 + Math.floor(rnd() * 44);
      let lat = p.lat[0] + rnd() * (p.lat[1] - p.lat[0]);
      let lon = p.lon[0] + rnd() * (p.lon[1] - p.lon[0]);
      let heading = p.heading + (rnd() - 0.5) * 36;
      const baseRate = (0.8 + rnd() * 2.6) * p.curl;
      const wobble = rnd() < 0.12 ? 7 : 1.6; // occasional looping tracks
      const startLat = lat;

      const latArr = [lat];
      const lonArr = [lon];
      const dx = [0];
      const dy = [0];
      let total = 0;

      for (let i = 1; i < n; i++) {
        const speed = 120 + Math.abs(lat) * 3.2 + rnd() * 40; // km per 6h
        const latFactor = clamp(Math.abs(lat) / 24, 0.25, 2.2);
        heading += p.turn * baseRate * latFactor + (rnd() - 0.5) * wobble * 2;
        const dN = (Math.cos(heading * D2R) * speed) / KM_PER_DEG;
        const dE = (Math.sin(heading * D2R) * speed) / (KM_PER_DEG * Math.max(0.2, Math.cos(lat * D2R)));
        lat += dN;
        lon += dE;
        latArr.push(+lat.toFixed(2));
        lonArr.push(+lon.toFixed(2));
        dx.push(dx[i - 1] + Math.sin(heading * D2R) * speed);
        dy.push(dy[i - 1] + Math.cos(heading * D2R) * speed);
        total += speed;
        if (Math.abs(lat) > 58 || Math.abs(lat - startLat) > 50) break;
      }
      const m = dx.length;
      if (m < 8) continue;

      const straight = Math.hypot(dx[m - 1], dy[m - 1]) || 1;
      const k = Math.min(4, m - 1);
      const theta = Math.atan2(dx[k], dy[k]);
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const rx = dx.map((x, i) => x * cos - dy[i] * sin);
      const ry = dx.map((x, i) => x * sin + dy[i] * cos);

      const peak = Math.round(100 + Math.pow(rnd(), 1.6) * 60);
      const ip = m * (0.4 + rnd() * 0.25);
      const sigma = m * (0.22 + rnd() * 0.12);
      const wind = dx.map((_, i) => Math.round(28 + (peak - 28) * Math.exp(-(((i - ip) / sigma) ** 2))));

      const season = 1980 + Math.floor(rnd() * (currentYear - 1980 + 1));
      out.push({
        id: `${season}${String(serial).padStart(3, '0')}${p.basin}`,
        name: NAMES[serial % NAMES.length],
        season,
        basin: p.basin,
        hemi: p.hemi,
        peak_wind: Math.max(...wind),
        min_pres: Math.round(1010 - (Math.max(...wind) - 25) * 0.7),
        sinuosity: +(total / straight).toFixed(2),
        total_km: +total.toFixed(1),
        dx: dx.map((v) => +v.toFixed(1)),
        dy: dy.map((v) => +v.toFixed(1)),
        rx: rx.map((v) => +v.toFixed(1)),
        ry: ry.map((v) => +v.toFixed(1)),
        lat: latArr,
        lon: lonArr,
        wind,
        t0: +(season + rnd()).toFixed(3),
      });
      serial++;
    }
  }
  return out;
}
