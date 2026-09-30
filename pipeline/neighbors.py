"""Exact nearest neighbours under Levenshtein distance, plus per-word neighbourhood statistics.

Every pair of words is compared (rapidfuzz, all cores), so the neighbour lists are exact rather
than approximate. Levenshtein distances are small integers, which means most words have many
neighbours tied at the cutoff distance ("cat" has 31 words one edit away); `TIE_BREAK` decides
which of the tied words make the list. See pipeline/experiments/ties.py for how the default was
chosen.
"""

import time

import numpy as np
import pandas as pd
from rapidfuzz import process
from rapidfuzz.distance import Levenshtein

from .paths import NEIGHBORS, VOCAB

K = 64  # neighbours kept per word; layouts use the first N_NEIGHBORS of these
CHUNK = 1000
TIE_BREAK = "frequency"


def tie_keys(n: int, strategy: str, seed: int = 0) -> np.ndarray:
    """A secondary sort key per candidate neighbour, in [0, 1). Words arrive sorted by frequency,
    so index order prefers frequent neighbours; "random" is a fixed random permutation."""
    if strategy == "frequency":
        return np.arange(n) / n
    if strategy == "random":
        return np.random.default_rng(seed).permutation(n) / n
    raise ValueError(strategy)


def knn(words: list[str], strategies: dict[str, np.ndarray], k: int = K) -> dict:
    """All-pairs Levenshtein. Returns neighbour indices/distances for each tie-break strategy
    (self first, as UMAP expects) and tie-independent statistics."""
    n = len(words)
    lengths = np.array([len(w) for w in words])
    out = {name: (np.empty((n, k), np.int32), np.empty((n, k), np.uint8)) for name in strategies}
    n1, n2 = np.empty(n, np.int32), np.empty(n, np.int32)
    old20 = np.empty(n, np.float32)
    t0 = time.time()
    for s in range(0, n, CHUNK):
        d = process.cdist(
            words[s : s + CHUNK], words, scorer=Levenshtein.distance, dtype=np.uint8, workers=-1
        )
        rows = np.arange(d.shape[0])
        n1[s : s + CHUNK] = (d == 1).sum(1)
        n2[s : s + CHUNK] = (d <= 2).sum(1) - 1  # minus self
        # OLD20 (Yarkoni, Balota & Yap 2008): mean distance to the 20 closest other words.
        d_self_far = d.copy()
        d_self_far[rows, s + rows] = 255
        old20[s : s + CHUNK] = np.sort(np.partition(d_self_far, 20, axis=1)[:, :20], axis=1).mean(1)
        for name, tie in strategies.items():
            key = d.astype(np.float32) + tie[None, :].astype(np.float32)
            key[rows, s + rows] = -1  # self first
            part = np.argpartition(key, k, axis=1)[:, :k]
            top = np.take_along_axis(part, np.take_along_axis(key, part, 1).argsort(1), 1)
            out[name][0][s : s + CHUNK] = top
            out[name][1][s : s + CHUNK] = np.take_along_axis(d, top, 1)
    print(f"  all-pairs Levenshtein for {n:,} words in {time.time() - t0:.0f}s")
    # Crowding relative to length: how many words lie within two edits, compared with the typical
    # word of the same length (log scale, median-centred per length).
    dens = np.log1p(n2).astype(np.float32)
    density_vs_length = np.empty_like(dens)
    for length in np.unique(lengths):
        m = lengths == length
        density_vs_length[m] = dens[m] - np.median(dens[m])
    return {"knn": out, "n1": n1, "n2": n2, "old20": old20, "density_vs_length": density_vs_length}


def main() -> None:
    vocab = pd.read_parquet(VOCAB)
    words = vocab["word"].tolist()
    base_idx = np.flatnonzero(vocab["is_base"].to_numpy())
    print(f"neighbors: {len(words):,} words (all forms), {len(base_idx):,} base forms")
    full = knn(words, {TIE_BREAK: tie_keys(len(words), TIE_BREAK)})
    base_words = [words[i] for i in base_idx]
    base = knn(base_words, {TIE_BREAK: tie_keys(len(base_words), TIE_BREAK)})
    np.savez_compressed(
        NEIGHBORS,
        idx=full["knn"][TIE_BREAK][0],
        dist=full["knn"][TIE_BREAK][1],
        base_ids=base_idx.astype(np.int32),
        base_idx=base["knn"][TIE_BREAK][0],  # indices into base_ids
        base_dist=base["knn"][TIE_BREAK][1],
        n1=full["n1"],
        n2=full["n2"],
        old20=full["old20"],
        density_vs_length=full["density_vs_length"],
        base_density_vs_length=base["density_vs_length"],
    )
    hermits = (full["n1"] == 0).mean()
    print(f"  words with no neighbour one edit away: {hermits:.1%} -> {NEIGHBORS}")


if __name__ == "__main__":
    main()
