# wordmap: English words laid out by edit distance.
set shell := ["bash", "-cu"]

default:
    @just --list

# Install Python (uv) and web (npm) dependencies.
setup:
    uv sync
    cd web && npm ci

# Download the raw sources (~3 GB, mostly the Wiktionary dump) and build the ESDB word database.
fetch:
    uv run python -m pipeline.fetch

# Pull English entries out of the Wiktionary dump (~2 minutes).
wiktionary:
    uv run python -m pipeline.wiktionary

# Choose the vocabulary and annotate it (POS, base forms, definitions).
vocab:
    uv run python -m pipeline.vocab

# Every data step, from downloads to the files the site loads.
pipeline: fetch wiktionary vocab

# Lint the pipeline.
lint:
    uv run ruff check pipeline
    uv run ruff format --check pipeline
