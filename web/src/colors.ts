// Colour encodings. Hex values come from the dataviz reference palette (light and dark steps).

export type Theme = "light" | "dark";
export type ColorBy = "pos" | "length" | "frequency" | "crowding";
export type RGBA = [number, number, number, number];

export function hex(h: string, alpha = 255): RGBA {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

const POINT_ALPHA = 215;

// Part of speech: three categorical slots (the most a scatter can carry and stay colour-blind safe),
// everything else in a neutral "other".
export const POS_GROUPS = [
  { label: "Noun", classes: ["noun"] },
  { label: "Verb", classes: ["verb"] },
  { label: "Adjective", classes: ["adjective"] },
  { label: "Other", classes: ["adverb", "function", "interjection", "other"], note: "adverbs, function words, interjections, numbers" },
];
const POS_COLORS: Record<Theme, string[]> = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#898781"],
  dark: ["#3987e5", "#d95926", "#199e70", "#898781"],
};

// Word length: an ordinal ramp on one hue; the step nearest the surface still clears 2:1.
export const LENGTH_BUCKETS = [
  { label: "1–3", max: 3 },
  { label: "4–5", max: 5 },
  { label: "6–7", max: 7 },
  { label: "8–9", max: 9 },
  { label: "10–11", max: 11 },
  { label: "12+", max: Infinity },
];
const LENGTH_COLORS: Record<Theme, string[]> = {
  light: ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281", "#0d366b"],
  dark: ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
};

// Frequency: a continuous single-hue ramp, rare words near the surface.
export const ZIPF_DOMAIN: [number, number] = [2, 5.5];
const FREQ_STOPS: Record<Theme, string[]> = {
  light: ["#86b6ef", "#3987e5", "#1c5cab", "#0d366b"],
  dark: ["#184f95", "#3987e5", "#86b6ef", "#cde2fb"],
};

// Crowding for length: diverging, sparse (blue) - typical (neutral gray) - crowded (red).
export const CROWDING_DOMAIN: [number, number] = [-2, 2];
const CROWDING_STOPS: Record<Theme, string[]> = {
  light: ["#2a78d6", "#f0efec", "#e34948"],
  dark: ["#3987e5", "#383835", "#e66767"],
};

function ramp(stops: string[], t: number, alpha: number): RGBA {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  const f = x - i;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, alpha];
}

export function posGroupOf(posClass: string): number {
  return POS_GROUPS.findIndex((g) => g.classes.includes(posClass));
}

export function lengthBucket(length: number): number {
  return LENGTH_BUCKETS.findIndex((b) => length <= b.max);
}

export interface Encoders {
  pos: (group: number) => RGBA;
  length: (length: number) => RGBA;
  frequency: (zipf: number) => RGBA;
  crowding: (value: number) => RGBA;
  swatch: (by: ColorBy) => string[];
  gradient: (by: "frequency" | "crowding") => string;
}

export function encoders(theme: Theme): Encoders {
  const pos = POS_COLORS[theme].map((c) => hex(c, POINT_ALPHA));
  const len = LENGTH_COLORS[theme].map((c) => hex(c, POINT_ALPHA));
  return {
    pos: (g) => pos[g],
    length: (l) => len[lengthBucket(l)],
    frequency: (z) => ramp(FREQ_STOPS[theme], (z - ZIPF_DOMAIN[0]) / (ZIPF_DOMAIN[1] - ZIPF_DOMAIN[0]), POINT_ALPHA),
    crowding: (v) =>
      ramp(CROWDING_STOPS[theme], (v - CROWDING_DOMAIN[0]) / (CROWDING_DOMAIN[1] - CROWDING_DOMAIN[0]), POINT_ALPHA),
    swatch: (by) => (by === "pos" ? POS_COLORS[theme] : LENGTH_COLORS[theme]),
    gradient: (by) => `linear-gradient(to right, ${(by === "frequency" ? FREQ_STOPS : CROWDING_STOPS)[theme].join(", ")})`,
  };
}

export const CHROME: Record<Theme, { ink: RGBA; ink2: RGBA; surface: RGBA; accent: RGBA }> = {
  light: { ink: hex("#0b0b0b"), ink2: hex("#52514e"), surface: hex("#fcfcfb"), accent: hex("#2a78d6") },
  dark: { ink: hex("#ffffff"), ink2: hex("#c3c2b7"), surface: hex("#1a1a19"), accent: hex("#3987e5") },
};
