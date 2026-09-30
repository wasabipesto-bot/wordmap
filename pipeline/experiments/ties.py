"""Does the tie-break rule matter? Compares neighbour-list tie-breaks on the real vocabulary.

Most words have more candidates tied at their 15th-neighbour distance than there are slots, so
the rule that picks among ties shapes the graph UMAP sees. For each rule this reports:
  - local precision: share of a word's 15 nearest on-screen neighbours whose edit distance is no
    more than its true 15th-neighbour distance (tie-aware);
  - global Spearman correlation between on-screen and edit distance over random pairs;
  - hubness: the largest number of lists any one word appears in;
  - stability: share of 2-D neighbours two layouts have in common (same rule with a different
    UMAP seed, or two different random tie-breaks).
"""

import time

import numpy as np
import pandas as pd
import umap
from rapidfuzz.distance import Levenshtein
from scipy.stats import spearmanr
from sklearn.neighbors import NearestNeighbors

from ..neighbors import knn, tie_keys
from ..paths import VOCAB

N_NEIGHBORS = 15


def layout(idx, dist, seed):
    knn_ = (idx[:, :N_NEIGHBORS].astype(np.int64), dist[:, :N_NEIGHBORS].astype(np.float32))
    m = umap.UMAP(n_neighbors=N_NEIGHBORS, precomputed_knn=knn_,
                  metric="precomputed", random_state=seed)  # fmt: skip
    return m.fit_transform(np.zeros((len(idx), 1), np.float32))


def nn2d(y, k=N_NEIGHBORS):
    return NearestNeighbors(n_neighbors=k + 1).fit(y).kneighbors(y)[1][:, 1:]


def main() -> None:
    words = pd.read_parquet(VOCAB)["word"].tolist()
    n = len(words)
    graphs = knn(words, {"frequency": tie_keys(n, "frequency"), "random-0": tie_keys(n, "random", 0),
                         "random-1": tie_keys(n, "random", 1)})["knn"]  # fmt: skip
    cutoff = graphs["frequency"][1][:, N_NEIGHBORS].astype(int)  # true 15th-neighbour distance
    rng = np.random.default_rng(0)
    a, b = rng.integers(0, n, 100_000), rng.integers(0, n, 100_000)
    ed = np.array([Levenshtein.distance(words[i], words[j]) for i, j in zip(a, b)])

    runs = [("frequency", 0), ("frequency", 1), ("random-0", 0), ("random-1", 0)]
    layouts, neighbours = {}, {}
    print("| tie-break | UMAP seed | local precision@15 | global Spearman | max in-degree |")
    print("|---|---|---|---|---|")
    for name, seed in runs:
        t0 = time.time()
        idx, dist = graphs[name]
        y = layout(idx, dist, seed)
        nb = nn2d(y)
        d2 = np.array([[Levenshtein.distance(words[i], words[j]) for j in nb[i]] for i in range(n)])
        precision = (d2 <= cutoff[:, None]).mean()
        rho = spearmanr(np.linalg.norm(y[a] - y[b], axis=1), ed)[0]
        indeg = np.bincount(idx[:, 1 : N_NEIGHBORS + 1].ravel(), minlength=n).max()
        layouts[(name, seed)], neighbours[(name, seed)] = y, nb
        print(
            f"| {name} | {seed} | {precision:.1%} | {rho:.2f} | {indeg} |  <!-- {time.time() - t0:.0f}s -->"
        )

    def overlap(p, q):
        return np.mean([len(set(x) & set(y)) / N_NEIGHBORS for x, y in zip(neighbours[p], neighbours[q])])

    print()
    print(f"2-D neighbour overlap, frequency tie-break, UMAP seed 0 vs 1: {overlap(runs[0], runs[1]):.1%}")
    print(f"2-D neighbour overlap, random tie-break seed 0 vs 1:          {overlap(runs[2], runs[3]):.1%}")
    print(f"2-D neighbour overlap, frequency vs random tie-break:        {overlap(runs[0], runs[2]):.1%}")


if __name__ == "__main__":
    main()
