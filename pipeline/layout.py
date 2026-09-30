"""2-D layouts from the neighbour graphs: UMAP (the default view) and densMAP, for all word forms
and for base forms only. Every layout is rotated/scaled onto the all-forms UMAP so that switching
views animates points to nearby places instead of spinning the whole map.
"""

import time

import numpy as np
import umap

from .paths import LAYOUTS, NEIGHBORS

N_NEIGHBORS = 15
MIN_DIST = 0.1
SEED = 42
EXTENT = 1000.0  # the all-forms UMAP is scaled to roughly [-EXTENT, EXTENT]


def embed(idx: np.ndarray, dist: np.ndarray, densmap: bool) -> np.ndarray:
    t0 = time.time()
    model = umap.UMAP(
        n_neighbors=N_NEIGHBORS,
        min_dist=MIN_DIST,
        precomputed_knn=(idx[:, :N_NEIGHBORS].astype(np.int64), dist[:, :N_NEIGHBORS].astype(np.float32)),
        metric="precomputed",  # distances come from the neighbour lists; X below is a placeholder
        densmap=densmap,
        random_state=SEED,
    )
    y = model.fit_transform(np.zeros((len(idx), 1), np.float32))
    print(f"  {'densMAP' if densmap else 'UMAP'} on {len(idx):,} words in {time.time() - t0:.0f}s")
    return y


def align(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Similarity Procrustes: the rotation/reflection, uniform scale and shift of `source` that
    best matches `target` (same points, same order)."""
    mu_s, mu_t = source.mean(0), target.mean(0)
    s, t = source - mu_s, target - mu_t
    u, sigma, vt = np.linalg.svd(s.T @ t)
    rotation = u @ vt
    scale = sigma.sum() / (s**2).sum()
    return scale * s @ rotation + mu_t


def main() -> None:
    nb = np.load(NEIGHBORS)
    base_ids = nb["base_ids"]
    print(f"layout: {len(nb['idx']):,} words, {len(base_ids):,} base forms")
    umap_all = embed(nb["idx"], nb["dist"], densmap=False)
    # Centre and scale the reference layout; percentiles keep a few far-flung islands from
    # shrinking everything else.
    lo, hi = np.percentile(umap_all, [0.5, 99.5], axis=0)
    umap_all = (umap_all - (lo + hi) / 2) * (2 * EXTENT / (hi - lo).max())
    layouts = {"umap": umap_all}
    layouts["densmap"] = align(embed(nb["idx"], nb["dist"], densmap=True), umap_all)
    ref_base = umap_all[base_ids]
    layouts["base_umap"] = align(embed(nb["base_idx"], nb["base_dist"], densmap=False), ref_base)
    layouts["base_densmap"] = align(embed(nb["base_idx"], nb["base_dist"], densmap=True), ref_base)
    np.savez_compressed(LAYOUTS, base_ids=base_ids, **{k: v.astype(np.float32) for k, v in layouts.items()})
    print(f"  -> {LAYOUTS}")


if __name__ == "__main__":
    main()
