# wordmap: English words laid out by edit distance.
set shell := ["bash", "-cu"]

default:
    @just --list

# Install Python (uv) and web (npm) dependencies.
setup:
    uv sync
    cd web && npm ci

# Serve the site locally with live reload.
dev:
    cd web && npx vite --host 127.0.0.1

# Build the static site into web/dist.
build:
    cd web && npm run build

# Serve the built site from web/dist.
preview: build
    cd web && npx vite preview --host 127.0.0.1

# Every data step, from downloads to the files the site loads (~10 minutes on 4 cores, plus downloads).
pipeline: fetch wiktionary vocab neighbors layout export

# Download the raw sources (~3 GB, mostly the Wiktionary dump) and build the ESDB word database.
fetch:
    uv run python -m pipeline.fetch

# Pull English entries out of the Wiktionary dump (~2 minutes).
wiktionary:
    uv run python -m pipeline.wiktionary

# Choose the vocabulary and annotate it (part of speech, base forms, definitions).
vocab:
    uv run python -m pipeline.vocab

# Exact all-pairs Levenshtein neighbours and neighbourhood statistics.
neighbors:
    uv run python -m pipeline.neighbors

# UMAP and densMAP layouts for all forms and base forms.
layout:
    uv run python -m pipeline.layout

# Write the site's data files to web/public/data.
export:
    uv run python -m pipeline.export

# Compare neighbour tie-break rules (see README); takes ~5 minutes.
experiment-ties:
    uv run python -m pipeline.experiments.ties

# Lint and type-check.
check:
    uv run ruff check pipeline
    uv run ruff format --check pipeline
    cd web && npx tsc --noEmit
