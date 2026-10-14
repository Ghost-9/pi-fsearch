#!/usr/bin/env bash
#
# rebrand.sh — deterministically rebrand the upstream fsearch engine source
# (MIT, (c) Noah Dunnagan) into the UltraSearch engine.
#
# Usage: engine/rebrand.sh <src-dir> <dst-dir>
#
#   src-dir  an upstream (or already-rebranded) fsearch checkout, e.g. ~/.cache/fsearch
#   dst-dir  the UltraSearch engine working copy to create/update, e.g. ~/ultrasearch-engine
#
# Guarantees
#   * deterministic: same input tree -> byte-identical output tree (modulo the
#     dst path itself, which is never written into file contents)
#   * idempotent: running it twice (or on an already-rebranded tree) is a no-op
#   * licence-safe: LICENSE and the upstream attribution lines are never rewritten;
#     a NOTICE describing the fork is written next to them
#
# Reapply onto a newer upstream tag:
#   git -C ~/.cache/fsearch fetch --tags && git -C ~/.cache/fsearch checkout v0.2.1
#   engine/rebrand.sh ~/.cache/fsearch ~/ultrasearch-engine
#   cargo build --release --manifest-path ~/ultrasearch-engine/Cargo.toml
set -euo pipefail

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

[ $# -eq 2 ] || usage
SRC="$1"
DST="$2"

[ -d "$SRC" ] || { echo "rebrand: source directory not found: $SRC" >&2; exit 1; }
[ -f "$SRC/Cargo.toml" ] || { echo "rebrand: no Cargo.toml in $SRC" >&2; exit 1; }

SRC_ABS="$(cd "$SRC" && pwd -P)"
mkdir -p "$DST"
DST_ABS="$(cd "$DST" && pwd -P)"
[ "$SRC_ABS" = "$DST_ABS" ] && { echo "rebrand: src and dst are the same directory" >&2; exit 1; }
case "$SRC_ABS/" in "$DST_ABS"/*) echo "rebrand: src is inside dst" >&2; exit 1 ;; esac
case "$DST_ABS/" in "$SRC"/*) echo "rebrand: dst is inside src" >&2; exit 1 ;; esac

# --- 0. copy the tree (source of truth), excluding build output -----------------
# --delete keeps the dst tree an exact mirror of src, so a stale file can never
# survive a rebrand run. `.git` is copied so the fork keeps upstream provenance.
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'target/' \
    "$SRC"/ "$DST"/
else
  (cd "$SRC" && tar --exclude ./target -cf - .) | (cd "$DST" && tar -xf -)
fi

# --- 1. text transforms --------------------------------------------------------
# Order matters: FSEARCH -> ULTRASEARCH, FSearch -> UltraSearch, fsearch -> ultrasearch.
# `ultrasearch` contains neither `fsearch` nor `FSearch`, so a second run is a no-op.
rebrand_file() {
  local f="$1"
  [ -f "$f" ] || return 0
  perl -0pi -e '
    s/FSEARCH/ULTRASEARCH/g;
    s/FSearch/UltraSearch/g;
    s/fsearch/ultrasearch/g;
  ' "$f"
}

transform_dir() {
  local root="$1"
  local f
  while IFS= read -r -d '' f; do
    case "$f" in
      */LICENSE) continue ;;            # upstream MIT text is never rewritten
      */NOTICE) continue ;;             # generated below
      */README.md) continue ;;          # handled explicitly, attribution preserved
      */Cargo.lock) rebrand_file "$f" ;;
      *.rs|*.toml|*.yml|*.yaml|*.json|*.sh|*.py|*.md|*.txt) rebrand_file "$f" ;;
    esac
  done < <(find "$root" -type f -not -path '*/.git/*' -not -path '*/target/*' -print0)
}

# 1a. Cargo package + binary name.
rebrand_file "$DST/Cargo.toml"
rebrand_file "$DST/Cargo.lock" 2>/dev/null || true

# 1b. Every Rust / workflow / doc file except the protected set above.
transform_dir "$DST"

# 1c. The installed daemon binary is named `ultrasearch-daemon` (the extension's
#     trySpawnDaemon candidates and the LaunchAgent point at it).
apply_exact() {
  local f="$1" from="$2" to="$3"
  [ -f "$f" ] || return 0
  perl -0pi -e "s/\Q$from\E/$to/g" "$f"
}
apply_regex() {
  local f="$1" expr="$2"
  [ -f "$f" ] || return 0
  perl -0pi -e "$expr" "$f"
}
apply_regex "$DST/src/main.rs" 's{\.local/bin/ultrasearch(?!-daemon)}{\.local/bin/ultrasearch-daemon}g'
apply_regex "$DST/README.md" 's{\.local/bin/ultrasearch(?!-daemon)}{\.local/bin/ultrasearch-daemon}g'

# --- 2. README: keep upstream attribution, rebrand the local usage -------------
# The upstream project URL is masked before the token swap so attribution stays
# accurate; nothing else in README is exempt.
README="$DST/README.md"
MARK='<!-- ultrasearch-fork -->'
if [ -f "$README" ]; then
  if ! grep -qF "$MARK" "$README"; then
    tmp="$(mktemp)"
    {
      printf '%s\n' "$MARK"
      printf '# UltraSearch engine (rebranded fsearch fork)\n\n'
      printf 'This tree is a locally patched working copy of the upstream engine by **Noah Dunnagan**\n'
      printf '(MIT — see `LICENSE`): https://github.com/noahdunnagan/fsearch\n'
      printf 'It is rebranded to `ultrasearch` for the `pi-ultrasearch` extension; upstream authorship and\n'
      printf 'copyright are unchanged, and the upstream terms are recorded in `NOTICE`.\n\n'
      printf 'Everything below is the upstream README, kept verbatim except for renamed paths/labels.\n\n---\n\n'
      cat "$README"
    } > "$tmp"
    mv "$tmp" "$README"
  fi
  # Mask upstream-only literals with placeholders, swap tokens, restore verbatim.
  # No backreferences: the placeholders are restored as literal strings, so the
  # upstream URL and asset name can never be mangled.
  perl -0pi -e '
    s{noahdunnagan/fsearch}{noahdunnagan/__UPSTREAM_NAME__}g;
    s{fsearch-aarch64-apple-darwin}{__UPSTREAM_ASSET__}g;
    s/FSEARCH/ULTRASEARCH/g;
    s/FSearch/UltraSearch/g;
    s/fsearch/ultrasearch/g;
    s/__UPSTREAM_NAME__/fsearch/g;
    s/__UPSTREAM_ASSET__/fsearch-aarch64-apple-darwin/g;
  ' "$README"
fi

# --- 3. NOTICE ----------------------------------------------------------------
cat > "$DST/NOTICE" <<'EOF'
UltraSearch engine
==================

This directory contains a renamed/rebranded fork of the "fsearch" engine.

  Upstream project : fsearch
  Upstream author  : Noah Dunnagan
  Upstream URL     : https://github.com/noahdunnagan/fsearch
  Upstream version : 0.2.1 (git tag v0.2.1, commit 88e63fd)
  Upstream license : MIT (see LICENSE in this directory, unmodified)

The original work is copyright (c) Noah Dunnagan and is used under the terms of
the MIT license reproduced in LICENSE. This fork changes the package/binary
name to `ultrasearch`, the default data directory to `UltraSearch`, and
user-facing strings accordingly. No authorship of the original engine is
claimed by the fork.

Regenerate this tree with:

  engine/rebrand.sh <upstream-checkout> <this-directory>

Build:

  cargo build --release
  install -m 0755 target/release/ultrasearch ~/.local/bin/ultrasearch-daemon
EOF

# --- 4. verify ----------------------------------------------------------------
REMAINING="$(
  find "$DST" -type f \( -name '*.rs' -o -name '*.toml' -o -name '*.yml' -o -name '*.yaml' \) \
    -not -path '*/.git/*' -not -path '*/target/*' -print0 |
  xargs -0 grep -l 'fsearch\|FSearch\|FSEARCH' 2>/dev/null || true
)"
if [ -n "$REMAINING" ]; then
  echo "rebrand: WARNING — remaining upstream tokens in:" >&2
  echo "$REMAINING" | sed 's/^/  /' >&2
fi

echo "rebrand: $SRC -> $DST"
echo "  package name : $(grep -m1 '^name' "$DST/Cargo.toml" | tr -d ' ')"
echo "  NOTICE       : $DST/NOTICE"
echo "  LICENSE md5  : $(md5 -q "$DST/LICENSE" 2>/dev/null || md5sum "$DST/LICENSE" | cut -d' ' -f1)"
