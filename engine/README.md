<!-- ultrasearch-fork -->
# UltraSearch engine (renamed fork)

This tree is a locally patched working copy of the upstream engine by **Noah Dunnagan**
(MIT — see `LICENSE`): https://github.com/noahdunnagan/fsearch
It is renamed to `ultrasearch` for the `pi-ultrasearch` extension; upstream authorship and
copyright are unchanged, the upstream project name, version and URL are recorded in `NOTICE`,
and `../docs/engine-changes.md` lists every behavioural change this fork carries.

Everything below is the upstream README, kept verbatim except for renamed paths/labels.

---

# UltraSearch

Whole-disk file search for macOS: names in about 0.1 ms, typo-tolerant,
plus indexed search inside files. A CLI with a small daemon, a Rust crate,
or an MCP server for coding agents.

```
cargo build --release && ./target/release/ultrasearch install   # -> ~/.local/bin/ultrasearch-daemon
ultrasearch ultrasearch main              # find files by name
ultrasearch 'ext:rs grep:apply_dir'   # search inside files
```

Or skip the Rust toolchain with a release build for Apple Silicon:

```
curl -L https://github.com/noahdunnagan/fsearch/releases/latest/download/fsearch-aarch64-apple-darwin.tar.gz | tar xz && ./ultrasearch install
```

## Speed

M4 Mac mini, a home holding the Linux or the Chromium source tree, vs the
previous version (b88f4e9). Medians; Linux / Chromium.

| | before | now |
|---|---:|---:|
| right file first, name search | 83% / 86% | 93% / 97% |
| right file first, two typos | 11% / 15% | 74% / 93% |
| find a file by name | 0.045 / 0.10 ms | 0.054 / 0.12 ms |
| an edited file greppable | 2.1 s | 1.3 ms |
| a rename or delete visible | 45 / 47 ms | 18 / 15 ms |
| first run, a name in a folder | 7.8 / 7.8 s | 0.18 / 1.2 s |
| first run, every match in the tree | 10.9 / 12.2 s | 2.4 / 10.8 s |
| files grep can search (rg's own set) | 96% / 92% | 99.9% / 99.8% |
| grep, first page | 0.29 / 0.48 ms | 0.33 / 0.65 ms |
| index on disk | 503 / 893 MB | 309 / 600 MB |
| peak memory while indexing | 1.13 / 1.37 GB | 0.77 / 0.94 GB |
| daemon memory | 19 / 100 MB | 21 / 35 MB |

The index is a third smaller while holding a third more text: one 3-bit
filter per file instead of two, compressed posting lists and paths, and
bit-packed name arrays read in place. Grep's first page reads a few more
files for it, and the deeper typo search costs a little on names.

## Queries

```
ultrasearch 'readme in:~/Developer'          # inside a folder
ultrasearch 'type:image size:>5mb mtime:<7d'
ultrasearch 'ext:rs regex:fn\s+\w+_dir'      # regex inside files
ultrasearch 'sym:apply_dir'                  # where it's defined
ultrasearch 'src/**/*.{c,h} !test/ init'     # globs, in or out
ultrasearch 'git:modified in:~/Developer/app'
```

Words are fuzzy and forgive a typo at any letter, two in words of 8+
(`mian.rs` finds `main.rs`); several words can spell one name. Accented
names match however they were stored. Also `'exact`, `^prefix`, `suffix$`
and `!exclude`. Filters: `ext:` `type:` `kind:` `in:` `size:` `mtime:`
`re:` `path:` `grep:` `regex:` `sym:` `limit:` and `git:` (`modified`
`staged` `untracked` `clean` `tracked` `ignored` `conflict`). Content search is
smart-case, and regexes match within a line, as in ripgrep.

## What grep covers

Text files up to 1 MB, and up to 10 MB inside git repos, minus what git
ignores. It leaves out lockfiles, JSON of 100 KB and up, minified or
bundled assets, linked git worktrees (their main checkout is indexed), and
build-output folders outside repos. To leave out more, list folders in
`~/Library/Application Support/UltraSearch/content-skip.txt`, one per line
(`~` and `#` comments work). Names are always indexed, and a grep inside
a file you name still reads it.

## Full Disk Access

From a terminal with Full Disk Access it indexes everything. As a login
item (`ultrasearch install --login`), grant `~/.local/bin/ultrasearch-daemon` access in
System Settings > Privacy & Security, again after each rebuild. Without
access it skips protected folders instead of prompting.

## API

JSON lines over `~/Library/Application Support/UltraSearch/ultrasearch.sock`, or
`ultrasearch stdio`:

```json
{"q": "ultrasearch main", "limit": 20, "offset": 20}
{"op": "grep", "pattern": "apply_dir", "in": "~/Developer", "context": 2}
{"q": "main.rs", "boost": true, "near": "~/Developer/app/src/lib.rs", "git": true}
{"op": "open", "path": "~/Developer/app/src/main.rs"}
{"op": "recent", "in": "~/Developer/app"}
```

`open` tells it what you opened; `"boost": true` ranks those higher for a
while, `near` favors files close to the one you're in, and `recent` lists
what you worked on lately. `"git": true` adds each hit's git status.

For coding agents, `ultrasearch mcp` is an MCP server on stdio with
`find_files`, `grep` and `multi_grep`.

Or link the crate:

```rust
let engine = ultrasearch::Engine::start(ultrasearch::Options { dir: ultrasearch::default_dir(&home), home: home.clone(), skip: None })?;
let hits = engine.search(&ultrasearch::Query::parse("ultrasearch main", &home)?)?;
```

An app and the CLI share one index: the first process owns it, the rest
follow.

## How it works

- Crawls the disk once with `getattrlistbulk`, then follows FSEvents:
  changes show up in about 15 ms, and a restart replays only what changed.
  On a first run, a search in a folder indexes that folder first.
- Names live in one mmap'd file, folder by folder, so `in:` is a range. A
  bitmap of each name's letters rules out most names before scoring.
- Content search is a trigram index plus a per-file filter, so a search
  only reads files likely to match. Identical files are indexed once, and
  deleted files' entries are compacted away. Matches are read fresh from
  disk; files edited since the last index sync are read directly.
- The daemon runs with malloc's space-efficient mode, so it gives memory
  back when idle.
