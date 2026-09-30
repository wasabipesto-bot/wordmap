// Edit-distance work done in the browser: distances from one word to every word, where an
// arbitrary string would sit, and word ladders.

let rowA = new Int32Array(64);
let rowB = new Int32Array(64);

/** Levenshtein distance between a and b; returns max + 1 as soon as it must exceed `max`. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (la === 0 || lb === 0) return Math.max(la, lb);
  if (rowA.length <= lb) {
    rowA = new Int32Array(lb + 1);
    rowB = new Int32Array(lb + 1);
  }
  let prev = rowA;
  let curr = rowB;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const ins = curr[j - 1] + 1;
      const del = prev[j] + 1;
      const v = sub < ins ? (sub < del ? sub : del) : ins < del ? ins : del;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = curr;
    curr = t;
  }
  return prev[lb];
}

export interface Near {
  index: number;
  dist: number;
}

/** Distance from `query` to every included word (255 for excluded words). */
export function distancesFrom(query: string, words: string[], include: (i: number) => boolean): Uint8Array {
  const out = new Uint8Array(words.length).fill(255);
  for (let i = 0; i < words.length; i++) {
    if (include(i)) out[i] = Math.min(254, levenshtein(query, words[i]));
  }
  return out;
}

/** The k nearest included words to `query`, nearest first; ties go to the more frequent word. */
export function nearest(query: string, words: string[], include: (i: number) => boolean, k: number): Near[] {
  const best: Near[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!include(i)) continue;
    const bound = best.length < k ? Infinity : best[best.length - 1].dist - 1;
    const d = levenshtein(query, words[i], bound);
    if (d > bound) continue;
    // words arrive most-frequent first, so inserting after equal distances keeps that order
    let at = best.length;
    while (at > 0 && best[at - 1].dist > d) at--;
    best.splice(at, 0, { index: i, dist: d });
    if (best.length > k) best.pop();
  }
  return best;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

function oneEditAway(word: string, index: Map<string, number>, include: (i: number) => boolean): number[] {
  const out = new Set<number>();
  const add = (w: string) => {
    const i = index.get(w);
    if (i !== undefined && include(i)) out.add(i);
  };
  for (let p = 0; p <= word.length; p++) {
    const head = word.slice(0, p);
    const tail = word.slice(p);
    if (p < word.length) add(head + tail.slice(1)); // deletion
    for (const ch of ALPHABET) {
      add(head + ch + tail); // insertion
      if (p < word.length && ch !== word[p]) add(head + ch + tail.slice(1)); // substitution
    }
  }
  return [...out];
}

/** Shortest chain of one-edit steps between two words (bidirectional breadth-first search). */
export function wordLadder(
  from: number,
  to: number,
  words: string[],
  index: Map<string, number>,
  include: (i: number) => boolean,
): number[] | null {
  if (from === to) return [from];
  const parents = [new Map<number, number>([[from, -1]]), new Map<number, number>([[to, -1]])];
  let frontiers = [[from], [to]];
  const path = (meet: number) => {
    const left: number[] = [];
    for (let i: number = meet; i !== -1; i = parents[0].get(i)!) left.unshift(i);
    for (let i = parents[1].get(meet)!; i !== -1; i = parents[1].get(i)!) left.push(i);
    return left;
  };
  while (frontiers[0].length && frontiers[1].length) {
    const side = frontiers[0].length <= frontiers[1].length ? 0 : 1;
    const next: number[] = [];
    for (const node of frontiers[side]) {
      for (const nb of oneEditAway(words[node], index, include)) {
        if (parents[side].has(nb)) continue;
        parents[side].set(nb, node);
        if (parents[1 - side].has(nb)) return path(nb);
        next.push(nb);
      }
    }
    frontiers[side] = next;
  }
  return null;
}
