"""Filesystem layout shared by every pipeline step."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"  # downloaded sources, never modified
INTERIM = DATA / "interim"  # outputs of one step that feed the next
SITE_DATA = ROOT / "web" / "public" / "data"  # what the static site loads

WIKTIONARY_DUMP = RAW / "raw-wiktextract-data.jsonl.gz"
WIKTIONARY_EN = INTERIM / "wiktionary_en.jsonl"
ESDB_DIR = RAW / "esdb"
ESDB_DB = ESDB_DIR / "scowl.db"
SUBTLEX_ZIP = RAW / "subtlexus1.zip"
SUBTLEX_XLSX_NAME = "SUBTLEX-US frequency list with PoS and Zipf information.xlsx"

VOCAB = INTERIM / "vocab.parquet"
NEIGHBORS = INTERIM / "neighbors.npz"
LAYOUTS = INTERIM / "layouts.npz"
