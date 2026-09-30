// Loads the files written by pipeline/export.py.

export type LayoutKey = "umap" | "densmap" | "base_umap" | "base_densmap";

interface ColumnInfo {
  name: string;
  dtype: "uint8" | "uint16";
  offset: number;
  length: number;
  /** For quantised floats: [min, max], or [xmin, ymin, xmax, ymax] for interleaved x/y. */
  range?: number[];
}

export interface Meta {
  generated: string;
  count: number;
  baseCount: number;
  posClasses: string[];
  columns: ColumnInfo[];
  layouts: Record<LayoutKey, { column: string; bounds: [number, number, number, number] }>;
  zipfRange: [number, number];
  maxLength: number;
}

export interface MapData {
  meta: Meta;
  words: string[];
  index: Map<string, number>;
  pos: Uint8Array;
  length: Uint8Array;
  isBase: Uint8Array;
  zipf: Float32Array;
  densityVsLength: Float32Array;
  baseDensityVsLength: Float32Array;
  layouts: Record<LayoutKey, Float32Array>;
}

/** [part of speech, definition, word it points to?, that word's definition?] */
export type Def = [string, string, string?, string?];
/** [lemma this word is an inflection of (or 0), ...definitions] */
export type DefEntry = [string | 0, ...Def[]];

const DATA_URL = `${import.meta.env.BASE_URL}data/`;

async function fetchOk(name: string): Promise<Response> {
  const res = await fetch(DATA_URL + name);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res;
}

export async function loadMapData(): Promise<MapData> {
  const [meta, buffer, wordsText] = await Promise.all([
    fetchOk("meta.json").then((r) => r.json() as Promise<Meta>),
    fetchOk("columns.bin").then((r) => r.arrayBuffer()),
    fetchOk("words.txt").then((r) => r.text()),
  ]);
  const column = (name: string) => {
    const c = meta.columns.find((x) => x.name === name);
    if (!c) throw new Error(`missing column ${name}`);
    return c;
  };
  const bytes = (name: string) => {
    const c = column(name);
    return new Uint8Array(buffer, c.offset, c.length);
  };
  // uint16 columns hold floats quantised across `range` (per axis when interleaved x/y).
  const floats = (name: string) => {
    const c = column(name);
    const q = new Uint16Array(buffer, c.offset, c.length);
    const r = c.range!;
    const axes = r.length / 2;
    const out = new Float32Array(c.length);
    for (let i = 0; i < q.length; i++) {
      const a = i % axes;
      out[i] = r[a] + (q[i] / 65535) * (r[a + axes] - r[a]);
    }
    return out;
  };
  const words = wordsText.split("\n").slice(0, meta.count);
  return {
    meta,
    words,
    index: new Map(words.map((w, i) => [w, i])),
    pos: bytes("pos"),
    length: bytes("length"),
    isBase: bytes("is_base"),
    zipf: floats("zipf"),
    densityVsLength: floats("density_vs_length"),
    baseDensityVsLength: floats("base_density_vs_length"),
    layouts: {
      umap: floats("umap"),
      densmap: floats("densmap"),
      base_umap: floats("base_umap"),
      base_densmap: floats("base_densmap"),
    },
  };
}

export async function loadDefinitions(): Promise<DefEntry[]> {
  return (await fetchOk("defs.json")).json();
}
