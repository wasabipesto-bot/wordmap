"""Choose the vocabulary and annotate it: frequency, part of speech, base form, lemma, definitions.

Selection, in order:
  1. wordfreq's English list, ranked by frequency, keeping plain a-z tokens.
  2. ESDB (the spell-checker database behind SCOWL) at size <= 70, which drops typos, abbreviations,
     rare variant spellings, programmer slang and Roman numerals. Words ESDB tags as offensive
     (ethnic slurs) are dropped; ordinary profanity is kept.
  3. Proper names. wordfreq lowercases everything, so "mark" counts Mark too. SUBTLEX-US tags each
     occurrence with a part of speech, so a word's frequency is scaled by its non-name share, and
     words used almost only as names (under 2 non-name uses per million) are dropped.
  4. Single letters other than "a" and "i", and words whose main Wiktionary sense is an
     abbreviation or symbol ("cd", "mg").
  5. Words with no English Wiktionary entry.
The N_WORDS most frequent survivors (by non-name frequency) form the vocabulary.
"""

import collections
import io
import re
import sqlite3
import zipfile

import numpy as np
import orjson
import pandas as pd
import wordfreq

from .paths import ESDB_DB, INTERIM, SUBTLEX_XLSX_NAME, SUBTLEX_ZIP, VOCAB, WIKTIONARY_EN

N_WORDS = 50_000
ESDB_MAX_SIZE = 70  # "large": words found in most dictionaries
ESDB_SPELLINGS = ("_", "A", "B", "Z")  # shared, American, British (-ise and -ize)
ESDB_MAX_LEGACY_VARIANT = 1  # excludes archaic, uncommon and "acceptable" variant spellings
ESDB_DROP_POS = {"abbr", "pre", "suf", "wp", "we", "wes", "wep", "weps", "x", "?"}
ESDB_DROP_CATEGORIES = {"hacker", "roman-numerals"}

# Display classes. Function words are merged because each is tiny and they behave alike on the map.
POS_CLASSES = ["noun", "verb", "adjective", "adverb", "function", "interjection", "other"]
SUBTLEX_TO_CLASS = {
    "Noun": "noun", "Verb": "verb", "Adjective": "adjective", "Adverb": "adverb",
    "Pronoun": "function", "Preposition": "function", "Conjunction": "function",
    "Determiner": "function", "Article": "function", "To": "function", "Ex": "function", "Not": "function",
    "Interjection": "interjection", "Number": "other", "Letter": "other", "Unclassified": "other",
    "Name": "name",
}  # fmt: skip
WIKT_TO_CLASS = {
    "noun": "noun", "verb": "verb", "adj": "adjective", "adv": "adverb",
    "pron": "function", "prep": "function", "conj": "function", "det": "function",
    "article": "function", "particle": "function", "postp": "function",
    "intj": "interjection", "num": "other", "contraction": "other", "name": "name",
}  # fmt: skip
ESDB_BASE_TO_CLASSES = {
    "n": {"noun"}, "v": {"verb"}, "m": {"noun", "verb"}, "n_v": {"noun", "verb"},
    "aj": {"adjective"}, "av": {"adverb"}, "a": {"adjective", "adverb"}, "aj_av": {"adjective", "adverb"},
    "pn": {"function"}, "c": {"function"}, "pp": {"function"}, "d": {"function"},
    "i": {"interjection"}, "s": {"other"},
}  # fmt: skip
# ESDB form codes for inflections (plural, past tense, comparative, objective pronoun, ...).
INFLECTED_FORMS = {
    "ns", "np", "nsp", "nss", "nssp", "ms", "vd", "vds", "vg", "vn", "vs", "vs2", "vs3", "vss",
    "aj1", "aj2", "av1", "av2", "a1", "a2", "d1", "d2", "ds", "pn1", "pnd", "pnp", "pnr0", "pnrs", "pns",
}  # fmt: skip
# Senses we would rather not show as "the" definition when a better one exists.
WEAK_SENSE_TAGS = {
    "obsolete", "archaic", "dated", "historical", "rare", "dialectal", "nonstandard", "misspelling",
    "Early", "Middle", "uncommon", "obsolete-form", "pronunciation-spelling",
}  # fmt: skip
ABBREVIATION_TAGS = {"abbreviation", "initialism", "acronym", "symbol"}
ABBREVIATION_GLOSS = re.compile(r"^(Abbreviation|Initialism|Acronym|Symbol) (of|for) ")
SUBTLEX_MILLIONS = 51.0  # corpus size, for per-million rates
MIN_COMMON_PER_MILLION = 2.0  # below this, a mostly-name word counts as a name
MAX_DEFS = 3
AZ = re.compile(r"[a-z]+")


def load_candidates() -> pd.DataFrame:
    freqs = wordfreq.get_frequency_dict("en")
    rows = [(w, f) for w, f in freqs.items() if AZ.fullmatch(w)]
    df = pd.DataFrame(rows, columns=["word", "freq"]).sort_values("freq", ascending=False, kind="stable")
    df["zipf"] = np.log10(df["freq"] * 1e9)
    return df.reset_index(drop=True)


def load_esdb(words: set[str]) -> dict[str, list[tuple]]:
    """Qualifying ESDB rows per word: (form code, base POS, lemma, usage note)."""
    con = sqlite3.connect(ESDB_DB)
    q = """
        select m.word, m.pos, m.base_pos, e.lemma, m.usage_note, m.category, m.pos_category
        from _scowl_main m join entries e using (word_id)
        where m.size <= ? and m.legacy_level <= ?
          and m.spelling in ({})
    """.format(",".join("?" * len(ESDB_SPELLINGS)))
    out = collections.defaultdict(list)
    for word, pos, base_pos, lemma, note, category, pos_cat in con.execute(
        q, (ESDB_MAX_SIZE, ESDB_MAX_LEGACY_VARIANT, *ESDB_SPELLINGS)
    ):
        if word not in words or pos in ESDB_DROP_POS or category in ESDB_DROP_CATEGORIES:
            continue
        if pos_cat in ("nonword", "wordpart"):
            continue
        out[word].append((pos, base_pos, lemma, note or ""))
    return out


def load_subtlex() -> pd.DataFrame:
    with zipfile.ZipFile(SUBTLEX_ZIP) as z:
        df = pd.read_excel(io.BytesIO(z.read(SUBTLEX_XLSX_NAME)), engine="openpyxl")
    df["word"] = df["Word"].astype(str).str.lower()
    df = df.drop_duplicates("word").set_index("word")

    def pos_counts(row) -> tuple[str | None, int, int]:
        """(most frequent tag other than Name, occurrences tagged Name, occurrences tagged at all).
        All_PoS_SUBTLEX lists tags most-frequent first, with counts in the parallel All_freqs field."""
        if pd.isna(row["All_PoS_SUBTLEX"]) or pd.isna(row["All_freqs_SUBTLEX"]):
            return None, 0, 0
        poses = str(row["All_PoS_SUBTLEX"]).split(".")
        counts = [int(x) for x in str(row["All_freqs_SUBTLEX"]).split(".") if x]
        dom_common = next((p for p in poses if p != "Name"), None)
        return dom_common, dict(zip(poses, counts)).get("Name", 0), sum(counts)

    df[["dom_common", "name_count", "pos_total"]] = [pos_counts(r) for _, r in df.iterrows()]
    return df[["dom_common", "name_count", "pos_total"]]


def load_wiktionary(words: set[str]) -> dict[str, list[dict]]:
    """Entries whose title is exactly one of `words` (the extract is case-sensitive)."""
    out = collections.defaultdict(list)
    with open(WIKTIONARY_EN, "rb") as f:
        for line in f:
            entry = orjson.loads(line)
            if entry["word"] in words:
                out[entry["word"]].append(entry)
    return out


def gloss_text(sense: dict) -> str:
    """Wiktextract gives the sense hierarchy parent-first; the leaf is the specific definition,
    unless it is a continuation ("...because it was mentioned") of its parent."""
    glosses = sense.get("glosses") or []
    if not glosses:
        return ""
    leaf = glosses[-1]
    if leaf.startswith("...") and len(glosses) > 1:
        leaf = glosses[-2]
    return leaf.strip()


def pick_sense(entries: list[dict], prefer_form_of: bool) -> tuple[str, dict] | None:
    """First usable sense across entries, preferring senses without weak tags."""
    candidates = []
    for e in entries:
        for i, s in enumerate(e["senses"]):
            text = gloss_text(s)
            if not text:
                continue
            tags = set(s.get("tags", []))
            weak = bool(tags & WEAK_SENSE_TAGS)
            is_form = "form-of" in tags or bool(s.get("form_of"))
            alt = "alt-of" in tags
            # lower is better: prefer strong senses, then (for inflections) form-of senses, then order
            score = (weak, alt, (not is_form) if prefer_form_of else is_form)
            candidates.append((score, len(candidates), e["pos"], s))
    if not candidates:
        return None
    _, _, pos, sense = min(candidates, key=lambda c: (c[0], c[1]))
    return pos, sense


def pointer_targets(sense: dict) -> list[str]:
    return sense.get("alt_of") or sense.get("form_of") or []


def is_abbreviation(sense: dict) -> bool:
    """Abbreviations and symbols ("Abbreviation of could", "Symbol for millilitre"), but not
    clippings or ellipses such as "exam" or "course" that are words in their own right."""
    tags = set(sense.get("tags", []))
    if tags & {"clipping", "ellipsis"}:
        return False
    return bool(tags & ABBREVIATION_TAGS) or bool(ABBREVIATION_GLOSS.match(gloss_text(sense)))


def resolve(targets: list[str], wpos: str, targets_wikt: dict[str, list[dict]]) -> dict | None:
    """Definition of the word a pointer gloss refers to ("plural of cat" -> cat's definition)."""
    for t in targets:
        entries = targets_wikt.get(t, [])
        same_pos = [e for e in entries if e["pos"] == wpos] or entries
        picked = pick_sense(same_pos, prefer_form_of=False)
        if picked and not pointer_targets(picked[1]):
            return {"word": t, "text": gloss_text(picked[1])}
    return None


def annotate(word: str, esdb_rows, subtlex_row, wikt_entries) -> dict:
    # Dominant part of speech: SUBTLEX-US usage counts (ignoring name uses) when available, else
    # Wiktionary's first entry.
    pos = None
    if subtlex_row is not None and isinstance(subtlex_row["dom_common"], str):
        pos = SUBTLEX_TO_CLASS.get(subtlex_row["dom_common"])
    wikt_classes = [WIKT_TO_CLASS.get(e["pos"], "other") for e in wikt_entries]
    if pos in (None, "other") and wikt_classes:
        pos = next((c for c in wikt_classes if c not in ("other", "name")), wikt_classes[0])
    if pos in (None, "name"):
        pos = "other"
    all_pos = sorted({pos} | {c for c in wikt_classes if c in POS_CLASSES}, key=POS_CLASSES.index)

    # Base form: under the dominant POS, does ESDB list this word as a lemma rather than an inflection?
    matching = [r for r in esdb_rows if pos in ESDB_BASE_TO_CLASSES.get(r[1], set())] or esdb_rows
    lemma_rows = [r for r in matching if r[0] not in INFLECTED_FORMS]
    is_base = bool(lemma_rows)
    lemma = None if is_base else next((r[2] for r in matching if r[2] != word), None)

    # Definitions: the dominant POS first, then up to two other parts of speech.
    by_class = collections.defaultdict(list)
    for e, c in zip(wikt_entries, wikt_classes):
        by_class[c].append(e)
    order = [pos] + [c for c in by_class if c != pos]
    defs = []
    for c in order:
        picked = pick_sense(by_class.get(c, []), prefer_form_of=not is_base and c == pos)
        if picked:
            wpos, sense = picked
            defs.append({"pos": wpos, "text": gloss_text(sense), "targets": pointer_targets(sense)})
        if len(defs) == MAX_DEFS:
            break
    only_abbreviations = all(is_abbreviation(s) for e in wikt_entries for s in e["senses"] if gloss_text(s))
    return {
        "pos": pos,
        "pos_all": all_pos,
        "is_base": is_base,
        "lemma": lemma,
        "defs": defs,
        "only_abbreviations": only_abbreviations,
    }


def main() -> None:
    cands = load_candidates()
    print(f"wordfreq: {len(cands):,} a-z words")
    words = set(cands["word"])
    esdb = load_esdb(words)
    subtlex = load_subtlex()
    wikt = load_wiktionary(words)
    print(
        f"ESDB rows for {len(esdb):,} candidates; SUBTLEX {len(subtlex):,} words; Wiktionary {len(wikt):,} words"
    )

    reasons = collections.Counter()
    excluded_offensive = []
    kept = []
    for row in cands.itertuples(index=False):
        w = row.word
        rows = esdb.get(w)
        if not rows:
            reasons["not in ESDB <= 70 (typo, abbreviation, rare or not a word)"] += 1
            continue
        if any(r[3].startswith("offensive") for r in rows):
            reasons["ESDB offensive (slur)"] += 1
            excluded_offensive.append(w)
            continue
        if len(w) == 1 and w not in ("a", "i"):
            reasons["single letter"] += 1
            continue
        st = subtlex.loc[w] if w in subtlex.index else None
        common_share = 1.0
        if st is not None and st["pos_total"] > 0:
            common_share = 1 - st["name_count"] / st["pos_total"]
            common_per_million = (st["pos_total"] - st["name_count"]) / SUBTLEX_MILLIONS
            if common_share < 0.5 and common_per_million < MIN_COMMON_PER_MILLION:
                reasons["proper name (SUBTLEX-US)"] += 1
                continue
        if w not in wikt:
            reasons["no English Wiktionary entry"] += 1
            continue
        info = annotate(w, rows, st, wikt[w])
        only_abbreviations = info.pop("only_abbreviations")
        if only_abbreviations or not info["defs"]:
            reasons["abbreviation or symbol (Wiktionary)"] += 1
            continue
        # A tiny floor keeps words SUBTLEX saw only as names from getting a zero/negative log.
        zipf = row.zipf + np.log10(max(common_share, 1e-3))
        kept.append({"word": w, "zipf": zipf, "zipf_all_uses": row.zipf, **info})
    for why, n in reasons.most_common():
        print(f"  excluded {n:>7,}  {why}")

    df = pd.DataFrame(kept).sort_values("zipf", ascending=False, kind="stable").head(N_WORDS)
    df = df.reset_index(drop=True)
    print(f"  {len(kept) - len(df):,} further words fall below the top {N_WORDS:,}")

    # Resolve pointer glosses ("plural of cat", "Alternative spelling of OK") to the target's definition.
    targets = {t for defs in df["defs"] for t in defs[0]["targets"]}
    targets_wikt = load_wiktionary(targets)
    for defs in df["defs"]:
        first = defs[0]
        if first["targets"]:
            first["via"] = resolve(first["targets"], first["pos"], targets_wikt)
        for d in defs:
            d.pop("targets")
            if not d.get("via"):
                d.pop("via", None)

    df.insert(1, "rank", np.arange(1, len(df) + 1))
    df["length"] = df["word"].str.len()
    df["gloss"] = [d[0]["text"] for d in df["defs"]]
    df["defs"] = [orjson.dumps(d).decode() for d in df["defs"]]
    df["pos_all"] = [",".join(p) for p in df["pos_all"]]
    INTERIM.mkdir(parents=True, exist_ok=True)
    df.to_parquet(VOCAB, index=False)
    (INTERIM / "excluded_offensive.txt").write_text("\n".join(excluded_offensive) + "\n")
    print(
        f"vocab: {len(df):,} words, frequency floor zipf {df['zipf'].min():.2f}; base forms {df['is_base'].sum():,}"
    )
    print("  POS:", df["pos"].value_counts().to_dict())
    resolved = sum('"via"' in d for d in df["defs"])
    print(f"  pointer glosses resolved to their target's definition: {resolved:,}")


if __name__ == "__main__":
    main()
