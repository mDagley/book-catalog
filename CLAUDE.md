@AGENTS.md

## Data Freshness Model

This data is mostly static and only changes on sync. Prefer persisting computed state (e.g., an ownership/status flag written at sync time) over recompute-on-read or cache-invalidation designs. Do not propose TTL caches or background recompute jobs unless asked.

## Shell / Remote Execution

For library maintenance on the Audiobookshelf host, emit a single complete batch script (with `set -e` and echo checkpoints) that I can paste in one go. Do not use one-command-at-a-time confirmation loops. Always verify paths with `ls` inside the script before `mv`/`rmdir`, and quote all paths containing spaces or special characters.

## Ebook Pipeline Conventions

When processing ebook/metadata batches: normalize author names to `Last, First` and handle UTF-8/latin-1 encoding explicitly before diffing libraries. Always include the Calibre import step as part of the end-to-end pipeline — it is not optional.
