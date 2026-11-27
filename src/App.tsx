import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { VortexEngine, WIND_COLORS } from './engine';
import { generateMockCyclones } from './mock';
import {
  CATEGORIES,
  isCyclone,
  type BasinFilter,
  type Category,
  type Cyclone,
  type FilterState,
  type LayoutMode,
  type ScaleMode,
  type ViewMode,
} from './types';

const PANEL_W = 340;
const WIDE_BREAKPOINT = 900;
const VIEWER_INSETS = { top: 112, bottom: 44, left: 28 } as const;
const MOBILE_INSETS = { top: 78, right: 12, bottom: 44, left: 12 } as const;

type PaneMode = 'canvas' | 'both' | 'controls';

const iconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  'aria-hidden': true,
} as const;

const PANE_OPTIONS: ReadonlyArray<{ value: PaneMode; label: string; icon: ReactNode }> = [
  {
    value: 'canvas',
    label: 'Canvas only',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="14" height="14" rx="2" fill="currentColor" fillOpacity="0.25" />
      </svg>
    ),
  },
  {
    value: 'both',
    label: 'Canvas and controls',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="14" height="14" rx="2" />
        <path d="M3 11h14" />
        <rect x="3" y="3" width="14" height="8" rx="2" fill="currentColor" fillOpacity="0.25" />
      </svg>
    ),
  },
  {
    value: 'controls',
    label: 'Controls only',
    icon: (
      <svg {...iconProps}>
        <path d="M4 6h12M4 10h12M4 14h12" strokeLinecap="round" />
      </svg>
    ),
  },
];

const MIN_YEAR = 1980;
const CURRENT_YEAR = new Date().getFullYear();

type DataStatus = 'loading' | 'mock' | 'live';

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}

function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  const compact = options.length > 4;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex gap-0.5 rounded-lg bg-white/[0.04] p-0.5 ring-1 ring-white/10"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            id={`btn-${label.toLowerCase().replace(/\s+/g, '-')}-${o.value}`}
            type="button"
            title={o.label}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`flex-1 whitespace-nowrap rounded-md py-1.5 font-medium transition-all duration-200 ${
              compact ? 'px-1 text-[10.5px] tracking-normal' : 'px-2 text-[11px] tracking-wide'
            } ${
              active
                ? 'bg-white/90 text-[#08090C] shadow-[0_0_14px_rgba(255,255,255,0.25)]'
                : 'text-slate-400 hover:bg-white/5 hover:text-white'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

const SPEED_OPTIONS = [
  { label: 'Slow', rate: 0.75, dur: 3 },
  { label: 'Normal', rate: 1.5, dur: 2.2 },
  { label: 'Fast', rate: 3, dur: 1.5 },
  { label: 'Faster', rate: 6, dur: 1 },
] as const;

const VIEW_OPTIONS = [
  { value: 'radial', label: 'Radial' },
  { value: 'drop', label: 'Drop' },
  { value: 'flow', label: 'Flow' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'map', label: 'Map' },
] as const satisfies ReadonlyArray<{ value: ViewMode; label: string }>;

const LAYOUT_OPTIONS = [
  { value: 'unified', label: 'Unified' },
  { value: 'split', label: 'Split' },
] as const satisfies ReadonlyArray<{ value: LayoutMode; label: string }>;

const SCALE_OPTIONS = [
  { value: 'equal', label: 'Equal length' },
  { value: 'real', label: 'Real length' },
  { value: 'fixed', label: 'Fixed ends' },
] as const satisfies ReadonlyArray<{ value: ScaleMode; label: string }>;

const BASIN_OPTIONS: ReadonlyArray<{ value: BasinFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'atlantic', label: 'Atlantic' },
  { value: 'pacific', label: 'Pacific' },
  { value: 'indian', label: 'Indian Ocean' },
];

const LEGEND = [
  { color: WIND_COLORS.ts, label: 'TS < 64 kt' },
  { color: WIND_COLORS.cat12, label: 'Cat 1–2' },
  { color: WIND_COLORS.cat34, label: 'Cat 3–4' },
  { color: WIND_COLORS.cat5, label: 'Cat 5' },
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<VortexEngine | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Synthetic data renders instantly; real data replaces it when it arrives.
  const [data, setData] = useState<Cyclone[]>([]);
  const [status, setStatus] = useState<DataStatus>('loading');
  const [mode, setMode] = useState<ViewMode>('radial');
  const [layout, setLayout] = useState<LayoutMode>('unified');
  const [scale, setScale] = useState<ScaleMode>('equal');
  const [basin, setBasin] = useState<BasinFilter>('all');
  const [yearMin, setYearMin] = useState(MIN_YEAR);
  const [yearMax, setYearMax] = useState(CURRENT_YEAR);
  const [categories, setCategories] = useState<readonly Category[]>(CATEGORIES);
  const [intensity, setIntensity] = useState(1);
  // Mobile only: which panes are visible (desktop always shows both).
  const [pane, setPane] = useState<PaneMode>('both');
  const [hovered, setHovered] = useState<Cyclone | null>(null);
  const [visible, setVisible] = useState(0);
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE_BREAKPOINT);
  // Desktop only: the docked controls panel can be collapsed to give the canvas the full width.
  const [menuOpen, setMenuOpen] = useState(true);
  const menuOpenRef = useRef(true);
  // Chronological playback
  const [playState, setPlayState] = useState<'idle' | 'playing' | 'paused'>('idle');
  const [speedIdx, setSpeedIdx] = useState(1);
  const [playLabel, setPlayLabel] = useState<string | null>(null);

  const yearBounds = useMemo(() => {
    let max = CURRENT_YEAR;
    for (const c of data) if (c.season > max) max = c.season;
    return { min: MIN_YEAR, max };
  }, [data]);

  const filters: FilterState = useMemo(
    () => ({ basin, yearMin, yearMax, categories }),
    [basin, yearMin, yearMax, categories],
  );

  // Engine lifecycle
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const engine = new VortexEngine(canvas, {
      onHover: setHovered,
      onVisibleCount: setVisible,
      onPlayClock: setPlayLabel,
      onPlayEnd: () => setPlayState('idle'),
    });
    engineRef.current = engine;
    // Keep the visualization inside the stage: clear of the docked panel on desktop,
    // with compact margins on the stacked mobile layout.
    const fit = () => {
      const isWide = window.innerWidth >= WIDE_BREAKPOINT;
      setWide(isWide);
      engine.setInsets(isWide ? { ...VIEWER_INSETS, right: PANEL_W } : MOBILE_INSETS);
      engine.setShift(isWide && !menuOpenRef.current ? (PANEL_W - VIEWER_INSETS.left) / 2 : 0);
    };
    fit();
    engine.start();
    // The stage (not the window) defines the canvas size, so observe it directly.
    const ro = new ResizeObserver(() => {
      engine.resize();
      fit();
    });
    ro.observe(stage);
    return () => {
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const startPlay = () => {
    const sp = SPEED_OPTIONS[speedIdx];
    engineRef.current?.playStart(sp.rate, sp.dur);
    setPlayState('playing');
  };
  const togglePlay = () => {
    if (playState === 'idle') startPlay();
    else setPlayState(engineRef.current?.playToggle() ? 'playing' : 'paused');
  };
  const stopPlay = () => {
    engineRef.current?.playStop();
    setPlayState('idle');
  };
  const changeSpeed = (i: number) => {
    setSpeedIdx(i);
    engineRef.current?.playSetSpeed(SPEED_OPTIONS[i].rate, SPEED_OPTIONS[i].dur);
  };

  // Re-centre the visualization (without resizing it) when the desktop panel collapses or expands.
  useEffect(() => {
    menuOpenRef.current = menuOpen;
    if (window.innerWidth >= WIDE_BREAKPOINT) {
      // Same size, just re-centred in the freed space.
      engineRef.current?.setShift(menuOpen ? 0 : (PANEL_W - VIEWER_INSETS.left) / 2);
    }
  }, [menuOpen]);

  // Push data first, then view (filters need data present). Declared in this order on purpose.
  useEffect(() => {
    engineRef.current?.setData(data);
    engineRef.current?.setView({ mode, layout, scale, filters });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    engineRef.current?.setView({ mode, layout, scale, filters });
  }, [mode, layout, scale, filters]);

  useEffect(() => {
    engineRef.current?.setIntensity(intensity);
  }, [intensity]);

  // Load the real dataset in the background.
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}cyclones.json`, { signal: ctrl.signal });
        if (!res.ok) throw new Error('bad response');
        const json: unknown = await res.json();
        if (!Array.isArray(json)) throw new Error('bad data');
        const valid = json.filter(isCyclone);
        if (valid.length === 0) throw new Error('empty data');
        setData(valid);
        setStatus('live');
      } catch {
        // Offline, 404 or malformed: fall back to the synthetic preview (not when aborted).
        if (!ctrl.signal.aborted) {
          setData(generateMockCyclones(CURRENT_YEAR));
          setStatus('mock');
        }
      }
    })();
    return () => ctrl.abort();
  }, []);

  // Pointer position is passed to the engine in canvas-local coordinates.
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const r = stageRef.current?.getBoundingClientRect();
    engineRef.current?.setPointer(e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
    const tip = tooltipRef.current;
    if (tip) {
      const w = 248;
      const h = tip.offsetHeight || 180;
      const x = Math.min(e.clientX + 18, window.innerWidth - w - 12);
      const y = Math.min(e.clientY + 18, window.innerHeight - h - 12);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, []);

  const onPointerLeave = useCallback(() => engineRef.current?.setPointer(null), []);

  // At least one category always stays selected so the canvas is never silently empty.
  const toggleCategory = (cat: Category) => {
    setCategories((prev) => {
      if (!prev.includes(cat)) return CATEGORIES.filter((c) => c === cat || prev.includes(c));
      return prev.length > 1 ? prev.filter((c) => c !== cat) : prev;
    });
  };

  const onYearMin = (v: number) => {
    setYearMin(Math.min(v, yearMax));
  };
  const onYearMax = (v: number) => {
    setYearMax(Math.max(v, yearMin));
  };

  return (
    <main
      className="relative flex h-full w-full select-none flex-col bg-[#08090C] min-[900px]:relative min-[900px]:block"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {/* Stage: fixed area above the controls on mobile; full-bleed behind the panel on desktop */}
      <div
        ref={stageRef}
        className={`relative overflow-hidden min-[900px]:absolute min-[900px]:inset-0 min-[900px]:block min-[900px]:h-auto min-[900px]:min-h-0 ${
          pane === 'both'
            ? 'h-[50dvh] min-h-[260px] shrink-0'
            : pane === 'canvas'
              ? 'min-h-0 flex-1'
              : 'hidden'
        }`}
      >
      <canvas
        ref={canvasRef}
        id="vortex-canvas"
        aria-label="Cyclone track visualization"
        className="absolute inset-0 block"
      />

      {/* Title block (floats over the viewer, top-left) */}
      <header className="vx-fade-in pointer-events-none absolute left-3 top-3 min-[900px]:left-7 min-[900px]:top-6">
        <h1 className="text-base font-light tracking-[0.3em] text-slate-300/80 min-[900px]:text-xl">
          VORTEX
        </h1>
        <p className="mt-1 text-[11px] text-slate-400 min-[900px]:mt-2 min-[900px]:text-sm">
          Morphology of Global Cyclones
        </p>
        <p className="mt-0.5 text-[11px] text-slate-500 min-[900px]:mt-1 min-[900px]:text-sm">
          {visible.toLocaleString()} cyclones
        </p>
        <p className="mt-0.5 text-[11px] text-slate-500 min-[900px]:mt-1 min-[900px]:text-sm">
          1980–present
        </p>
      </header>

      {/* Playback date */}
      {playLabel && (
        <div className="pointer-events-none absolute bottom-8 left-3 font-mono text-lg tracking-wide text-slate-300/80 min-[900px]:bottom-10 min-[900px]:left-7 min-[900px]:text-2xl">
          {playLabel}
        </div>
      )}

      {/* Interaction hint (bottom-left) */}
      <div className="pointer-events-none absolute bottom-3 left-3 hidden font-mono text-[10px] tracking-wide text-slate-600 sm:block min-[900px]:bottom-4 min-[900px]:left-7">
        scroll to zoom · drag to pan · double-click to reset
      </div>

      {/* Zoom controls */}
      <div
        className="absolute bottom-3 flex flex-col items-end gap-2 min-[900px]:bottom-4"
        style={{ right: wide ? (menuOpen ? PANEL_W + 20 : 20) : 12 }}
      >
        <div
          className="flex overflow-hidden rounded-lg border border-white/10 bg-[#0B0D12]/70 backdrop-blur-xl"
          onPointerMove={(e) => e.stopPropagation()}
          onPointerEnter={onPointerLeave}
        >
          {(
            [
              ['btn-zoom-out', 'Zoom out', '−', () => engineRef.current?.zoomBy(1 / 1.5)],
              ['btn-zoom-reset', 'Reset view', '⟲', () => engineRef.current?.resetCamera()],
              ['btn-zoom-in', 'Zoom in', '+', () => engineRef.current?.zoomBy(1.5)],
            ] as const
          ).map(([id, label, glyph, fn]) => (
            <button
              key={id}
              id={id}
              type="button"
              aria-label={label}
              title={label}
              onClick={fn}
              className="h-9 w-9 font-mono text-base text-slate-400 transition hover:bg-white/10 hover:text-white"
            >
              {glyph}
            </button>
          ))}
        </div>
      </div>
      </div>

      {/* Mobile pane switcher: canvas only / both / controls only */}
      <div
        role="group"
        aria-label="Visible panes"
        className="absolute right-2 top-2 z-20 flex items-center gap-0.5 rounded-md border border-white/10 bg-[#0B0D12]/80 p-0.5 backdrop-blur-xl min-[900px]:hidden"
      >
        {PANE_OPTIONS.map((o) => (
          <button
            key={o.value}
            id={`btn-pane-${o.value}`}
            type="button"
            aria-pressed={pane === o.value}
            aria-label={o.label}
            title={o.label}
            onClick={() => setPane(o.value)}
            className={`flex h-6 w-7 items-center justify-center rounded [&>svg]:h-3.5 [&>svg]:w-3.5 transition ${
              pane === o.value ? 'bg-white/90 text-[#08090C]' : 'text-slate-400 hover:bg-white/10 hover:text-white'
            }`}
          >
            {o.icon}
          </button>
        ))}
      </div>

      {/* Desktop: collapse / expand the controls panel */}
      <button
        id="btn-menu-toggle"
        type="button"
        aria-label={menuOpen ? 'Hide controls' : 'Show controls'}
        aria-expanded={menuOpen}
        title={menuOpen ? 'Hide controls' : 'Show controls'}
        onClick={() => setMenuOpen((o) => !o)}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerEnter={onPointerLeave}
        className="absolute top-4 z-30 hidden h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-[#0B0D12]/80 font-mono text-sm text-slate-400 backdrop-blur-xl transition-[right,color] duration-300 hover:text-white min-[900px]:flex"
        style={{ right: menuOpen ? PANEL_W + 12 : 12 }}
      >
        {menuOpen ? '›' : '‹'}
      </button>

      {/* Controls: scrollable area below the stage on mobile; docked right panel on desktop */}
      <aside
        id="hud-panel"
        className={`overflow-y-auto overscroll-contain border-t border-white/10 bg-[#0B0D12] p-4 min-[900px]:absolute min-[900px]:right-0 min-[900px]:top-0 min-[900px]:block min-[900px]:h-full min-[900px]:w-[340px] min-[900px]:flex-none min-[900px]:border-l min-[900px]:border-t-0 min-[900px]:bg-[#0B0D12]/90 min-[900px]:p-6 min-[900px]:shadow-[-20px_0_60px_rgba(0,0,0,0.5)] min-[900px]:backdrop-blur-xl min-[900px]:transition-transform min-[900px]:duration-300 ${
          menuOpen ? '' : 'min-[900px]:pointer-events-none min-[900px]:translate-x-full'
        } ${
          pane === 'canvas' ? 'hidden' : pane === 'controls' ? 'min-h-0 flex-1 pt-12' : 'min-h-0 flex-1'
        }`}
        onPointerMove={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerEnter={onPointerLeave}
      >
        <div className="space-y-6">
          <Section title="Shape">
            <Segmented label="View" value={mode} options={VIEW_OPTIONS} onChange={setMode} />
            <div className={`transition-opacity ${mode === 'map' ? 'opacity-35' : ''}`}>
              <Segmented label="Length" value={scale} options={SCALE_OPTIONS} onChange={setScale} />
            </div>
            <p className="text-[10px] leading-snug text-slate-500">
              {mode === 'map'
                ? 'Map shows true geography; length modes apply to the other views.'
                : scale === 'real'
                  ? 'True kilometres from the genesis point.'
                  : scale === 'equal'
                    ? 'Every track rescaled to the same path length.'
                    : 'Every track rescaled so genesis and dissipation are the same distance apart.'}
            </p>
          </Section>

          <Section title="Layout">
            <Segmented label="Layout" value={layout} options={LAYOUT_OPTIONS} onChange={setLayout} />
          </Section>

          <Section title="Playback">
            <div className="flex items-center gap-2">
              <button
                id="btn-play"
                type="button"
                onClick={togglePlay}
                aria-label={playState === 'playing' ? 'Pause' : 'Play chronologically'}
                className="flex h-8 flex-1 items-center justify-center gap-2 rounded-lg bg-white/[0.04] text-[11px] text-slate-200 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
              >
                <span aria-hidden>{playState === 'playing' ? '❚❚' : '▶'}</span>
                {playState === 'playing' ? 'Pause' : playState === 'paused' ? 'Resume' : 'Play'}
              </button>
              {playState !== 'idle' && (
                <button
                  id="btn-stop"
                  type="button"
                  onClick={stopPlay}
                  aria-label="Stop playback"
                  title="Stop"
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-[11px] text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white"
                >
                  ■
                </button>
              )}
              <select
                id="select-speed"
                aria-label="Playback speed"
                value={speedIdx}
                onChange={(e) => changeSpeed(Number(e.target.value))}
                className="h-8 rounded-lg bg-[#0B0D12] px-2 text-[11px] text-slate-300 ring-1 ring-white/10 outline-none transition hover:text-white focus:ring-white/30"
              >
                {SPEED_OPTIONS.map((o, i) => (
                  <option key={o.label} value={i}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-[10px] leading-snug text-slate-500">
              Replays the filtered years in order: each storm draws in from its genesis date, glowing as it grows.
            </p>
          </Section>

          <Section title="Basin">
            <div className="flex flex-wrap gap-1.5">
              {BASIN_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  id={`pill-basin-${o.value}`}
                  type="button"
                  aria-pressed={basin === o.value}
                  onClick={() => setBasin(o.value)}
                  className={`rounded-full px-3 py-1 text-[11px] ring-1 transition-all duration-200 ${
                    basin === o.value
                      ? 'bg-cyan-400/15 text-cyan-200 ring-cyan-400/60 shadow-[0_0_14px_rgba(6,182,212,0.3)]'
                      : 'text-slate-400 ring-white/10 hover:text-white hover:ring-white/30'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Temporal range">
            {/* One row: lower bound · single timeline with two handles · upper bound */}
            <div className="flex items-center gap-3 font-mono text-xs text-slate-300">
              <span className="w-9 text-right">{yearMin}</span>
              <div className="vx-dual flex-1">
                <div className="absolute left-0 right-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-white/15" />
                <div
                  className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-cyan-400/70"
                  style={{
                    left: `calc(6px + (100% - 12px) * ${(yearMin - yearBounds.min) / Math.max(1, yearBounds.max - yearBounds.min)})`,
                    right: `calc(6px + (100% - 12px) * ${1 - (yearMax - yearBounds.min) / Math.max(1, yearBounds.max - yearBounds.min)})`,
                  }}
                />
                <input
                  id="slider-year-min"
                  aria-label="Earliest season"
                  type="range"
                  className="vx-range"
                  style={{ zIndex: yearMin >= yearBounds.max - 1 ? 2 : 1 }}
                  min={yearBounds.min}
                  max={yearBounds.max}
                  value={yearMin}
                  onChange={(e) => onYearMin(+e.target.value)}
                />
                <input
                  id="slider-year-max"
                  aria-label="Latest season"
                  type="range"
                  className="vx-range"
                  min={yearBounds.min}
                  max={yearBounds.max}
                  value={yearMax}
                  onChange={(e) => onYearMax(+e.target.value)}
                />
              </div>
              <span className="w-9">{yearMax}</span>
            </div>
          </Section>

          <Section title="Category">
            <div className="flex gap-1.5">
              {CATEGORIES.map((cat) => {
                const on = categories.includes(cat);
                const color = cat === 5 ? WIND_COLORS.cat5 : WIND_COLORS.cat34;
                return (
                  <button
                    key={cat}
                    id={`pill-category-${cat}`}
                    type="button"
                    aria-pressed={on}
                    title={cat === 3 ? '96–112 kt' : cat === 4 ? '113–136 kt' : '137+ kt'}
                    onClick={() => toggleCategory(cat)}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-full py-1 text-[11px] ring-1 transition-all duration-200 ${
                      on ? 'text-white ring-white/40 bg-white/[0.07]' : 'text-slate-500 ring-white/10 hover:text-white'
                    }`}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full transition-opacity"
                      style={{ background: color, opacity: on ? 1 : 0.25, boxShadow: on ? `0 0 8px ${color}` : 'none' }}
                    />
                    Cat {cat}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Line intensity">
            {/* One row: scale ends, slider and numeric value */}
            <div className="flex items-center gap-2 font-mono text-[10px] text-slate-500">
              <span>softer</span>
              <input
                id="slider-intensity"
                aria-label="Line intensity"
                type="range"
                className="vx-range min-w-0 flex-1"
                min={0.3}
                max={1.8}
                step={0.05}
                value={intensity}
                onChange={(e) => setIntensity(+e.target.value)}
                onDoubleClick={() => setIntensity(1)}
              />
              <span>brighter</span>
              <span className="w-10 text-right text-xs text-slate-300">
                {intensity === 1 ? 'auto' : `${intensity.toFixed(2)}×`}
              </span>
            </div>
          </Section>

          <footer className="space-y-2.5 border-t border-white/10 pt-4">
            <div className="flex items-center justify-between gap-2">
              {LEGEND.map((l) => (
                <div key={l.label} className="flex items-center gap-1.5 whitespace-nowrap text-[10px] text-slate-400">
                  <span
                    className="h-[3px] w-3 rounded-full"
                    style={{ background: l.color, boxShadow: `0 0 8px ${l.color}` }}
                  />
                  {l.label}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between font-mono text-[10px] text-slate-500">
              <span>
                {visible} of {data.length} tracks shown
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    status === 'live' ? 'bg-emerald-400' : 'animate-pulse bg-amber-400'
                  }`}
                />
                {status === 'live' ? 'cyclones.json' : status === 'loading' ? 'loading…' : 'synthetic preview'}
              </span>
            </div>
          </footer>
        </div>
      </aside>
      {/* Hover card */}
      <div
        ref={tooltipRef}
        id="hover-card"
        role="status"
        aria-live="polite"
        className={`pointer-events-none fixed left-0 top-0 z-20 w-[248px] rounded-xl border border-white/20 bg-[#0B0D12]/85 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.7)] backdrop-blur-xl transition-opacity duration-150 ${
          hovered ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {hovered && (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-lg font-light tracking-wide text-white">{hovered.name}</span>
              <span className="font-mono text-xs text-slate-400">{hovered.season}</span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {hovered.basin} · {hovered.hemi === 'N' ? 'Northern' : 'Southern'} Hemisphere
            </div>
            <dl className="mt-3 space-y-1.5 border-t border-white/10 pt-3 font-mono text-xs">
              <Row k="Peak wind" v={`${Math.round(hovered.peak_wind)} kt`} />
              <Row k="Min pressure" v={`${Math.round(hovered.min_pres)} hPa`} />
              <Row k="Sinuosity" v={hovered.sinuosity.toFixed(2)} />
              <Row k="Track length" v={`${Math.round(hovered.total_km).toLocaleString()} km`} />
            </dl>
          </>
        )}
      </div>
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-slate-100">{v}</dd>
    </div>
  );
}
