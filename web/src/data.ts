// Loads the files written by pipeline/export.py.

export type LayoutKey = "umap" | "densmap" | "base_umap" | "base_densmap";

interface ColumnInfo {
  name: string;
  dtype: "uint8" | "uint16" | "int32" | "float32";
  offset: number;
  length: number;
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
  n1: Uint16Array;
  n2: Uint16Array;
  old20: Float32Array;
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
  const view = (name: string) => {
    const c = meta.columns.find((x) => x.name === name);
    if (!c) throw new Error(`missing column ${name}`);
    switch (c.dtype) {
      case "uint8":
        return new Uint8Array(buffer, c.offset, c.length);
      case "uint16":
        return new Uint16Array(buffer, c.offset, c.length);
      case "int32":
        return new Int32Array(buffer, c.offset, c.length);
      case "float32":
        return new Float32Array(buffer, c.offset, c.length);
    }
  };
  const words = wordsText.split("\n").slice(0, meta.count);
  return {
    meta,
    words,
    index: new Map(words.map((w, i) => [w, i])),
    pos: view("pos") as Uint8Array,
    length: view("length") as Uint8Array,
    isBase: view("is_base") as Uint8Array,
    zipf: view("zipf") as Float32Array,
    n1: view("n1") as Uint16Array,
    n2: view("n2") as Uint16Array,
    old20: view("old20") as Float32Array,
    densityVsLength: view("density_vs_length") as Float32Array,
    baseDensityVsLength: view("base_density_vs_length") as Float32Array,
    layouts: {
      umap: view("umap") as Float32Array,
      densmap: view("densmap") as Float32Array,
      base_umap: view("base_umap") as Float32Array,
      base_densmap: view("base_densmap") as Float32Array,
    },
  };
}

export async function loadDefinitions(): Promise<DefEntry[]> {
  return (await fetchOk("defs.json")).json();
}
