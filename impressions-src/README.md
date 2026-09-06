# Impressions

Impressions: one document per book you read, holding the quotes and
excerpts you kept from it and your commentary on them. Each book is a plain-text
YAML file, published two ways — a typeset PDF per book and the `/impressions/`
section of the First Principles site (this folder's parent).

```
impressions-src/             ← this folder: sources, never served
  books/                     ← one <slug>.yaml per book: the only files you edit
  app.py                     ← the "just type the quote" interface
  build.py                   ← generates everything
  moods.yaml                 ← mood → font pairing / colour map
  config.yaml                ← title, output folder, TeX engine
  latex/preamble.tex         ← page layout & macros for the PDFs
  site/                      ← template.html, impressions.css, app.html
  fonts/                     ← bundled OFL fonts (static/ for LaTeX, web/ for the site)
  build/                     ← GENERATED LaTeX + one PDF per book (git-ignored)
../impressions/              ← GENERATED pages, fonts and PDFs — the live section
```

## Daily use

```sh
python3 app.py                # opens localhost:8765: pick a book, paste the quote, Save.
                              # Saves the YAML, rebuilds the section + that book's PDF,
                              # commits and pushes (each step is a checkbox).
```

Without the app:

```sh
python3 build.py --new        # same thing as terminal prompts
python3 build.py              # regenerate ../impressions/ and build/<book>.tex
python3 build.py --pdf        # …and compile PDFs for books that changed (--all for every book)
make                          # same as build.py --pdf
```

Or create `books/<slug>.yaml` by hand (the filename is the URL and PDF name):

```yaml
title: Meditations
author: Marcus Aurelius
translator: George Long        # optional
year: "c. 180"                 # optional
read: 2026-08                  # optional — when you read it
mood: philosophy               # default typography for every entry in this book
notes: |                       # optional — a paragraph about the book as a whole
  Read in the Long translation…

entries:
  - quote: |
      The universe is change; our life is what our thoughts make it.
    where: Book IV, 3
    date: 2026-09-01
    tags: [stoicism]
    commentary: |
      Your notes go here. *Italics*, **bold**, `code` and [links](https://…) work.
      A blank line starts a new paragraph.
  - quote: |
      …
    mood: reflection           # optional per-entry override
```

`mood` picks the typography. Nineteen are defined in `moods.yaml`, grouped roughly
as thinking (philosophy, reflection, essay, science, scripture), feeling (poetry,
tragic, tender, wonder, unease), telling (literary, speculative, myth, memoir,
history), laughing (humour, satire) and the world (political, craft). Each pairs a
quote face with a body face and an accent colour; the editor shows a one-line hint
for each. Ten families are bundled: Cormorant Garamond, EB Garamond, Playfair
Display, Lora, Spectral, Fraunces, Alegreya, Crimson Pro, Cardo, Libre Baskerville.

Edit `moods.yaml` to change pairings, scales or accent colours, or to add a mood.
Line breaks inside `quote:` are kept for `poetry` (or when you set `verse: true`);
for prose they're reflowed, so wrap your lines however you like.

Each book becomes `build/<slug>.pdf` (6×9 in, title page, notes, then the entries
in date order) and `../impressions/books/<slug>.html`. `/impressions/` is the
library of books, `/impressions/entries.html` every entry in one stream with mood
filters; a built PDF is copied to `../impressions/pdf/` and linked from its book page.

## Publishing

The generated `../impressions/` folder is committed like the rest of the site, so
publishing is a push. The app does this for you; by hand it's
`python3 build.py --pdf && git add -A .. && git commit -m "Impressions: …" && git push`.

Preview the whole site with `make serve` (runs `python3 -m http.server` in the site
root) and open <http://localhost:8000/impressions/>.

## Requirements

* Python 3.9+ with PyYAML (`pip3 install pyyaml`)
* For the PDF: a TeX distribution with LuaLaTeX or XeLaTeX and `fontspec`
  (MacTeX / TeX Live). Set `engine:` in `config.yaml` or pass `--engine xelatex`.

Fonts are bundled, so nothing needs installing system-wide. All are under the
SIL Open Font License — see `fonts/LICENSES.md`.
