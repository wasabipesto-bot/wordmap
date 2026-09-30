"""Download (or build) every raw input. Idempotent: anything already present is skipped.

Sources:
  - SUBTLEX-US with part-of-speech (Brysbaert, New & Keuleers 2012), Ghent University. CC BY-SA.
  - Raw Wiktextract dump of English Wiktionary from kaikki.org (~3 GB). CC BY-SA 4.0 / GFDL.
  - English Speller Database (ESDB, formerly SCOWL v2), built locally from a pinned commit. MIT-like.
  - wordfreq ships its data inside the Python package, so there is nothing to fetch for it.
"""

import subprocess
import sys
import urllib.request

from .paths import ESDB_DB, ESDB_DIR, RAW, SUBTLEX_ZIP, WIKTIONARY_DUMP

SUBTLEX_URL = (
    "https://www.ugent.be/pp/experimentele-psychologie/en/research/documents/subtlexus/subtlexus1.zip"
)
WIKTIONARY_URL = "https://kaikki.org/dictionary/raw-wiktextract-data.jsonl.gz"
ESDB_REPO = "https://github.com/en-wl/wordlist.git"
ESDB_COMMIT = "1e5b7d3a72f47a71da5d28686c1dd4b397178485"  # v2 branch, 2026-06-24


def download(url: str, dest) -> None:
    if dest.exists():
        print(f"skip {dest.name}: already downloaded")
        return
    print(f"downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as out:
        last_modified = resp.headers.get("Last-Modified", "unknown")
        while chunk := resp.read(1 << 22):
            out.write(chunk)
    tmp.rename(dest)
    dest.with_suffix(dest.suffix + ".last-modified").write_text(last_modified + "\n")
    print(f"  -> {dest} ({dest.stat().st_size / 1e6:.0f} MB, Last-Modified: {last_modified})")


def build_esdb() -> None:
    if ESDB_DB.exists():
        print("skip ESDB: scowl.db already built")
        return
    ESDB_DIR.mkdir(parents=True, exist_ok=True)
    for cmd in (
        ["git", "init", "-q"],
        ["git", "fetch", "-q", "--depth", "1", ESDB_REPO, ESDB_COMMIT],
        ["git", "checkout", "-q", "FETCH_HEAD"],
        ["make"],  # builds scowl.db from the source text files, about 2 minutes
    ):
        subprocess.run(cmd, cwd=ESDB_DIR, check=True)


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    download(SUBTLEX_URL, SUBTLEX_ZIP)
    download(WIKTIONARY_URL, WIKTIONARY_DUMP)
    build_esdb()


if __name__ == "__main__":
    sys.exit(main())
