"""Write the files the static site loads (web/public/data).

meta.json    counts, category names, column directory, layout list, sources
words.txt    the vocabulary, one word per line, most frequent first (index = word id)
columns.bin  numeric columns and layout coordinates, 4-byte aligned, little-endian
defs.json    per word: [lemma or 0, [pos, text, via word?, via text?], ...]; loaded after first paint
ESDB-COPYRIGHT.txt  the English Speller Database's notice, which must accompany data derived from it
"""

import datetime
import json
import shutil

import numpy as np
import orjson
import pandas as pd

from .paths import ESDB_DIR, LAYOUTS, NEIGHBORS, SITE_DATA, VOCAB
from .vocab import POS_CLASSES

DEF_MAX_CHARS = 240


def clip(text: str) -> str:
    return text if len(text) <= DEF_MAX_CHARS else text[: DEF_MAX_CHARS - 1].rstrip() + "…"


def main() -> None:
    vocab = pd.read_parquet(VOCAB)
    nb = np.load(NEIGHBORS)
    lay = np.load(LAYOUTS)
    n = len(vocab)
    base_ids = lay["base_ids"]
    is_base = np.zeros(n, np.uint8)
    is_base[base_ids] = 1

    def full(values: np.ndarray, fill: np.ndarray) -> np.ndarray:
        """Spread base-only values over all words; non-base words take `fill` (they are hidden in
        base-form views, and reusing their all-forms position keeps transitions free of NaNs)."""
        out = fill.copy()
        out[base_ids] = values
        return out

    base_density = np.full(n, np.nan, np.float32)
    base_density[base_ids] = nb["base_density_vs_length"]
    columns = {
        "pos": vocab["pos"].map(POS_CLASSES.index).to_numpy(np.uint8),
        "length": vocab["length"].to_numpy(np.uint8),
        "is_base": is_base,
        "zipf": vocab["zipf"].to_numpy(np.float32),
        "n1": np.minimum(nb["n1"], 65535).astype(np.uint16),
        "n2": np.minimum(nb["n2"], 65535).astype(np.uint16),
        "old20": nb["old20"].astype(np.float32),
        "density_vs_length": nb["density_vs_length"].astype(np.float32),
        "base_density_vs_length": base_density,
        "umap": lay["umap"].astype(np.float32).ravel(),
        "densmap": lay["densmap"].astype(np.float32).ravel(),
        "base_umap": full(lay["base_umap"], lay["umap"]).astype(np.float32).ravel(),
        "base_densmap": full(lay["base_densmap"], lay["densmap"]).astype(np.float32).ravel(),
    }
    SITE_DATA.mkdir(parents=True, exist_ok=True)
    directory, offset = [], 0
    with open(SITE_DATA / "columns.bin", "wb") as f:
        for name, arr in columns.items():
            raw = arr.astype(arr.dtype.newbyteorder("<")).tobytes()
            directory.append({"name": name, "dtype": arr.dtype.name, "offset": offset, "length": arr.size})
            pad = (-len(raw)) % 4
            f.write(raw + b"\0" * pad)
            offset += len(raw) + pad

    (SITE_DATA / "words.txt").write_text("\n".join(vocab["word"]) + "\n")

    defs = []
    for lemma, d in zip(vocab["lemma"], vocab["defs"]):
        entry = [lemma if isinstance(lemma, str) else 0]
        for x in orjson.loads(d):
            item = [x["pos"], clip(x["text"])]
            if x.get("via"):
                item += [x["via"]["word"], clip(x["via"]["text"])]
            entry.append(item)
        defs.append(entry)
    (SITE_DATA / "defs.json").write_bytes(orjson.dumps(defs))

    def extent(flat: np.ndarray) -> list[float]:
        xy = flat.reshape(-1, 2)
        return [float(v) for v in (*xy.min(0), *xy.max(0))]

    meta = {
        "generated": datetime.datetime.now(datetime.UTC).date().isoformat(),
        "count": n,
        "baseCount": int(is_base.sum()),
        "posClasses": POS_CLASSES,
        "columns": directory,
        "layouts": {
            name: {"column": name, "bounds": extent(columns[name])}
            for name in ("umap", "densmap", "base_umap", "base_densmap")
        },
        "zipfRange": [float(vocab["zipf"].min()), float(vocab["zipf"].max())],
        "maxLength": int(vocab["length"].max()),
    }
    (SITE_DATA / "meta.json").write_text(json.dumps(meta, indent=1))
    # ESDB's licence asks for its full copyright notice to travel with data derived from it.
    shutil.copy(ESDB_DIR / "Copyright", SITE_DATA / "ESDB-COPYRIGHT.txt")
    sizes = {p.name: p.stat().st_size for p in SITE_DATA.iterdir()}
    print("export:", ", ".join(f"{k} {v / 1e6:.1f} MB" for k, v in sorted(sizes.items())))


if __name__ == "__main__":
    main()
