#!/usr/bin/env bash
# tikz2svg.sh — compile a TikZ (or any standalone LaTeX) figure to an SVG
# the website can use.
#
#   scripts/tikz2svg.sh myfigure.tex            -> content/figures/myfigure.svg
#   scripts/tikz2svg.sh myfigure.tex nice-name  -> content/figures/nice-name.svg
#
# The input may be either a complete document (\documentclass...) or a bare
# tikzpicture — bare snippets get wrapped in a standalone document that loads
# your dhortcmds/dhortthms packages.
#
# Then in an article:   \includegraphics{figures/myfigure.svg}
# or, for animated/interactive SVGs:   \websvg{figures/myfigure.svg}

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <figure.tex> [output-name]" >&2
  exit 1
fi

IN="$1"
NAME="${2:-$(basename "${IN%.tex}")}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/content/figures/$NAME.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if grep -q '\\documentclass' "$IN"; then
  cp "$IN" "$TMP/fig.tex"
else
  {
    echo '\documentclass[tikz,margin=2pt]{standalone}'
    echo '\usepackage{amsmath,amssymb,physics}'
    echo '\usetikzlibrary{arrows.meta,calc,decorations.markings,patterns,positioning}'
    # note: dhortcmds is NOT auto-loaded (its \var clashes with physics in
    # TeX Live 2024). Figures that need it should be full standalone docs.
    echo '\begin{document}'
    cat "$IN"
    echo '\end{document}'
  } > "$TMP/fig.tex"
fi

( cd "$TMP" &&
  pdflatex -interaction=nonstopmode -halt-on-error fig.tex > pdflatex.log 2>&1 ||
  { echo "pdflatex failed — log follows:" >&2; tail -30 pdflatex.log >&2; exit 1; } )

mkdir -p "$ROOT/content/figures"
# pdftocairo renders text as paths: identical in every browser.
# (dvisvgm --pdf needs a Ghostscript-enabled build, which this Mac lacks.)
if command -v pdftocairo > /dev/null; then
  pdftocairo -svg "$TMP/fig.pdf" "$OUT"
else
  dvisvgm --pdf --no-fonts --optimize -o "$OUT" "$TMP/fig.pdf"
fi

echo "wrote ${OUT#$ROOT/}"
