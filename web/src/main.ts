import "./style.css";
import { Deck, LinearInterpolator, OrthographicView } from "@deck.gl/core";
import type { OrthographicViewState, PickingInfo } from "@deck.gl/core";
import { LineLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { DataFilterExtension } from "@deck.gl/extensions";
import { loadDefinitions, loadMapData } from "./data";
import type { DefEntry, LayoutKey, MapData } from "./data";
import {
  CHROME,
  CROWDING_DOMAIN,
  LENGTH_BUCKETS,
  POS_GROUPS,
  ZIPF_DOMAIN,
  encoders,
  posGroupOf,
} from "./colors";
import type { ColorBy, Encoders, RGBA, Theme } from "./colors";
import { distancesFrom, levenshtein, nearest, wordLadder } from "./lev";
import type { Near } from "./lev";

type View = "all" | "base";
type Layout = "umap" | "densmap";

interface Placed {
  text: string;
  position: [number, number];
  near: Near[];
  anchor: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = new Intl.NumberFormat("en");
const TOP_N_MIN = 500;
const LABEL_ZOOM_OFFSET = 1.2; // labels appear once zoomed this far in from the full view
const LABEL_SIZE = 12.5;
const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const TRANSITION_MS = 900;
const FLY_ZOOM_IN = 3.2; // how far in from the full view search results are shown

const state = {
  view: "all" as View,
  layout: "umap" as Layout,
  colorBy: "pos" as ColorBy,
  theme: (localStorage.getItem("wordmap-theme") ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) as Theme,
  posOn: [] as boolean[], // per POS class
  lenMin: 1,
  lenMax: 30,
  topN: 0,
  selected: null as number | null,
  placed: null as Placed | null,
  ladder: null as number[] | null,
  zoom: 0,
  fullZoom: 0,
  transitioning: false,
};

let data: MapData;
let defs: DefEntry[] | null = null;
let enc: Encoders;
let deck: Deck<OrthographicView>;
// One stable data object for the points layer: a new object would make deck.gl recompute every
// point's attributes on each render.
let allPoints: { length: number };
// Distances from the selected word to every word in the current view, computed on selection.
let selectedDistances: Uint8Array | null = null;

const filterExtension = new DataFilterExtension({ filterSize: 3, categorySize: 1 });

// ---------------------------------------------------------------------------------------------
// Visibility and positions

const layoutKey = (): LayoutKey => (state.view === "base" ? `base_${state.layout}` : state.layout);
const inView = (i: number) => state.view === "all" || data.isBase[i] === 1;
const visible = (i: number) =>
  inView(i) &&
  state.posOn[data.pos[i]] &&
  data.length[i] >= state.lenMin &&
  data.length[i] <= state.lenMax &&
  i < state.topN;

function position(i: number): [number, number] {
  const xy = data.layouts[layoutKey()];
  return [xy[2 * i], xy[2 * i + 1]];
}

function filterProps() {
  return {
    extensions: [filterExtension],
    getFilterValue: (_: unknown, { index }: { index: number }) => [data.length[index], index, data.isBase[index]],
    getFilterCategory: (_: unknown, { index }: { index: number }) => data.pos[index],
    filterRange: [
      [state.lenMin, state.lenMax],
      [0, state.topN - 1],
      [state.view === "base" ? 1 : 0, 1],
    ] as [number, number][],
    filterCategories: state.posOn.flatMap((on, i) => (on ? [i] : [])),
  };
}

function pointColor(i: number): RGBA {
  switch (state.colorBy) {
    case "pos":
      return enc.pos(posGroupOf(data.meta.posClasses[data.pos[i]]));
    case "length":
      return enc.length(data.length[i]);
    case "frequency":
      return enc.frequency(data.zipf[i]);
    case "crowding":
      return enc.crowding((state.view === "base" ? data.baseDensityVsLength : data.densityVsLength)[i]);
  }
}

// ---------------------------------------------------------------------------------------------
// Layers

function layers() {
  const chrome = CHROME[state.theme];
  const key = layoutKey();
  const xy = data.layouts[key];
  const getPosition = (_: unknown, { index, target }: { index: number; target: number[] }) => {
    target[0] = xy[2 * index];
    target[1] = xy[2 * index + 1];
    target[2] = 0;
    return target as [number, number, number];
  };
  const easing = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  const out: unknown[] = [
    new ScatterplotLayer({
      id: "points",
      data: allPoints,
      getPosition,
      getFillColor: (_: unknown, { index }: { index: number }) => pointColor(index),
      getRadius: 1,
      radiusUnits: "pixels",
      radiusScale: Math.min(4, Math.max(1.6, 1.6 + 0.35 * (state.zoom - state.fullZoom))),
      pickable: true,
      transitions: { getPosition: { duration: TRANSITION_MS, easing } },
      updateTriggers: {
        getPosition: key,
        getFillColor: [state.colorBy, state.theme, state.view],
      },
      ...filterProps(),
    }),
    new TextLayer({
      id: "labels",
      data: labelIndices,
      visible: !state.transitioning,
      getPosition: (i: number) => position(i),
      getText: (i: number) => data.words[i],
      getSize: LABEL_SIZE,
      sizeUnits: "pixels",
      getColor: chrome.ink,
      fontFamily: FONT,
      fontWeight: 500,
      characterSet: "abcdefghijklmnopqrstuvwxyz",
      fontSettings: { sdf: true, fontSize: 48, buffer: 6 },
      outlineWidth: 4,
      outlineColor: chrome.surface,
      getTextAnchor: "middle",
      getAlignmentBaseline: "center",
      updateTriggers: { getPosition: key, getColor: state.theme },
    }),
  ];

  const sel = state.selected;
  if (sel !== null && inView(sel) && selectedDistances) {
    const from = position(sel);
    const neighbours: number[] = [];
    selectedDistances.forEach((d, i) => d === 1 && visible(i) && neighbours.push(i));
    out.push(
      new LineLayer({
        id: "neighbour-lines",
        data: neighbours,
        getSourcePosition: () => from,
        getTargetPosition: (i: number) => position(i),
        getColor: [...chrome.ink2.slice(0, 3), 110] as RGBA,
        getWidth: 1,
      }),
    );
  }
  if (state.ladder && state.ladder.length > 1) {
    out.push(
      new PathLayer({
        id: "ladder-path",
        data: [state.ladder.map(position)],
        getPath: (p: [number, number][]) => p,
        getColor: chrome.accent,
        getWidth: 2.5,
        widthUnits: "pixels",
        jointRounded: true,
        capRounded: true,
      }),
    );
  }
  // Rings and always-on labels for the selection, the ladder and a placed string.
  const marks = markList();
  if (marks.length) {
    out.push(
      new ScatterplotLayer({
        id: "marks",
        data: marks,
        getPosition: (m: Mark) => m.position,
        getRadius: (m: Mark) => (m.strong ? 7 : 5),
        radiusUnits: "pixels",
        stroked: true,
        filled: true,
        getFillColor: [0, 0, 0, 0],
        getLineColor: chrome.ink,
        getLineWidth: 2,
        lineWidthUnits: "pixels",
      }),
      new TextLayer({
        id: "mark-labels",
        data: marks,
        getPosition: (m: Mark) => m.position,
        getText: (m: Mark) => m.text,
        getSize: (m: Mark) => (m.strong ? 15 : 13),
        getColor: chrome.ink,
        fontFamily: FONT,
        fontWeight: 650,
        characterSet: "auto",
        background: true,
        getBackgroundColor: [...chrome.surface.slice(0, 3), 235] as RGBA,
        backgroundPadding: [5, 2],
        getTextAnchor: "start",
        getAlignmentBaseline: "center",
        getPixelOffset: [11, 0],
      }),
    );
  }
  return out;
}

interface Mark {
  position: [number, number];
  text: string;
  strong: boolean;
  word?: number;
}

function markList(): Mark[] {
  const marks: Mark[] = [];
  const sel = state.selected;
  if (sel !== null && inView(sel)) marks.push({ position: position(sel), text: data.words[sel], strong: true, word: sel });
  for (const i of state.ladder ?? [])
    if (i !== sel) marks.push({ position: position(i), text: data.words[i], strong: false, word: i });
  // A placed string shares its anchor word's spot, so one label names both.
  const p = state.placed;
  if (p) marks.push({ position: p.position, text: `“${p.text}” by ${data.words[p.anchor]}`, strong: true, word: p.anchor });
  return marks;
}

function render() {
  deck.setProps({ layers: layers() as never });
}

// ---------------------------------------------------------------------------------------------
// Camera

function fitView(): OrthographicViewState {
  const [x0, y0, x1, y1] = data.meta.layouts[layoutKey()].bounds;
  const el = $("map");
  const zoom = Math.log2(Math.min(el.clientWidth / ((x1 - x0) * 1.08), el.clientHeight / ((y1 - y0) * 1.08)));
  return { target: [(x0 + x1) / 2, (y0 + y1) / 2, 0], zoom };
}

function flyTo(xy: [number, number], minZoomIn = FLY_ZOOM_IN) {
  const zoom = Math.max(state.zoom, state.fullZoom + minZoomIn);
  deck.setProps({
    initialViewState: {
      target: [xy[0], xy[1], 0],
      zoom,
      transitionDuration: 700,
      transitionInterpolator: new LinearInterpolator(["target", "zoom"]),
    } as OrthographicViewState,
  });
  onZoom(zoom);
}

function onZoom(zoom: number) {
  const sizeBefore = Math.round(state.zoom * 4);
  state.zoom = zoom;
  if (sizeBefore !== Math.round(zoom * 4)) render();
  scheduleLabels();
}

// ---------------------------------------------------------------------------------------------
// Labels: once zoomed in, label as many words in view as fit without overlapping, most frequent
// first. Done on the CPU over the words in view only, after the camera settles, so its cost does
// not depend on the GPU or grow with the vocabulary.

let labelIndices: number[] = [];
let labelTimer = 0;

function scheduleLabels() {
  window.clearTimeout(labelTimer);
  labelTimer = window.setTimeout(updateLabels, 90);
}

function updateLabels() {
  const vp = deck?.getViewports()[0];
  const zoomIn = state.zoom - state.fullZoom;
  if (!vp || zoomIn < LABEL_ZOOM_OFFSET) {
    if (labelIndices.length) {
      labelIndices = [];
      render();
    }
    return;
  }
  const cell = 48;
  const grid = new Map<number, [number, number, number, number][]>();
  const cols = Math.ceil(vp.width / cell) + 1;
  const cellsOf = (b: [number, number, number, number]) => {
    const out: number[] = [];
    for (let cy = Math.floor(b[1] / cell); cy <= Math.floor(b[3] / cell); cy++)
      for (let cx = Math.floor(b[0] / cell); cx <= Math.floor(b[2] / cell); cx++) out.push(cy * cols + cx);
    return out;
  };
  const fits = (b: [number, number, number, number]) =>
    cellsOf(b).every((c) => !(grid.get(c) ?? []).some((o) => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3]));
  const claim = (b: [number, number, number, number]) => {
    for (const c of cellsOf(b)) {
      const list = grid.get(c);
      if (list) list.push(b);
      else grid.set(c, [b]);
    }
  };
  const boxAt = (i: number, [sx, sy]: number[]): [number, number, number, number] => {
    const w = data.words[i].length * LABEL_SIZE * 0.56 + 10;
    return [sx - w / 2, sy - LABEL_SIZE * 0.8, sx + w / 2, sy + LABEL_SIZE * 0.8];
  };
  // Marked words (selection, ladder, placed string) carry their own labels to the right of their
  // rings; keep that space clear and don't label those words twice.
  const marked = new Set<number>();
  for (const m of markList()) {
    const [sx, sy] = vp.project(m.position);
    claim([sx - 10, sy - 12, sx + 24 + m.text.length * 9, sy + 12]);
    if (m.word !== undefined) marked.add(m.word);
  }
  const maxLabels = Math.round(Math.min(700, (vp.width * vp.height) / 2500));
  const [ax, ay] = vp.unproject([0, 0]);
  const [bx, by] = vp.unproject([vp.width, vp.height]);
  const [x0, x1] = [Math.min(ax, bx), Math.max(ax, bx)];
  const [y0, y1] = [Math.min(ay, by), Math.max(ay, by)];
  const xy = data.layouts[layoutKey()];
  const next: number[] = [];
  for (let i = 0; i < data.meta.count && next.length < maxLabels; i++) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    if (x < x0 || x > x1 || y < y0 || y > y1 || marked.has(i) || !visible(i)) continue;
    const box = boxAt(i, vp.project([x, y]));
    if (fits(box)) {
      claim(box);
      next.push(i);
    }
  }
  labelIndices = next;
  render();
}

// ---------------------------------------------------------------------------------------------
// Tooltip

function describe(i: number): { pos: string; def: string; via?: string } {
  const entry = defs?.[i];
  const first = entry?.[1];
  const pos = data.meta.posClasses[data.pos[i]];
  if (!first) return { pos, def: defs ? "" : "…" };
  return { pos, def: first[1], via: first[2] ? `${first[2]}: ${first[3]}` : undefined };
}

function showTooltip(info: PickingInfo) {
  const tip = $("tooltip");
  if (info.layer?.id !== "points" || info.index < 0) {
    tip.hidden = true;
    return;
  }
  const i = info.index;
  const d = describe(i);
  tip.replaceChildren();
  const head = document.createElement("div");
  const word = document.createElement("span");
  word.className = "word";
  word.textContent = data.words[i];
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `${d.pos} · ${data.length[i]} letters · #${fmt.format(i + 1)}`;
  head.append(word, meta);
  tip.append(head);
  if (d.def) {
    const def = document.createElement("div");
    def.className = "def";
    def.textContent = d.via ? `${d.def} — ${d.via}` : d.def;
    tip.append(def);
  }
  const rect = $("map").getBoundingClientRect();
  tip.hidden = false;
  const x = rect.left + info.x + 14;
  const y = rect.top + info.y + 14;
  tip.style.left = `${Math.min(x, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(y, innerHeight - tip.offsetHeight - 8)}px`;
}

// ---------------------------------------------------------------------------------------------
// Details panel

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function wordChips(indices: number[], limit: number, dist?: Uint8Array): HTMLElement {
  const box = el("div", undefined, "chips");
  for (const i of indices.slice(0, limit)) {
    const b = el("button", data.words[i]);
    b.type = "button";
    b.title = dist ? `${dist[i]} edit${dist[i] === 1 ? "" : "s"} away` : "";
    b.addEventListener("click", () => select(i));
    box.append(b);
  }
  if (indices.length > limit) box.append(el("span", `+ ${fmt.format(indices.length - limit)} more`, "more"));
  return box;
}

function showDetails(i: number) {
  const body = $("details-body");
  body.replaceChildren();
  const entry = defs?.[i];
  const pos = data.meta.posClasses[data.pos[i]];
  body.append(el("h2", data.words[i]));
  const sub = el("p", `${pos} · ${data.length[i]} letters · #${fmt.format(i + 1)} most common`, "sub");
  const lemma = entry?.[0];
  if (lemma) {
    sub.append(" · form of ");
    const li = data.index.get(lemma);
    if (li !== undefined) {
      const link = el("button", lemma, "link");
      link.addEventListener("click", () => select(li));
      sub.append(link);
    } else sub.append(lemma);
  }
  body.append(sub);

  if (entry && entry.length > 1) {
    const list = el("ul", undefined, "defs");
    for (const [p, text, viaWord, viaText] of entry.slice(1) as [string, string, string?, string?][]) {
      const li = el("li");
      li.append(el("span", p, "pos"), text);
      if (viaWord) li.append(el("span", `${viaWord}: ${viaText}`, "via"));
      list.append(li);
    }
    body.append(list);
  } else if (!defs) body.append(el("p", "Loading definitions…", "hint"));

  const dist = selectedDistances!;
  const ones: number[] = [];
  const twos: number[] = [];
  dist.forEach((d, j) => (d === 1 ? ones.push(j) : d === 2 ? twos.push(j) : 0));
  const sorted = Array.from(dist).filter((d, j) => j !== i && d < 255).sort((a, b) => a - b);
  const old20 = sorted.slice(0, 20).reduce((a, b) => a + b, 0) / Math.min(20, sorted.length);
  const crowd = (state.view === "base" ? data.baseDensityVsLength : data.densityVsLength)[i];
  const ratio = Math.exp(Math.abs(crowd));
  const perMillion = 10 ** (data.zipf[i] - 3);
  const stats: [string, string][] = [
    ["Frequency", perMillion >= 1 ? `≈${fmt.format(Math.round(perMillion))} per million words` : `≈${perMillion.toFixed(2)} per million words`],
    ["One edit away", fmt.format(ones.length)],
    ["Two edits away", fmt.format(twos.length)],
    ["Average edits to nearest 20", old20.toFixed(2)],
    [
      "Crowding for its length",
      Math.abs(crowd) < 0.1
        ? `typical for ${data.length[i]} letters`
        : `${ratio.toFixed(1)}× ${crowd > 0 ? "more" : "fewer"} words within two edits than a typical ${data.length[i]}-letter word`,
    ],
  ];
  const dl = el("dl");
  for (const [k, v] of stats) dl.append(el("dt", k), el("dd", v));
  body.append(dl);
  const scope = state.view === "base" ? " (base forms)" : "";
  if (ones.length) body.append(el("h3", `One edit away${scope}`), wordChips(ones, 60, dist));
  if (twos.length) body.append(el("h3", `Two edits away${scope}`), wordChips(twos, 40, dist));
  if (!ones.length && !twos.length && sorted.length) {
    const closest = Array.from(dist.keys()).filter((j) => j !== i && dist[j] === sorted[0]);
    body.append(el("h3", `Nearest words, ${sorted[0]} edits away${scope}`), wordChips(closest, 30, dist));
  }
  $("details").hidden = false;
}

function showPlaced(p: Placed) {
  const body = $("details-body");
  body.replaceChildren(
    el("h2", `“${p.text}”`),
    el("p", `Not in this word list. The ring shows where it would sit: next to “${data.words[p.anchor]}”, the most central of its closest words.`, "sub"),
    el("h3", "Nearest words"),
    wordChips(
      p.near.map((x) => x.index),
      p.near.length,
      (() => {
        const d = new Uint8Array(data.meta.count);
        for (const x of p.near) d[x.index] = x.dist;
        return d;
      })(),
    ),
  );
  $("details").hidden = false;
}

function select(i: number) {
  if (!inView(i)) {
    setView("all"); // inflected forms only exist in the all-forms view
  }
  state.selected = i;
  state.placed = null;
  selectedDistances = distancesFrom(data.words[i], data.words, inView);
  showDetails(i);
  flyTo(position(i));
  render();
}

/** Where a string sits in the current layout. Averaging its nearest words' positions can land far
 * from all of them, because true neighbours are often scattered across the map; instead it sits
 * beside the most central of its closest words (least total on-map distance to the others). */
function placement(text: string): Placed | null {
  const near = nearest(text, data.words, inView, 8);
  if (!near.length) return null;
  const closest = near.filter((x) => x.dist === near[0].dist).map((x) => x.index);
  const spread = (i: number) =>
    closest.reduce((sum, j) => sum + Math.hypot(position(i)[0] - position(j)[0], position(i)[1] - position(j)[1]), 0);
  const anchor = closest.reduce((best, i) => (spread(i) < spread(best) ? i : best), closest[0]);
  return { text, position: position(anchor), near, anchor };
}

function placeString(raw: string) {
  const text = raw.trim().toLowerCase();
  const placed = text ? placement(text) : null;
  if (!placed) return;
  state.placed = placed;
  state.selected = null;
  selectedDistances = null;
  showPlaced(placed);
  flyTo(placed.position);
  render();
}

// ---------------------------------------------------------------------------------------------
// Search with suggestions

function setupSearch() {
  const input = $<HTMLInputElement>("search");
  const list = $<HTMLUListElement>("suggestions");
  let items: number[] = [];
  let active = -1;
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const paint = () => {
    list.replaceChildren();
    items.forEach((i, k) => {
      const li = el("li");
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(k === active));
      li.append(el("span", data.words[i]), el("span", `${data.meta.posClasses[data.pos[i]]} · #${fmt.format(i + 1)}`, "meta"));
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(i);
      });
      list.append(li);
    });
    list.hidden = items.length === 0;
    input.setAttribute("aria-expanded", String(!list.hidden));
  };
  const choose = (i: number) => {
    input.value = data.words[i];
    close();
    select(i);
  };
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    items = [];
    active = -1;
    if (q) {
      for (let i = 0; i < data.words.length && items.length < 8; i++) {
        if (data.words[i].startsWith(q)) items.push(i);
      }
    }
    paint();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = input.value.trim().toLowerCase();
      if (active >= 0) return choose(items[active]);
      const exact = data.index.get(q);
      close();
      if (exact !== undefined) select(exact);
      else placeString(q);
    } else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", close);
}

// ---------------------------------------------------------------------------------------------
// Controls

function setPressed(attr: string, value: string) {
  document.querySelectorAll<HTMLButtonElement>(`[data-${attr}]`).forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
  });
}

/** Switch view or layout without losing the reader's place: from the overview the camera reframes
 * the new layout; zoomed in, it follows the selected word, the placed string, or the word nearest
 * the middle of the screen to its new position while the points animate there. */
function changeLayout(update: () => void) {
  const vp = deck.getViewports()[0];
  let anchor: number | null = state.selected ?? state.placed?.anchor ?? null;
  if (anchor === null && vp) {
    const [cx, cy] = vp.unproject([vp.width / 2, vp.height / 2]);
    let best = Infinity;
    for (let i = 0; i < data.meta.count; i++) {
      if (!visible(i)) continue;
      const [x, y] = position(i);
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < best) [best, anchor] = [d, i];
    }
  }
  update();

  if (state.selected !== null) {
    if (inView(state.selected)) {
      selectedDistances = distancesFrom(data.words[state.selected], data.words, inView);
      showDetails(state.selected);
    } else {
      state.selected = null;
      selectedDistances = null;
      $("details").hidden = true;
    }
  }
  if (state.placed) {
    state.placed = placement(state.placed.text);
    if (state.placed) showPlaced(state.placed);
  }
  state.ladder = null;
  $("ladder-result").textContent = "";
  updateStatus();

  const atOverview = state.zoom < state.fullZoom + 0.6;
  const fit = fitView();
  state.fullZoom = fit.zoom as number;
  const follow = state.placed?.position ?? (anchor !== null && inView(anchor) ? position(anchor) : null);
  const next = atOverview || !follow ? fit : { target: [follow[0], follow[1], 0], zoom: state.zoom };
  deck.setProps({
    initialViewState: {
      ...next,
      transitionDuration: TRANSITION_MS,
      transitionInterpolator: new LinearInterpolator(["target", "zoom"]),
    } as OrthographicViewState,
  });
  state.zoom = next.zoom as number;
  state.transitioning = true;
  render();
  window.setTimeout(() => {
    state.transitioning = false;
    updateLabels();
  }, TRANSITION_MS + 50);
}

function setView(view: View) {
  if (state.view === view) return;
  changeLayout(() => {
    state.view = view;
    setPressed("view", view);
  });
}

function setupControls() {
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view as View)),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-layout]").forEach((b) =>
    b.addEventListener("click", () => {
      if (state.layout === b.dataset.layout) return;
      changeLayout(() => {
        state.layout = b.dataset.layout as Layout;
        setPressed("layout", state.layout);
      });
    }),
  );
  const colorBy = $<HTMLSelectElement>("color-by");
  colorBy.addEventListener("change", () => {
    state.colorBy = colorBy.value as ColorBy;
    renderLegend();
    render();
  });

  // Parts of speech: one checkbox per class, kept in sync with the legend's toggles.
  const posBox = $("pos-options");
  const counts = new Array(data.meta.posClasses.length).fill(0);
  data.pos.forEach((p) => counts[p]++);
  data.meta.posClasses.forEach((name, k) => {
    const label = el("label");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.dataset.pos = String(k);
    cb.addEventListener("change", () => {
      state.posOn[k] = cb.checked;
      onFilterChange();
    });
    label.append(cb, name, el("span", fmt.format(counts[k]), "count"));
    posBox.append(label);
  });
  const actions = el("div", undefined, "actions");
  for (const [text, on] of [["All", true], ["None", false]] as const) {
    const b = el("button", text);
    b.type = "button";
    b.addEventListener("click", () => {
      state.posOn = state.posOn.map(() => on);
      onFilterChange();
    });
    actions.append(b);
  }
  posBox.append(actions);

  const lenMin = $<HTMLInputElement>("len-min");
  const lenMax = $<HTMLInputElement>("len-max");
  lenMax.max = lenMin.max = String(data.meta.maxLength);
  lenMax.value = String(data.meta.maxLength);
  const onLength = () => {
    state.lenMin = Math.max(1, Number(lenMin.value) || 1);
    state.lenMax = Math.max(state.lenMin, Number(lenMax.value) || data.meta.maxLength);
    onFilterChange();
  };
  lenMin.addEventListener("input", onLength);
  lenMax.addEventListener("input", onLength);

  // "Most common N": a log-scaled slider from TOP_N_MIN to the whole list.
  const topN = $<HTMLInputElement>("top-n");
  const topNValue = $<HTMLOutputElement>("top-n-value");
  const n = data.meta.count;
  const toN = (v: number) => Math.round(TOP_N_MIN * (n / TOP_N_MIN) ** (v / 100));
  topN.addEventListener("input", () => {
    state.topN = Number(topN.value) >= 100 ? n : toN(Number(topN.value));
    topNValue.textContent = fmt.format(state.topN);
    onFilterChange();
  });

  $("details-close").addEventListener("click", () => {
    $("details").hidden = true;
    state.selected = null;
    state.placed = null;
    selectedDistances = null;
    render();
  });

  $("theme-toggle").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("wordmap-theme", state.theme);
    applyTheme();
  });
  const about = $<HTMLDialogElement>("about");
  $("about-open").addEventListener("click", () => about.showModal());
  $("about-generated").textContent = `Data built ${data.meta.generated}.`;

  const ladderPanel = $("ladder");
  const ladderToggle = $("ladder-toggle");
  ladderToggle.addEventListener("click", () => {
    ladderPanel.hidden = !ladderPanel.hidden;
    ladderToggle.setAttribute("aria-expanded", String(!ladderPanel.hidden));
    if (ladderPanel.hidden) {
      state.ladder = null;
      render();
    } else $<HTMLInputElement>("ladder-from").focus();
  });
  $("ladder-form").addEventListener("submit", (e) => {
    e.preventDefault();
    findLadder();
  });
}

function onFilterChange() {
  document.querySelectorAll<HTMLInputElement>("#pos-options input[data-pos]").forEach((cb) => {
    cb.checked = state.posOn[Number(cb.dataset.pos)];
  });
  updateStatus();
  renderLegend();
  render();
  scheduleLabels();
}

function updateStatus() {
  let shown = 0;
  for (let i = 0; i < data.meta.count; i++) if (visible(i)) shown++;
  const total = state.view === "base" ? data.meta.baseCount : data.meta.count;
  $("status").textContent =
    shown === total ? `${fmt.format(total)} words` : `${fmt.format(shown)} of ${fmt.format(total)} words shown`;
}

function findLadder() {
  const result = $("ladder-result");
  const from = $<HTMLInputElement>("ladder-from").value.trim().toLowerCase();
  const to = $<HTMLInputElement>("ladder-to").value.trim().toLowerCase();
  const a = data.index.get(from);
  const b = data.index.get(to);
  const missing = [from, to].filter((w, k) => !w || [a, b][k] === undefined || !visible([a, b][k]!));
  result.replaceChildren();
  if (missing.length) {
    result.textContent = `Not among the words shown: ${missing.map((w) => `“${w}”`).join(", ")}.`;
    return;
  }
  const path = wordLadder(a!, b!, data.words, data.index, visible);
  state.ladder = path;
  render();
  if (!path) {
    result.textContent = `No ladder: “${from}” and “${to}” aren't connected by one-edit steps among the words shown.`;
    return;
  }
  result.append(`${path.length - 1} step${path.length === 2 ? "" : "s"}: `);
  path.forEach((i, k) => {
    if (k) result.append(" → ");
    const s = el("button", data.words[i], "link step");
    s.addEventListener("click", () => select(i));
    result.append(s);
  });
  // Frame the whole ladder.
  const pts = path.map(position);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs) || 1;
  const h = Math.max(...ys) - Math.min(...ys) || 1;
  const mapEl = $("map");
  const zoom = Math.min(state.fullZoom + 6, Math.log2(Math.min(mapEl.clientWidth / (w * 1.6), mapEl.clientHeight / (h * 1.6))));
  deck.setProps({
    initialViewState: {
      target: [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, 0],
      zoom,
      transitionDuration: 700,
      transitionInterpolator: new LinearInterpolator(["target", "zoom"]),
    } as OrthographicViewState,
  });
  onZoom(zoom);
}

// ---------------------------------------------------------------------------------------------
// Legend

function renderLegend() {
  const box = $("legend");
  box.replaceChildren();
  const titles: Record<ColorBy, string> = {
    pos: "Part of speech",
    length: "Letters",
    frequency: "How common",
    crowding: "Crowding for its length",
  };
  box.append(el("div", titles[state.colorBy], "title"));
  const items = el("div", undefined, "items");
  if (state.colorBy === "pos" || state.colorBy === "length") {
    const colors = enc.swatch(state.colorBy);
    const entries =
      state.colorBy === "pos" ? POS_GROUPS.map((g) => g.label) : LENGTH_BUCKETS.map((b) => b.label);
    entries.forEach((label, k) => {
      const dot = el("span", undefined, "dot");
      dot.style.background = colors[k];
      if (state.colorBy === "pos") {
        // Toggle-to-isolate: each entry switches its part-of-speech classes on or off.
        const group = POS_GROUPS[k];
        const ids = group.classes.map((c) => data.meta.posClasses.indexOf(c)).filter((x) => x >= 0);
        const on = ids.some((x) => state.posOn[x]);
        const b = el("button", undefined, "item");
        b.type = "button";
        b.setAttribute("aria-pressed", String(on));
        b.title = group.note ? `${label}: ${group.note}. Click to show or hide.` : `Click to show or hide ${label.toLowerCase()}s`;
        b.append(dot, label);
        b.addEventListener("click", () => {
          ids.forEach((x) => (state.posOn[x] = !on));
          onFilterChange();
        });
        items.append(b);
      } else {
        const s = el("span", undefined, "item");
        s.append(dot, label);
        items.append(s);
      }
    });
    box.append(items);
    if (state.colorBy === "pos") box.append(el("div", "Other: adverbs, function words, interjections, numbers", "note"));
  } else {
    const bar = el("div", undefined, "bar");
    bar.style.background = enc.gradient(state.colorBy);
    const ends = el("div", undefined, "ends");
    if (state.colorBy === "frequency") {
      ends.append(el("span", `rarer (Zipf ≤ ${ZIPF_DOMAIN[0]})`), el("span", `common (≥ ${ZIPF_DOMAIN[1]})`));
    } else {
      ends.append(el("span", `sparser (÷${Math.exp(-CROWDING_DOMAIN[0]).toFixed(0)})`), el("span", "typical"), el("span", `crowded (×${Math.exp(CROWDING_DOMAIN[1]).toFixed(0)})`));
    }
    box.append(bar, ends);
    if (state.colorBy === "crowding") {
      box.append(el("div", "Words within two edits, compared with other words of the same length.", "note"));
    }
  }
}

// ---------------------------------------------------------------------------------------------

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  enc = encoders(state.theme);
  if (!deck) return; // before the data has loaded, only the page colours change
  renderLegend();
  render();
}

async function main() {
  applyTheme();
  data = await loadMapData();
  allPoints = { length: data.meta.count };
  state.posOn = data.meta.posClasses.map(() => true);
  state.topN = data.meta.count;
  state.lenMax = data.meta.maxLength;
  const initial = fitView();
  state.fullZoom = state.zoom = initial.zoom as number;
  deck = new Deck<OrthographicView>({
    parent: $("map"),
    views: new OrthographicView({ id: "map" }),
    initialViewState: initial,
    controller: { doubleClickZoom: true, scrollZoom: { smooth: false, speed: 0.01 } },
    pickingRadius: 8,
    onViewStateChange: ({ viewState }) => {
      onZoom((viewState as OrthographicViewState).zoom as number);
      return viewState;
    },
    onHover: showTooltip,
    onClick: (info) => {
      if (info.layer?.id === "points" && info.index >= 0) select(info.index);
    },
    getCursor: ({ isHovering, isDragging }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
    layers: [],
  });
  setupControls();
  setupSearch();
  renderLegend();
  updateStatus();
  render();
  $("loading").hidden = true;
  defs = await loadDefinitions();
  if (state.selected !== null) showDetails(state.selected);
}

main().catch((err) => {
  $("loading").textContent = `Could not load the map: ${err.message}`;
  console.error(err);
});

// Exposed for debugging from the console.
Object.assign(window, { wordmap: { state, levenshtein, get data() { return data; } } });
