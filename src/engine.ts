import { LAND } from './land';
import {
  BASIN_GROUPS,
  categoryOf,
  type Cyclone,
  type ScaleMode,
  type ViewMode,
  type ViewState,
} from './types';

const BG = '#08090C';
const TRANSITION_MS = 800;
const MAP_CENTER_LON = 20;
const RING_KM = [500, 1000, 2000] as const;
const MODES: readonly ViewMode[] = ['radial', 'drop', 'map', 'timeline', 'flow'];
const SCALES: readonly ScaleMode[] = ['real', 'equal', 'fixed'];
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 40;

/** Space (px) reserved around the visualization, e.g. for the docked control panel. */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Camera {
  z: number;
  tx: number;
  ty: number;
}

export const WIND_COLORS = {
  ts: '#1E3A8A',
  cat12: '#06B6D4',
  cat34: '#F59E0B',
  cat5: '#F43F5E',
} as const;

// Smooth wind→colour ramp (1 kt lookup table) so tracks blend through the palette instead of
// snapping between four flat bands; the low end is a brighter blue so it stays visible.
const WIND_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [30, 0x2f, 0x52, 0xd0],
  [64, 0x06, 0xb6, 0xd4],
  [96, 0xf5, 0x9e, 0x0b],
  [125, 0xf7, 0x2d, 0x50],
  [175, 0xff, 0x2e, 0x55],
];
const WIND_LUT: string[] = (() => {
  const out: string[] = [];
  for (let kt = 0; kt <= 200; kt++) {
    let a = WIND_STOPS[0];
    let b = WIND_STOPS[WIND_STOPS.length - 1];
    for (let i = 0; i < WIND_STOPS.length - 1; i++) {
      if (kt <= WIND_STOPS[i + 1][0]) {
        a = WIND_STOPS[i];
        b = WIND_STOPS[i + 1];
        break;
      }
    }
    const t = Math.min(1, Math.max(0, (kt - a[0]) / (b[0] - a[0])));
    const c = [1, 2, 3].map((j) => Math.round(a[j] + (b[j] - a[j]) * t));
    out.push(`rgb(${c[0]},${c[1]},${c[2]})`);
  }
  return out;
})();

export function windColor(kt: number): string {
  return WIND_LUT[Math.max(0, Math.min(200, Math.round(kt)))];
}

/** Flow default view is zoomed out 20% (applies to Real, Equal and Fixed lengths). */
const FLOW_ZOOM = 0.8;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * A retargetable tween. Retargeting snapshots the *current* interpolated value as the new
 * origin, so rapid clicks can never cause a jump or a stale transition.
 */
class Tween {
  private from: number[];
  private to: number[];
  private start = -Infinity;
  constructor(initial: number[], private readonly duration: number) {
    this.from = initial.slice();
    this.to = initial.slice();
  }
  value(now: number): number[] {
    const e = easeInOutCubic(clamp01((now - this.start) / this.duration));
    return this.from.map((f, i) => lerp(f, this.to[i], e));
  }
  retarget(to: number[], now: number): void {
    this.from = this.value(now);
    this.to = to.slice();
    this.start = now;
  }
}

interface Prepared {
  c: Cyclone;
  n: number;
  hemi: 0 | 1;
  dx: Float32Array;
  dy: Float32Array;
  rx: Float32Array;
  ry: Float32Array;
  ux: Float32Array; // drop frame (km): genesis at (0,0), dissipation on the +y axis
  uy: Float32Array;
  total: number; // path length (km)
  straight: number; // genesis -> dissipation distance (km)
  t: number; // genesis time, decimal year
  tf: number; // t normalised to the timeline axis (0..1)
  cr: number; // radial view: cos/sin of this storm's chronological heading angle
  sr: number;
  mx: Float32Array; // lon (unwrapped) - center
  my: Float32Array; // lat
  wind: Float32Array;
  peak: number;
  alpha: number; // animated visibility
  target: boolean; // passes filters
  sx: Float32Array;
  sy: Float32Array;
}

interface Geo {
  cx: number;
  oy: number; // origin y (world space, before camera)
  cy: number;
  vw: number;
  k: number; // px per km
  mk: number; // px per degree (map)
  len: number; // px length of the normalised genesis->dissipation axis (drop)
  t0x: number; // timeline axis left end (world px)
  t1x: number; // timeline axis right end (world px)
}

export interface EngineCallbacks {
  onHover: (c: Cyclone | null) => void;
  onVisibleCount: (n: number) => void;
  /** Playback date label (e.g. "Sep 1994"), or null when playback is not active. */
  onPlayClock?: (label: string | null) => void;
  /** Playback ran to the end and returned to the normal view. */
  onPlayEnd?: () => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class VortexEngine {
  private readonly ctx: CanvasRenderingContext2D;
  private storms: Prepared[] = [];
  private view: ViewState | null = null;
  private weightTween = new Tween([1, 0, 0, 0, 0], TRANSITION_MS);
  private tMin = 1980;
  private intensity = 1;
  private tMax = 2026;
  private splitTween = new Tween([0], TRANSITION_MS);
  private W = 0;
  private H = 0;
  private dpr = 1;
  private raf = 0;
  private last = 0;
  private running = false;
  private pointer: { x: number; y: number } | null = null;
  private hovered: Prepared | null = null;
  private hoverDim = 0;
  private lastCount = -1;
  private geos: [Geo, Geo] = [this.blankGeo(), this.blankGeo()];
  private cam: Camera = { z: 1, tx: 0, ty: 0 };
  private camTarget: Camera = { z: 1, tx: 0, ty: 0 };
  private pointers = new Map<number, { x: number; y: number }>();
  private dragging = false;
  private dragTravel = 0;
  private scaleTween = new Tween([1, 0, 0], TRANSITION_MS);
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  private rect = { x0: 0, y0: 0, w: 1, h: 1 };
  private reach90 = 2000;
  /** Horizontal offset (px) of the whole visualization; eased toward shiftTarget. */
  private shift = 0;
  /** Intro 0→1: every track grows outward from its genesis point at the same time. */
  private intro = 1;
  /** Chronological playback: a clock in decimal years; storms draw in as it passes their genesis. */
  private play = { active: false, running: false, clock: 0, t1: 0, rate: 1.5, dur: 2.2, month: -1 };
  private shiftTarget = 0;
  /** Per-frame pixel sizing shared by both hemisphere viewports. */
  private dim = {
    k: 1,
    kF: 1,
    mk: 1,
    peqR: 1,
    pfxR: 1,
    peqD: 1,
    pfxD: 1,
    peqT: 1,
    pfxT: 1,
    peqF: 1,
    pfxF: 1,
  };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly cb: EngineCallbacks) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unsupported');
    this.ctx = ctx;
    this.resize();
    canvas.style.touchAction = 'none';
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('dblclick', this.resetCamera);
    this.updateCursor();
  }

  private blankGeo(): Geo {
    return { cx: 0, oy: 0, cy: 0, vw: 1, k: 1, mk: 1, len: 1, t0x: 0, t1x: 1 };
  }

  // ---------- camera (zoom & pan) ----------

  /** Zooms the target camera about a screen point, keeping that point fixed. */
  private zoomAt(px: number, py: number, factor: number, immediate = false): void {
    const t = this.camTarget;
    const z1 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, t.z * factor));
    const r = z1 / t.z;
    t.tx = px - (px - t.tx) * r;
    t.ty = py - (py - t.ty) * r;
    t.z = z1;
    if (immediate) Object.assign(this.cam, t);
  }

  zoomBy(factor: number): void {
    this.zoomAt(this.rect.x0 + this.rect.w / 2, this.rect.y0 + this.rect.h / 2, factor);
  }

  resetCamera = (): void => {
    this.camTarget = { z: 1, tx: 0, ty: 0 };
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const speed = e.ctrlKey ? 0.01 : 0.0015; // ctrlKey = trackpad pinch
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * unit * speed));
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragTravel = 0;
  };

  private onPointerMove = (e: PointerEvent): void => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (this.pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      this.dragTravel += Math.abs(dx) + Math.abs(dy);
      if (this.dragTravel > 4) {
        this.camTarget.tx += dx;
        this.camTarget.ty += dy;
        this.cam.tx += dx;
        this.cam.ty += dy;
        if (!this.dragging) {
          this.dragging = true;
          this.updateCursor();
        }
      }
    } else if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
      const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const m1 = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
      this.camTarget.tx += m1.x - m0.x;
      this.camTarget.ty += m1.y - m0.y;
      this.cam.tx += m1.x - m0.x;
      this.cam.ty += m1.y - m0.y;
      if (d0 > 0) {
        const r = this.canvas.getBoundingClientRect();
        this.zoomAt(m1.x - r.left, m1.y - r.top, d1 / d0, true);
      }
      this.dragging = true;
    }
    this.pointers.set(e.pointerId, cur);
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0 && this.dragging) {
      this.dragging = false;
      this.updateCursor();
    }
  };

  private updateCursor(): void {
    this.canvas.style.cursor = this.dragging ? 'grabbing' : this.hovered ? 'crosshair' : 'grab';
  }

  // ---------- public API ----------

  setData(cyclones: Cyclone[]): void {
    this.storms = cyclones.map((c) => this.prepare(c));
    this.intro = this.storms.length > 0 ? 0 : 1;
    // 90th-percentile farthest reach (km) of a track from its genesis: real-length scale is
    // fitted to this so most storms stay on screen instead of spilling over the edges.
    const reach = this.storms
      .map((p) => {
        let r = 0;
        for (let i = 0; i < p.n; i++) r = Math.max(r, Math.hypot(p.dx[i], p.dy[i]));
        return r;
      })
      .sort((a, b) => a - b);
    this.reach90 = Math.max(500, reach[Math.floor(reach.length * 0.9)] ?? 2000);
    // Timeline axis spans whole years covering the full dataset (independent of filters).
    if (this.storms.length > 0) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of this.storms) {
        if (p.t < lo) lo = p.t;
        if (p.t > hi) hi = p.t;
      }
      this.tMin = Math.floor(lo);
      this.tMax = Math.max(this.tMin + 1, Math.ceil(hi));
    }
    for (const p of this.storms) {
      p.tf = (p.t - this.tMin) / (this.tMax - this.tMin);
      // Radial: earliest storm points up; later storms sweep clockwise around the circle.
      const phi = p.tf * Math.PI * 2;
      p.cr = Math.cos(phi);
      p.sr = Math.sin(phi);
    }
    this.setHover(null);
    this.applyFilters();
  }

  setView(next: ViewState): void {
    const now = performance.now();
    const prev = this.view;
    this.view = next;
    if (!prev || prev.mode !== next.mode) {
      this.weightTween.retarget(MODES.map((m) => (m === next.mode ? 1 : 0)), now);
    }
    if (!prev || prev.layout !== next.layout) {
      this.splitTween.retarget([next.layout === 'split' ? 1 : 0], now);
    }
    if (!prev || prev.scale !== next.scale) {
      this.scaleTween.retarget(
        SCALES.map((sc) => (sc === next.scale ? 1 : 0)),
        now,
      );
    }
    // Geometry changes drastically between modes/layouts, so glide the camera home.
    if (prev && (prev.mode !== next.mode || prev.layout !== next.layout)) this.resetCamera();
    this.applyFilters();
  }

  /** Multiplier on track opacity (1 = automatic density-based default). */
  setIntensity(v: number): void {
    this.intensity = Math.min(2, Math.max(0.2, v));
  }

  setInsets(insets: Insets): void {
    this.insets = insets;
  }

  /** Start chronological playback of the filtered year range from the beginning. */
  playStart(rate: number, dur: number): void {
    const f = this.view?.filters;
    const pl = this.play;
    pl.active = true;
    pl.running = true;
    pl.rate = rate;
    pl.dur = dur;
    pl.clock = f ? f.yearMin : 1980;
    pl.t1 = f ? f.yearMax + 1 : 2026;
    pl.month = -1;
    this.setHover(null);
  }

  /** Pause / resume playback (no-op when not active). */
  playToggle(): boolean {
    if (!this.play.active) return false;
    this.play.running = !this.play.running;
    return this.play.running;
  }

  /** Change speed: years per second, and seconds each storm takes to draw. */
  playSetSpeed(rate: number, dur: number): void {
    this.play.rate = rate;
    this.play.dur = dur;
  }

  /** Leave playback and return to the normal static view. */
  playStop(): void {
    this.play.active = false;
    this.play.running = false;
    this.cb.onPlayClock?.(null);
  }

  /** Slide the visualization sideways without resizing it (e.g. when a side panel collapses). */
  setShift(px: number): void {
    this.shiftTarget = px;
  }

  setPointer(x: number | null, y = 0): void {
    this.pointer = x === null ? null : { x, y };
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    // Size to the canvas' container (the stage), not the window.
    const host = this.canvas.parentElement;
    this.W = Math.max(1, host?.clientWidth ?? window.innerWidth);
    this.H = Math.max(1, host?.clientHeight ?? window.innerHeight);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('dblclick', this.resetCamera);
  }

  // ---------- data prep ----------

  private prepare(c: Cyclone): Prepared {
    const n = c.dx.length;
    const mx = new Float32Array(n);
    const my = new Float32Array(n);
    // Normalise the genesis longitude into the map window, then unwrap the rest so
    // tracks crossing the antimeridian stay continuous.
    const start = ((((c.lon[0] - MAP_CENTER_LON + 180) % 360) + 360) % 360) - 180;
    let prev = start;
    mx[0] = start;
    for (let i = 1; i < n; i++) {
      let d = c.lon[i] - c.lon[i - 1];
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      prev += d;
      mx[i] = prev;
    }
    for (let i = 0; i < n; i++) my[i] = c.lat[i];

    // Drop frame (km): rotate so the genesis->dissipation axis points due north.
    const ex = c.dx[n - 1];
    const ey = c.dy[n - 1];
    const straight = Math.max(1, Math.hypot(ex, ey));
    const theta = Math.atan2(ex, ey);
    const cs = Math.cos(theta);
    const sn = Math.sin(theta);
    const ux = new Float32Array(n);
    const uy = new Float32Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      ux[i] = c.dx[i] * cs - c.dy[i] * sn;
      uy[i] = c.dx[i] * sn + c.dy[i] * cs;
      if (i > 0) total += Math.hypot(c.dx[i] - c.dx[i - 1], c.dy[i] - c.dy[i - 1]);
    }
    total = Math.max(1, total);
    // Genesis time: real value when provided, else the season plus a stable per-storm offset.
    let h = 0;
    for (let i = 0; i < c.id.length; i++) h = (h * 31 + c.id.charCodeAt(i)) >>> 0;
    const t = c.t0 ?? c.season + 0.05 + (h % 1000) / 1111;
    return {
      c,
      n,
      hemi: c.hemi === 'N' ? 0 : 1,
      dx: Float32Array.from(c.dx),
      dy: Float32Array.from(c.dy),
      rx: Float32Array.from(c.rx),
      ry: Float32Array.from(c.ry),
      ux,
      uy,
      total,
      straight,
      t,
      tf: 0,
      cr: 1,
      sr: 0,
      mx,
      my,
      wind: Float32Array.from(c.wind),
      peak: Math.max(c.peak_wind, 40),
      alpha: 0,
      target: false,
      sx: new Float32Array(n),
      sy: new Float32Array(n),
    };
  }

  private applyFilters(): void {
    if (!this.view) return;
    const f = this.view.filters;
    const basins = BASIN_GROUPS[f.basin];
    let count = 0;
    for (const p of this.storms) {
      const c = p.c;
      p.target =
        basins.includes(c.basin) &&
        c.season >= f.yearMin &&
        c.season <= f.yearMax &&
        f.categories.includes(categoryOf(c.peak_wind));
      if (p.target) count++;
    }
    if (this.hovered && !this.hovered.target) this.setHover(null);
    if (count !== this.lastCount) {
      this.lastCount = count;
      this.cb.onVisibleCount(count);
    }
  }

  private setHover(p: Prepared | null): void {
    if (this.hovered === p) return;
    this.hovered = p;
    this.cb.onHover(p ? p.c : null);
    this.updateCursor();
  }

  // ---------- loop ----------

  private frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    try {
      this.update(dt);
      this.draw(now);
    } catch (err) {
      // never let one bad frame kill the loop
      console.error('[vortex] frame error', err);
    }
  };

  private update(dt: number): void {
    const fade = 1 - Math.exp(-dt * 9);
    for (const p of this.storms) {
      const t = p.target ? 1 : 0;
      p.alpha += (t - p.alpha) * fade;
      if (Math.abs(t - p.alpha) < 0.002) p.alpha = t;
    }
    this.hoverDim += ((this.hovered ? 1 : 0) - this.hoverDim) * (1 - Math.exp(-dt * 10));
    this.shift += (this.shiftTarget - this.shift) * (1 - Math.exp(-dt * 10));
    if (Math.abs(this.shiftTarget - this.shift) < 0.05) this.shift = this.shiftTarget;
    if (this.intro < 1) this.intro = Math.min(1, this.intro + dt / 1.5);
    const pl = this.play;
    if (pl.active && pl.running) {
      pl.clock += pl.rate * dt;
      const m = Math.floor(pl.clock * 12);
      if (m !== pl.month) {
        pl.month = m;
        const y = Math.floor(pl.clock);
        this.cb.onPlayClock?.(`${MONTHS[Math.min(11, Math.floor((pl.clock - y) * 12))]} ${y}`);
      }
      // all storms drawn and faded to rest: hand back to the normal view
      if (pl.clock > pl.t1 + pl.dur * pl.rate + 1.2 * pl.rate) {
        this.playStop();
        this.cb.onPlayEnd?.();
      }
    }
    const ease = 1 - Math.exp(-dt * 14);
    const c = this.cam;
    const t = this.camTarget;
    c.z += (t.z - c.z) * ease;
    c.tx += (t.tx - c.tx) * ease;
    c.ty += (t.ty - c.ty) * ease;
    if (Math.abs(t.z - c.z) < 1e-4 && Math.abs(t.tx - c.tx) < 0.01 && Math.abs(t.ty - c.ty) < 0.01) {
      Object.assign(c, t);
    }
  }

  private computeGeos(now: number): { w: number[]; s: number; ws: number[] } {
    const w = this.weightTween.value(now);
    const ws = this.scaleTween.value(now);
    const s = this.splitTween.value(now)[0];
    const { right, top, bottom } = this.insets;
    const left = this.insets.left + this.shift;
    const Vw = Math.max(240, this.W - left - right);
    const Vh = Math.max(240, this.H - top - bottom);
    const cyc = top + Vh / 2;
    this.rect = { x0: left, y0: top, w: Vw, h: Vh };

    const vw = lerp(Vw, Vw / 2, s);
    const m = Math.min(vw, Vh);
    const dropH = Math.min(Vh, vw * 1.3);
    const d = this.dim;
    // flow: tracks run left -> right from a fixed start near the viewer's left edge
    const flowPad = Math.min(56, vw * 0.09);
    const flowSpan = Math.max(100, vw - 2 * flowPad - 16);
    // real: fit the 90th-percentile track reach inside the tightest layout so most of the
    // shape stays in the canvas (rings stay to scale: they use the same px/km).
    d.k = Math.min(0.36 * m, 0.55 * dropH, 0.6 * Vh, 0.8 * flowSpan) / this.reach90;
    d.kF = (0.42 * m * FLOW_ZOOM) / 2000; // flow real: original fixed scale (2000 km = 42% of the viewer)
    d.mk = (vw * 0.94) / 360;
    d.peqR = 0.36 * m; // equal length: total path length in px
    d.pfxR = 0.3 * m; // fixed ends: genesis->dissipation distance in px
    d.peqD = 0.68 * dropH;
    d.pfxD = 0.58 * dropH;
    d.peqT = 0.7 * Vh; // timeline: tracks rise from the baseline
    d.pfxT = 0.6 * Vh;
    d.peqF = 0.62 * flowSpan * FLOW_ZOOM;
    d.pfxF = 0.5 * flowSpan * FLOW_ZOOM;

    for (let h = 0; h < 2; h++) {
      const g = this.geos[h];
      g.cx = left + lerp(Vw / 2, Vw * (h === 0 ? 0.25 : 0.75), s);
      g.cy = cyc;
      // radial: centred; drop: genesis low so the axis is centred; timeline: baseline low
      g.oy = cyc + w[1] * 0.3 * dropH + w[3] * 0.36 * Vh;
      g.vw = vw;
      g.k = d.k;
      g.mk = d.mk;
      g.len = d.pfxD;
      g.t0x = g.cx - vw / 2 + flowPad;
      g.t1x = g.cx + vw / 2 - flowPad;
    }
    return { w, s, ws };
  }

  // ---------- rendering ----------

  private draw(now: number): void {
    const { ctx, W, H, dpr } = this;
    const { w, s, ws } = this.computeGeos(now);
    const [wR, wDr, wM, wT, wF] = w;
    const [wsR, wsE, wsF] = ws;
    const { z, tx, ty } = this.cam;
    const dm = this.dim;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    if (wM > 0.01) this.drawLand(wM, s);
    // km rings only make sense at true scale
    if (wR * wsR > 0.01) this.drawRings(wR * wsR, s);
    if (wDr > 0.01) this.drawDropAxis(wDr, wsF, s);
    if (wT > 0.01) this.drawTimeAxis(wT, s);
    if (wR > 0.01) this.drawRadialYears(wR, s);
    if (wF > 0.01) this.drawFlowAxis(wF, s);
    if (s > 0.005) {
      const dx = Math.round(this.rect.x0 + this.rect.w / 2) + 0.5;
      ctx.globalAlpha = s * 0.5;
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1 / dpr + 0.25;
      ctx.beginPath();
      ctx.moveTo(dx, 0);
      ctx.lineTo(dx, H);
      ctx.stroke();
      this.drawHemiLabels(s);
    }

    // project all visible storms
    for (const p of this.storms) {
      if (p.alpha < 0.003) continue;
      const g = this.geos[p.hemi];
      const mk = g.mk;
      // px per km for this storm in each km-based mode (real / equal length / fixed ends)
      const mR = wsR * dm.k + wsE * (dm.peqR / p.total) + wsF * (dm.pfxR / p.straight);
      const mD = wsR * dm.k + wsE * (dm.peqD / p.total) + wsF * (dm.pfxD / p.straight);
      const mT = wsR * dm.k + wsE * (dm.peqT / p.total) + wsF * (dm.pfxT / p.straight);
      const mF = wsR * dm.kF + wsE * (dm.peqF / p.total) + wsF * (dm.pfxF / p.straight);
      // timeline: anchored on the time axis at genesis date; flow: genesis fixed at the
      // Equal-length position (centred on the equal-length extent) for every length mode
      const flowX0 = -dm.peqF / 2;
      const originX =
        g.cx + wT * (g.t0x + p.tf * (g.t1x - g.t0x) - g.cx) + wF * flowX0;
      const cr = p.cr;
      const sr = p.sr;
      for (let i = 0; i < p.n; i++) {
        const rx = p.rx[i];
        const ry = p.ry[i];
        // radial: north-aligned track rotated by its chronological angle (clockwise)
        const xr = rx * cr + ry * sr;
        const yr = -rx * sr + ry * cr;
        const x =
          originX + wR * xr * mR + (wDr * mD + wT * mT) * p.ux[i] + wF * ry * mF + wM * p.mx[i] * mk;
        const y =
          g.oy - wR * yr * mR - (wDr * mD + wT * mT) * p.uy[i] + wF * rx * mF - wM * p.my[i] * mk;
        p.sx[i] = x * z + tx;
        p.sy[i] = y * z + ty;
      }
    }

    this.updateHover();

    // storms
    ctx.globalCompositeOperation = 'screen';
    // Butt caps: each track is drawn as many short segments, and round caps overlap at every
    // joint, doubling the alpha there and making fine lines look beaded/dotted on small screens.
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    // Thinner strokes on small viewports so dense tracks stay crisp rather than smeared.
    const widthScale = clamp01(Math.min(W, H) / 640) * 0.45 + 0.55;
    // 0 on desktop-sized canvases, up to ~1 on phones: on small canvases overlapping tracks
    // flatten into one tone, so widen the gap between faint tails and bright peak segments
    // (more tonal depth) and lift the overall level slightly.
    const mob = 1 - clamp01(Math.min(W, H) / 640);
    const aFloor = 0.35 - 0.22 * mob;
    const aRange = 0.5 + 0.35 * mob;
    const lift = 1 + 0.2 * mob;
    const dimMul = 1 - this.hoverDim * 0.85;
    // With 'screen' blending, hundreds of overlapping tracks saturate towards white. Scale line
    // opacity down as more tracks are visible so overlaps build colour and depth instead
    // (≈ full strength for ~220 tracks or fewer; ~0.41x at ~1,100 tracks).
    const density = clamp01(Math.pow(220 / Math.max(this.lastCount, 1), 0.55));
    const lineScale = Math.max(0.3, density) * this.intensity * 1.12;
    // In split layout each hemisphere is clipped to its own half, so tracks never cross the
    // divider and the two sides stay totally distinct (even when zoomed or panned).
    const splitX = Math.round(this.rect.x0 + this.rect.w / 2) + 0.5;
    const clipSplit = s > 0.02;
    const clipTo = (hemi: number): void => {
      ctx.beginPath();
      if (hemi === 0) ctx.rect(0, 0, splitX, H);
      else ctx.rect(splitX, 0, W - splitX, H);
      ctx.clip();
    };
    for (let h = 0; h < 2; h++) {
      if (clipSplit) {
        ctx.save();
        clipTo(h);
      }
      this.drawStorms(h, dimMul, lineScale, widthScale, aFloor, aRange, lift);
      if (clipSplit) ctx.restore();
    }

    // hovered storm in vivid white
    const hp = this.hovered;
    if (hp && hp.alpha > 0.003) {
      if (clipSplit) {
        ctx.save();
        clipTo(hp.hemi);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#FFFFFF';
      ctx.shadowColor = 'rgba(255,255,255,0.8)';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(hp.sx[0], hp.sy[0]);
      for (let i = 1; i < hp.n; i++) ctx.lineTo(hp.sx[i], hp.sy[i]);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(hp.sx[0], hp.sy[0], 3, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      if (clipSplit) ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Draws every visible (non-hovered) storm of one hemisphere. */
  private drawStorms(
    hemi: number,
    dimMul: number,
    lineScale: number,
    widthScale: number,
    aFloor: number,
    aRange: number,
    lift: number,
  ): void {
    const { ctx } = this;
    const pl = this.play;
    const durY = pl.dur * pl.rate;
    for (const p of this.storms) {
      if (p.hemi !== hemi || p.alpha < 0.003 || p === this.hovered) continue;
      // playback: draw each track progressively from its genesis time, glowing while it grows
      let level = 1;
      let lastSeg = p.n - 1;
      let growing = false;
      if (pl.active) {
        if (pl.clock < p.t) continue;
        const f = clamp01((pl.clock - p.t) / durY);
        lastSeg = f * (p.n - 1);
        growing = f < 1;
        // same intensity while drawing as in the finished state (no extra glow, no fade)
      } else if (this.intro < 1) {
        // opening animation: one shared, eased spread fraction for every storm
        lastSeg = (1 - Math.pow(1 - this.intro, 3)) * (p.n - 1);
      }
      const base = p.alpha * dimMul * lineScale * level;
      const range = Math.max(1, p.peak - 30);
      for (let i = 1; i < p.n; i++) {
        if (i - 1 >= lastSeg) break;
        const frac = Math.min(1, lastSeg - (i - 1));
        const wi = (p.wind[i - 1] + p.wind[i]) / 2;
        const norm = clamp01((wi - 30) / range);
        ctx.globalAlpha = Math.min(1, (aFloor + aRange * norm) * base * lift * (wi >= 110 ? 1.3 : 1));
        ctx.strokeStyle = windColor(wi);
        ctx.lineWidth = (0.8 + 1.7 * norm) * widthScale;
        const x0 = p.sx[i - 1];
        const y0 = p.sy[i - 1];
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + (p.sx[i] - x0) * frac, y0 + (p.sy[i] - y0) * frac);
        ctx.stroke();
      }
      if (growing) {
        const i = Math.min(p.n - 2, Math.floor(lastSeg));
        const fr = lastSeg - i;
        const hx = p.sx[i] + (p.sx[i + 1] - p.sx[i]) * fr;
        const hy = p.sy[i] + (p.sy[i + 1] - p.sy[i]) * fr;
        // small head dot in the colour of the wind category at this point of the track
        ctx.globalAlpha = Math.min(1, 0.95 * p.alpha);
        ctx.fillStyle = windColor(p.wind[i] + (p.wind[i + 1] - p.wind[i]) * fr);
        ctx.beginPath();
        ctx.arc(hx, hy, 1.3 * widthScale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawRings(alpha: number, s: number): void {
    const { ctx } = this;
    const { z, tx, ty } = this.cam;
    ctx.save();
    ctx.setLineDash([3, 7]);
    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'bottom';
    for (let h = 0; h < 2; h++) {
      const a = h === 0 ? alpha : alpha * s;
      if (a < 0.005) continue;
      const g = this.geos[h];
      const ox = g.cx * z + tx;
      const oy = g.oy * z + ty;
      for (const km of RING_KM) {
        const r = km * g.k * z;
        ctx.globalAlpha = a * 0.28;
        ctx.strokeStyle = '#94A3B8';
        ctx.beginPath();
        ctx.arc(ox, oy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = a * 0.85;
        ctx.fillStyle = '#CBD5E1';
        ctx.fillText(`${km} KM`, ox + 6, oy - r - 3);
      }
      // genesis marker
      ctx.setLineDash([]);
      ctx.globalAlpha = a * 0.6;
      ctx.fillStyle = '#E2E8F0';
      ctx.beginPath();
      ctx.arc(ox, oy, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.setLineDash([3, 7]);
    }
    ctx.restore();
  }

  /** Radial mode: chronological compass ring (earliest at top, sweeping clockwise). */
  private drawRadialYears(alpha: number, s: number): void {
    const { ctx } = this;
    const { z, tx, ty } = this.cam;
    const span = this.tMax - this.tMin;
    ctx.save();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#94A3B8';
    ctx.fillStyle = '#CBD5E1';
    ctx.lineWidth = 1;
    const marks = 8;
    for (let h = 0; h < 2; h++) {
      const a = h === 0 ? alpha : alpha * s;
      if (a < 0.005) continue;
      const g = this.geos[h];
      const cx = g.cx * z + tx;
      const cy = g.oy * z + ty;
      const R = this.dim.peqR * 1.12 * z;
      ctx.globalAlpha = a * 0.12;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();
      for (let j = 0; j < marks; j++) {
        const phi = (j / marks) * Math.PI * 2;
        const sx = Math.sin(phi);
        const sy = -Math.cos(phi);
        ctx.globalAlpha = a * 0.4;
        ctx.beginPath();
        ctx.moveTo(cx + sx * (R - 4), cy + sy * (R - 4));
        ctx.lineTo(cx + sx * (R + 4), cy + sy * (R + 4));
        ctx.stroke();
        ctx.globalAlpha = a * 0.85;
        ctx.fillText(String(Math.round(this.tMin + (j / marks) * span)), cx + sx * (R + 20), cy + sy * (R + 14));
      }
      // playback: a dotted guide from the centre to the current time on the ring, labelled
      if (this.play.active) {
        const f = clamp01((this.play.clock - this.tMin) / span);
        const phi = f * Math.PI * 2;
        const sx = Math.sin(phi);
        const sy = -Math.cos(phi);
        ctx.strokeStyle = '#94A3B8';
        ctx.fillStyle = '#E2E8F0';
        ctx.setLineDash([2, 8]);
        ctx.globalAlpha = a * 0.2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + sx * R, cy + sy * R);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = a * 0.5;
        ctx.fillText('initial heading', cx + sx * (R + 52), cy + sy * (R + 30));
        ctx.strokeStyle = '#94A3B8';
        ctx.fillStyle = '#CBD5E1';
      }
    }
    ctx.restore();
  }

  /** Flow mode: fixed start on the left, fixed initial heading to the right. */
  private drawFlowAxis(alpha: number, s: number): void {
    const { ctx } = this;
    const { z, tx, ty } = this.cam;
    ctx.save();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#E2E8F0';
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 1;
    for (let h = 0; h < 2; h++) {
      const a = h === 0 ? alpha : alpha * s;
      if (a < 0.005) continue;
      const g = this.geos[h];
      const [, wsE, wsF] = this.scaleTween.value(performance.now());
      // genesis sits at the same spot for every length mode (the Equal-length position)
      const startX = g.cx - this.dim.peqF / 2;
      const x0 = startX * z + tx;
      const x1 = (startX + (1 - wsE - wsF) * this.dim.peqF + wsE * this.dim.peqF + wsF * this.dim.pfxF) * z + tx;
      const y = g.oy * z + ty;
      ctx.setLineDash([2, 8]);
      ctx.globalAlpha = a * 0.2;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = a * 0.8;
      ctx.beginPath();
      ctx.arc(x0, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = a * 0.7;
      ctx.fillText('GENESIS', x0 - 4, y + 18);
      // arrow + label sit at the far end of the dotted line
      ctx.textAlign = 'right';
      ctx.fillText('initial heading  →', x1, y + 18);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  }

  /** Timeline mode: baseline with year ticks and faint vertical gridlines. */
  private drawTimeAxis(alpha: number, s: number): void {
    const { ctx } = this;
    const { z, tx, ty } = this.cam;
    const span = this.tMax - this.tMin;
    ctx.save();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#94A3B8';
    ctx.fillStyle = '#CBD5E1';
    for (let h = 0; h < 2; h++) {
      const a = h === 0 ? alpha : alpha * s;
      if (a < 0.005) continue;
      const g = this.geos[h];
      const y0 = g.oy * z + ty;
      const yTop = (g.oy - this.dim.peqT) * z + ty;
      ctx.globalAlpha = a * 0.4;
      ctx.beginPath();
      ctx.moveTo(g.t0x * z + tx, y0);
      ctx.lineTo(g.t1x * z + tx, y0);
      ctx.stroke();
      for (let yr = Math.ceil(this.tMin); yr <= this.tMax; yr++) {
        const x = (g.t0x + ((yr - this.tMin) / span) * (g.t1x - g.t0x)) * z + tx;
        const major = yr % 5 === 0;
        ctx.globalAlpha = a * (major ? 0.5 : 0.25);
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + (major ? 7 : 3));
        ctx.stroke();
        if (major) {
          ctx.globalAlpha = a * 0.07;
          ctx.beginPath();
          ctx.moveTo(x, y0);
          ctx.lineTo(x, yTop);
          ctx.stroke();
          ctx.globalAlpha = a * 0.85;
          ctx.fillText(String(yr), x, y0 + 11);
        }
      }
      // playback: dotted guide at the current time moving along the axis, labelled above
      if (this.play.active) {
        const f = clamp01((this.play.clock - this.tMin) / span);
        const x = (g.t0x + f * (g.t1x - g.t0x)) * z + tx;
        ctx.save();
        ctx.setLineDash([2, 8]);
        ctx.globalAlpha = a * 0.2;
        ctx.beginPath();
        ctx.moveTo(x, y0);
        ctx.lineTo(x, yTop);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = a * 0.5;
        ctx.fillStyle = '#E2E8F0';
        ctx.textBaseline = 'bottom';
        ctx.fillText('end point', x, yTop - 8);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /** Drop mode: genesis anchor, plus the fixed dissipation anchor when ends are pinned. */
  private drawDropAxis(alpha: number, fixed: number, s: number): void {
    const { ctx } = this;
    const { z, tx, ty } = this.cam;
    ctx.save();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let h = 0; h < 2; h++) {
      const a = h === 0 ? alpha : alpha * s;
      if (a < 0.005) continue;
      const g = this.geos[h];
      const x = g.cx * z + tx;
      const y0 = g.oy * z + ty;
      const y1 = (g.oy - g.len) * z + ty;
      ctx.fillStyle = '#E2E8F0';
      ctx.setLineDash([2, 8]);
      ctx.globalAlpha = a * 0.2;
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
      ctx.setLineDash([]);
      // genesis dot + label at the bottom; arrow + "end point" label at the top of the line
      // (the end-point dot itself only shows in Fixed ends, where every track finishes there)
      for (const [yy, label, dy, dotVis] of [
        [y0, 'GENESIS', 18, 1],
        [y1, 'end point', -12, fixed],
      ] as const) {
        ctx.globalAlpha = a * dotVis * 0.8;
        ctx.beginPath();
        ctx.arc(x, yy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = a * 0.7;
        ctx.fillText(label, x, yy + dy);
      }
      // arrow on its own line above the "end point" label
      ctx.globalAlpha = a * 0.7;
      ctx.fillText('↑', x, y1 - 26);
    }
    ctx.restore();
  }

  private drawLand(alpha: number, s: number): void {
    const { ctx, H } = this;
    const { z, tx, ty } = this.cam;
    for (let h = 0; h < 2; h++) {
      const a = h === 0 ? alpha : alpha * s;
      if (a < 0.005) continue;
      const g = this.geos[h];
      ctx.save();
      ctx.beginPath();
      ctx.rect((g.cx - g.vw / 2) * z + tx, 0, g.vw * z, H);
      ctx.clip();
      ctx.lineWidth = 0.75;
      ctx.fillStyle = `rgba(148,163,184,${0.07 * a})`;
      ctx.strokeStyle = `rgba(148,163,184,${0.3 * a})`;
      for (const off of [-360, 0, 360]) {
        for (const ring of LAND) {
          ctx.beginPath();
          for (let i = 0; i < ring.length; i++) {
            const x = (g.cx + (ring[i][0] + off - MAP_CENTER_LON) * g.mk) * z + tx;
            const y = (g.cy - ring[i][1] * g.mk) * z + ty;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  private drawHemiLabels(s: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#94A3B8';
    ctx.globalAlpha = s * 0.8;
    const y = this.rect.y0 + this.rect.h - 6;
    ctx.fillText('NORTHERN HEMISPHERE', this.geos[0].cx, y);
    ctx.fillText('SOUTHERN HEMISPHERE', this.geos[1].cx, y);
    ctx.restore();
  }

  // ---------- hover ----------

  private updateHover(): void {
    const ptr = this.pointer;
    if (!ptr || this.dragging || this.play.active) {
      this.setHover(null);
      return;
    }
    const maxD2 = 15 * 15;
    let best: Prepared | null = null;
    let bestD2 = maxD2;
    for (const p of this.storms) {
      if (!p.target || p.alpha < 0.5) continue;
      for (let i = 1; i < p.n; i++) {
        const d2 = segDist2(ptr.x, ptr.y, p.sx[i - 1], p.sy[i - 1], p.sx[i], p.sy[i]);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
      }
    }
    this.setHover(best);
  }
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dy = py - (ay + aby * t);
  return dx * dx + dy * dy;
}
