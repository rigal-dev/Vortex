export type Basin = 'NA' | 'WP' | 'EP' | 'SI' | 'SP' | 'NI';
export type Hemisphere = 'N' | 'S';

/** One normalized cyclone track (see /public/cyclones.json contract). */
export interface Cyclone {
  id: string;
  name: string;
  season: number;
  basin: Basin;
  hemi: Hemisphere;
  /** knots */
  peak_wind: number;
  /** hPa */
  min_pres: number;
  /** curved length / straight distance */
  sinuosity: number;
  total_km: number;
  /** km east of genesis */
  dx: number[];
  /** km north of genesis */
  dy: number[];
  /** km east of genesis, rotated so the first 24h heading is due north */
  rx: number[];
  /** km north of genesis, rotated so the first 24h heading is due north */
  ry: number[];
  lat: number[];
  lon: number[];
  /** sustained wind (kt) per step */
  wind: number[];
  /** optional genesis time as a decimal year (e.g. 1992.64); used by the timeline view */
  t0?: number;
}

export type ViewMode = 'radial' | 'drop' | 'flow' | 'timeline' | 'map';
export type LayoutMode = 'unified' | 'split';
/** What the Split layout divides the storms by. */
export type SplitKey =
  | 'hemisphere'
  | 'basin'
  | 'category'
  | 'era'
  | 'season'
  | 'latitude'
  | 'sinuosity'
  | 'duration'
  | 'intensification';

/** Saffir-Simpson major-hurricane categories (the dataset contains Cat 3+ only). */
export type Category = 3 | 4 | 5;
export const CATEGORIES: readonly Category[] = [3, 4, 5];

/** Category from peak 1-minute sustained wind in knots (Cat 3: 96–112, Cat 4: 113–136, Cat 5: 137+). */
export function categoryOf(peakKt: number): Category {
  return peakKt >= 137 ? 5 : peakKt >= 113 ? 4 : 3;
}
/** real: true km; equal: every track scaled to equal path length; fixed: equal genesis→dissipation distance */
export type ScaleMode = 'real' | 'equal' | 'fixed';
export type BasinFilter = 'all' | 'atlantic' | 'pacific' | 'indian';

export interface FilterState {
  basin: BasinFilter;
  yearMin: number;
  yearMax: number;
  /** tracks with sinuosity below this are hidden */
  /** Saffir-Simpson categories to show */
  categories: readonly Category[];
}

export interface ViewState {
  mode: ViewMode;
  layout: LayoutMode;
  splitBy: SplitKey;
  scale: ScaleMode;
  filters: FilterState;
}

export const BASIN_GROUPS: Record<BasinFilter, readonly Basin[]> = {
  all: ['NA', 'WP', 'EP', 'SI', 'SP', 'NI'],
  atlantic: ['NA'],
  pacific: ['WP', 'EP', 'SP'],
  indian: ['NI', 'SI'],
};

const isNumArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Runtime validation for untrusted JSON. */
export function isCyclone(v: unknown): v is Cyclone {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.name !== 'string') return false;
  if (typeof c.season !== 'number' || typeof c.basin !== 'string') return false;
  if (c.hemi !== 'N' && c.hemi !== 'S') return false;
  if (!BASIN_GROUPS.all.includes(c.basin as Basin)) return false;
  for (const k of ['peak_wind', 'min_pres', 'sinuosity', 'total_km'] as const) {
    if (typeof c[k] !== 'number') return false;
  }
  const keys = ['dx', 'dy', 'rx', 'ry', 'lat', 'lon', 'wind'] as const;
  if (!keys.every((k) => isNumArray(c[k]))) return false;
  const n = (c.dx as number[]).length;
  return n >= 2 && keys.every((k) => (c[k] as number[]).length === n);
}
