# First Principles — how to publish

This site has no build step. Every page is a plain file; publishing means
pushing the folder to GitHub (or copying it to any static host).

## Publishing an article in LaTeX (the main way)

1. **Save your raw LaTeX** — the whole document, preamble and all, exactly as
   you'd compile it — into the `content/` folder with a short hyphenated name:

   ```
   content/geometric-mechanics.tex
   ```

   No edits needed. The site strips the preamble itself and renders the body
   in the browser with MathJax. What's supported out of the box:

   - the `physics` package (`\dv`, `\pdv`, `\dd`, `\vb`, `\div`, `\bra`, `\ket`, …)
   - your `dhortcmds.sty` shortcuts (`\br`, `\cbr`, `\sbr`, `\mat`, `\R`, `\mc`,
     the trig shortcuts, `\highlight…`, and the rest — ported as MathJax macros
     in `article.html`)
   - `flalign` / `align` / `equation` with `\label` + `\eqref` cross-references
     (numbered and clickable, AMS style)
   - `empheq` with `box=\mathbox` → the boxed key-equation look
   - `mybox` → a bordered prose box
   - `derivation` (optional `[title]`) → a collapsed `<details>` block for a
     step-by-step derivation the reader can expand; e.g.
     `\begin{derivation}[Deriving the Euler–Lagrange equation]...\end{derivation}`
   - `\section` / `\subsection` (auto-numbered), `\S\ref{sec:…}` links,
     `\footnote` (shown as margin notes next to their reference on wide
     screens, and as a numbered endnote list on narrow ones),
     `enumerate[label=(\roman*)]`, `\emph`, `\textbf`, …
   - theorem environments from `dhortthms.sty` (theorem / definition / remark…)
     rendered as colour-coded boxes matching the .sty legend

2. **Add one entry to `content/articles.json`** (copy an existing one):

   ```json
   {
     "file": "geometric-mechanics.tex",
     "slug": "geometric-mechanics",
     "title": "Geometric Formulation of Classical Mechanics",
     "date": "2026-07-08",
     "topic": "mechanics",
     "excerpt": "One or two sentences shown on the list and homepage."
   }
   ```

   - `date` is `YYYY-MM-DD` — it orders the list and picks the homepage "latest".
   - `topic` is one lowercase word; articles sharing it are grouped/filterable.
   - Mind the commas: every entry except the last ends with one.
   - Add `"published": false` to keep an article as a draft: it disappears
     from the list, the counts, and direct links. Remove the flag (or set it
     to `true`) and push to publish.

   **Admin preview:** visit `articles.html?admin=on` to turn on admin mode in
   your own browser (nothing changes for visitors — the state lives in
   localStorage). Drafts then appear with a publish/unpublish toggle so you can
   preview either state locally; `?admin=off` turns it back off. Actually
   publishing for everyone is always the JSON flag + a push — a static site
   has no server to do it for you.

3. That's it. The homepage stats, the article list, the topic filters and the
   sidebar all read `articles.json`.

4. **Optional: regenerate the RSS feed.** Run `node scripts/build_feed.js`
   and commit the updated `feed.xml` alongside your change. There's no
   build step for this either — the feed is a static file, just like
   `articles.json`, so it only updates when you re-run the script.

Markdown still works too: drop a `.md` file (front matter block on top,
`$…$` math) in `content/` and reference it the same way.

## Images: SVG, animated SVG, and TikZ

Put image files in `content/figures/`. Then, inside your LaTeX:

- **Static images** (svg/png/jpg):

  ```latex
  \includegraphics[width=0.7\textwidth]{figures/phase-portrait.svg}
  ```

- **Animated / interactive SVGs** (CSS or SMIL animations): use `\websvg`
  instead — it inlines the SVG element so the animation actually runs:

  ```latex
  \websvg{figures/pendulum-animated.svg}
  ```

- **TikZ figures**: compile them to SVG once with the helper script
  (uses your local `pdflatex` + `dvisvgm`):

  ```
  scripts/tikz2svg.sh myfigure.tex
  ```

  This accepts either a full standalone document or a bare `tikzpicture`
  snippet, writes `content/figures/myfigure.svg`, and you include it with
  `\includegraphics{figures/myfigure.svg}` as above.

## Previewing on your computer

Browsers refuse to fetch article files from a page opened directly off disk,
so run a tiny local server first:

1. Open a terminal in the site folder.
2. Run `python3 -m http.server`.
3. Visit `http://localhost:8000`.

## Changing the site's CSS or JS

Static hosts and browsers cache stylesheets and scripts for a while. Every
page therefore links them with a version query (`site.css?v=3`,
`site.js?v=3`, `latex.js?v=3`). **When you edit any of those files, bump the
number everywhere it appears** (a project-wide find-and-replace of `?v=3` →
`?v=4`) so every visitor gets the new copy immediately instead of a stale
cached one.

## What lives where

| File | What it is | Edit it? |
| --- | --- | --- |
| `content/*.tex`, `content/*.md` | Your articles | Yes — this is where you write |
| `content/articles.json` | The article list | One entry per new article |
| `content/figures/` | Images used by articles | Drop files in |
| `latex/*.sty` | Your dhortcmds / dhortthms packages (reference + tikz2svg) | When your macros change |
| `scripts/tikz2svg.sh` | TikZ → SVG converter | No need |
| `about.html` | The about page | Yes — replace the placeholder text |
| `index.html` | Homepage (hero + math figures) | No need |
| `articles.html` | Article list + topic filters | No need |
| `article.html` | The reader (MathJax config + macros live here) | When adding macros |
| `latex.js` | LaTeX → HTML structural converter | No need |
| `site.css` | Shared look of the content pages | No need |

Routine publishing never touches HTML, CSS, or JavaScript — only your
LaTeX file and one JSON entry.
