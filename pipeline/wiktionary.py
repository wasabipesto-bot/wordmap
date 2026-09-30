"""Stream the kaikki.org raw Wiktextract dump and keep only English entries with plain-letter titles.

The dump is ~24 GB uncompressed and covers every language, so this runs once and writes a
compact JSONL (one line per word/POS entry) that later steps read in a few seconds. Titles with
capitals, spaces, hyphens or apostrophes are kept too: they are the targets of glosses such as
"Alternative spelling of OK" or "Alternative form of all right", which the vocab step resolves.
"""

import re
import shutil
import subprocess
import time

import orjson

from .paths import INTERIM, WIKTIONARY_DUMP, WIKTIONARY_EN

WORD_RE = re.compile(rb'"word": "[A-Za-z][A-Za-z \'-]{0,40}"')
TITLE_RE = re.compile(r"[A-Za-z][A-Za-z '-]{0,40}")
KEEP_SENSE_KEYS = ("glosses", "tags")


def slim_sense(sense: dict) -> dict:
    out = {k: sense[k] for k in KEEP_SENSE_KEYS if sense.get(k)}
    for key in ("form_of", "alt_of"):
        if sense.get(key):
            out[key] = [x["word"] for x in sense[key] if "word" in x]
    return out


def main() -> None:
    INTERIM.mkdir(parents=True, exist_ok=True)
    # Decompress in a separate process so it overlaps with JSON parsing here.
    unzip = shutil.which("pigz") or "gzip"
    proc = subprocess.Popen([unzip, "-dc", str(WIKTIONARY_DUMP)], stdout=subprocess.PIPE, bufsize=1 << 24)
    t0, seen, kept = time.time(), 0, 0
    tmp = WIKTIONARY_EN.with_suffix(".tmp")
    with open(tmp, "wb") as out:
        for line in proc.stdout:
            seen += 1
            # Cheap byte-level checks before paying for a full parse.
            if b'"lang_code": "en"' not in line or not WORD_RE.search(line):
                continue
            entry = orjson.loads(line)
            word = entry.get("word", "")
            if entry.get("lang_code") != "en" or not TITLE_RE.fullmatch(word):
                continue
            senses = [slim_sense(s) for s in entry.get("senses", [])]
            out.write(orjson.dumps({"word": word, "pos": entry.get("pos"), "senses": senses}) + b"\n")
            kept += 1
            if kept % 200_000 == 0:
                print(f"  {seen:,} lines read, {kept:,} kept, {time.time() - t0:.0f}s", flush=True)
    if proc.wait() != 0:
        raise SystemExit(f"{unzip} exited with {proc.returncode}")
    tmp.rename(WIKTIONARY_EN)
    print(
        f"wiktionary: kept {kept:,} English entries of {seen:,} in {time.time() - t0:.0f}s -> {WIKTIONARY_EN}"
    )


if __name__ == "__main__":
    main()
