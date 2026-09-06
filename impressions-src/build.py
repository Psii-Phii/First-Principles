#!/usr/bin/env python3
"""
build.py — turn books/*.yaml into (a) one typeset PDF per book and (b) a static website.

    python3 build.py            # generate LaTeX for every book + the website
    python3 build.py --pdf      # …and compile the PDFs (only books whose YAML changed)
    python3 build.py --pdf --all   # recompile every PDF
    python3 build.py --check    # validate books/*.yaml only
    python3 build.py --new      # prompt for a new entry (or a new book)

Only dependency: PyYAML.  Fonts are read from moods.yaml / fonts/.
"""
from __future__ import annotations

import argparse
import datetime as dt
import html
import re
import shutil
import subprocess
import sys
from collections import OrderedDict
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required:  pip3 install pyyaml")

class BuildError(Exception):
    """Raised for user-facing failures (bad YAML, missing TeX, LaTeX errors)."""


ROOT = Path(__file__).resolve().parent
BOOKS_DIR = ROOT / "books"
FONT_STATIC = ROOT / "fonts" / "static"
FONT_WEB = ROOT / "fonts" / "web"


# ─────────────────────────────────────────────────────────────────────────────
#  Loading & validation
# ─────────────────────────────────────────────────────────────────────────────
def load_yaml(path: Path):
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def load_books(moods) -> list[dict]:
    """Read every books/*.yaml, resolve per-entry moods, attach slugs. Exits on errors."""
    books, errors = [], []
    for path in sorted(BOOKS_DIR.glob("*.yaml")):
        loc = path.name
        try:
            b = load_yaml(path)
        except yaml.YAMLError as ex:
            errors.append(f"{loc}: YAML syntax error — {str(ex).splitlines()[-1].strip()}\n"
                          f"    (check indentation: quote text needs 6 spaces, entry fields 4)")
            continue
        if not isinstance(b, dict):
            errors.append(f"{loc}: must be a mapping with title/author/mood/entries"); continue
        for f in ("title", "author"):
            if not str(b.get(f, "")).strip():
                errors.append(f"{loc}: missing '{f}'")
        b.setdefault("mood", None)
        if not b["mood"]:
            errors.append(f"{loc}: missing book-level 'mood'")
        elif b["mood"] not in moods:
            errors.append(f"{loc}: unknown mood '{b['mood']}' (known: {', '.join(moods)})")
        entries = b.get("entries") or []
        if not isinstance(entries, list):
            errors.append(f"{loc}: 'entries' must be a list"); entries = []
        for n, e in enumerate(entries, 1):
            if not isinstance(e, dict) or not str(e.get("quote", "")).strip():
                errors.append(f"{loc} entry {n}: missing 'quote'"); continue
            e["mood"] = e.get("mood") or b["mood"]
            if e["mood"] not in moods:
                errors.append(f"{loc} entry {n}: unknown mood '{e['mood']}'")
            if e.get("date") is not None and not isinstance(e["date"], (dt.date, dt.datetime)):
                try:
                    dt.date.fromisoformat(str(e["date"]))
                except ValueError:
                    errors.append(f"{loc} entry {n}: date must be YYYY-MM-DD, got {e['date']!r}")
            e["_book"] = b
        b["entries"] = [e for e in entries if isinstance(e, dict) and str(e.get("quote", "")).strip()]
        b["slug"] = path.stem
        b["_path"] = path
        b["_mtime"] = path.stat().st_mtime
        books.append(b)
    if errors:
        raise BuildError("Problems in books/:\n  " + "\n  ".join(errors))
    if not books:
        raise BuildError("No books found — add a books/<slug>.yaml (see README) or run build.py --new")
    return books


def latest_date(b) -> str:
    return max((iso_date(e.get("date")) for e in b["entries"]), default="")


# ─────────────────────────────────────────────────────────────────────────────
#  Text handling: light Markdown → LaTeX and → HTML
# ─────────────────────────────────────────────────────────────────────────────
_TEX_SPECIALS = {
    "\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
    "_": r"\_", "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}


def tex_escape(s: str) -> str:
    return "".join(_TEX_SPECIALS.get(c, c) for c in s)


def smarten(s: str) -> str:
    """Typographic dashes/ellipsis for both outputs (quotes are left to the author)."""
    s = s.replace("---", "\u2014").replace("--", "\u2013").replace("...", "\u2026")
    return s


_INLINE = [
    (re.compile(r"\*\*(.+?)\*\*"), "strong"),
    (re.compile(r"\*(.+?)\*"), "em"),
    (re.compile(r"`(.+?)`"), "code"),
    (re.compile(r"\[(.+?)\]\((.+?)\)"), "link"),
]


def _inline(text: str, fmt: str) -> str:
    """fmt is 'tex' or 'html'. Escapes then applies inline markup."""
    # Tokenise so that escaping doesn't destroy the markup.
    out = []
    pos = 0
    pattern = re.compile(r"\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((\S+?)\)")
    esc = tex_escape if fmt == "tex" else html.escape
    for m in pattern.finditer(text):
        out.append(esc(text[pos:m.start()]))
        if m.group(1) is not None:
            inner = _inline(m.group(1), fmt)
            out.append(rf"\textbf{{{inner}}}" if fmt == "tex" else f"<strong>{inner}</strong>")
        elif m.group(2) is not None:
            inner = _inline(m.group(2), fmt)
            out.append(rf"\emph{{{inner}}}" if fmt == "tex" else f"<em>{inner}</em>")
        elif m.group(3) is not None:
            code = esc(m.group(3))
            out.append(rf"\texttt{{{code}}}" if fmt == "tex" else f"<code>{code}</code>")
        else:
            label, url = _inline(m.group(4), fmt), m.group(5)
            if fmt == "tex":
                out.append(rf"\href{{{url}}}{{{label}}}")
            else:
                out.append(f'<a href="{html.escape(url)}">{label}</a>')
        pos = m.end()
    out.append(esc(text[pos:]))
    return "".join(out)


def paragraphs(text: str) -> list[list[str]]:
    """Split on blank lines → paragraphs; each paragraph is a list of lines."""
    paras, cur = [], []
    for line in smarten(text).strip("\n").splitlines():
        if line.strip():
            cur.append(line.rstrip())
        elif cur:
            paras.append(cur)
            cur = []
    if cur:
        paras.append(cur)
    return paras


def quote_to_tex(text: str, verse: bool) -> str:
    """verse=True keeps line breaks; otherwise lines are reflowed. Blank line = paragraph."""
    if verse:
        return "\n\n".join("\\\\\n".join(_inline(l, "tex") for l in p) for p in paragraphs(text))
    return prose_to_tex(text)


def quote_to_html(text: str, verse: bool) -> str:
    if verse:
        return "\n".join("<p>" + "<br>\n".join(_inline(l, "html") for l in p) + "</p>"
                         for p in paragraphs(text))
    return prose_to_html(text)


def is_verse(e) -> bool:
    v = e.get("verse")
    return bool(v) if v is not None else e["mood"] == "poetry"


def prose_to_tex(text: str) -> str:
    """Commentary: lines within a paragraph are joined with spaces."""
    return "\n\n".join(_inline(" ".join(p), "tex") for p in paragraphs(text))


def prose_to_html(text: str) -> str:
    return "\n".join("<p>" + _inline(" ".join(p), "html") + "</p>" for p in paragraphs(text))


def slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "untitled"


def fmt_date(d) -> str:
    if d is None:
        return ""
    if not isinstance(d, dt.date):
        d = dt.date.fromisoformat(str(d))
    return d.strftime("%-d %B %Y")


def fmt_read(v) -> str:
    """'2026-08' → 'August 2026'; '2026' stays; anything else verbatim."""
    v = str(v or "").strip()
    m = re.fullmatch(r"(\d{4})-(\d{2})", v)
    if m:
        return dt.date(int(m.group(1)), int(m.group(2)), 1).strftime("%B %Y")
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", v)
    if m:
        return fmt_date(v)
    return v


def iso_date(d) -> str:
    if d is None:
        return ""
    if not isinstance(d, dt.date):
        d = dt.date.fromisoformat(str(d))
    return d.isoformat()


# ─────────────────────────────────────────────────────────────────────────────
#  LaTeX output — one document per book
# ─────────────────────────────────────────────────────────────────────────────
FONT_OPTS = ("[Path=../fonts/static/,Extension=.ttf,UprightFont=*-Regular,ItalicFont=*-Italic,"
             "BoldFont=*-SemiBold,BoldItalicFont=*-SemiBoldItalic]")


def gen_fonts_tex(moodcfg) -> str:
    lines = ["% Generated by build.py — do not edit.",
             "\\setmainfont{EBGaramond}" + FONT_OPTS]
    families = set()
    for m in moodcfg["moods"].values():
        families.update([m["quote_font"], m["body_font"]])
    for fam in sorted(families):
        lines.append(f"\\newfontfamily\\font{fam}{{{fam}}}" + FONT_OPTS)
    for mood, m in moodcfg["moods"].items():
        lines.append(f"\\definecolor{{{mood}}}{{HTML}}{{{m['accent'].lstrip('#')}}}")
    return "\n".join(lines) + "\n"


def entry_tex(e, moodcfg) -> str:
    m = moodcfg["moods"][e["mood"]]
    b = e["_book"]
    out = [f"\\begin{{entry}}{{{e['mood']}}}{{\\font{m['quote_font']}}}"
           f"{{\\font{m['body_font']}}}{{{m['quote_scale']}}}{{{m['quote_style']}}}",
           f"\\quotetext{{{quote_to_tex(e['quote'], is_verse(e))}}}",
           "\\attribution{%s}{%s}" % (tex_escape(smarten(str(e.get("where", "") or ""))),
                                      fmt_date(e.get("date")))]
    if str(e.get("commentary", "") or "").strip():
        out.append(f"\\commentary{{{prose_to_tex(e['commentary'])}}}")
    out.append("\\end{entry}\n")
    return "\n".join(out)


def gen_book_tex(b, cfg, moodcfg) -> str:
    m = moodcfg["moods"][b["mood"]]
    entries = sorted(b["entries"], key=lambda e: iso_date(e.get("date")))
    notes = prose_to_tex(b["notes"]) if str(b.get("notes", "") or "").strip() else ""
    return "\n".join([
        "% Generated by build.py — edit latex/preamble.tex, not this file.",
        "\\input{../latex/preamble.tex}",
        f"\\title{{{tex_escape(smarten(b['title']))}}}",
        f"\\author{{{tex_escape(b['author'])}}}",
        "\\begin{document}",
        "\\booktitlepage{%s}{%s}{%s}{%s}{%s}{%s}{%s}{%s}" % (
            b["mood"], f"\\font{m['quote_font']}", tex_escape(smarten(b["title"])),
            tex_escape(b["author"]), tex_escape(str(b.get("translator", "") or "")),
            tex_escape(str(b.get("year", "") or "")), tex_escape(fmt_read(b.get("read", ""))),
            tex_escape(cfg["title"])),
        f"\\booknotes{{\\font{m['body_font']}}}{{{notes}}}" if notes else "",
        f"\\markboth{{{tex_escape(smarten(b['title']))}}}{{}}",
        "\n".join(entry_tex(e, moodcfg) for e in entries),
        "\\end{document}", ""])


def write_latex(cfg, books, moodcfg) -> list[Path]:
    bdir = ROOT / cfg.get("build_dir", "build")
    bdir.mkdir(exist_ok=True)
    (bdir / "fonts.tex").write_text(gen_fonts_tex(moodcfg), encoding="utf-8")
    mains = []
    for b in books:
        main = bdir / f"{b['slug']}.tex"
        main.write_text(gen_book_tex(b, cfg, moodcfg), encoding="utf-8")
        mains.append(main)
    return mains


def pick_engine(engine: str = "auto") -> str:
    """'auto' = LuaLaTeX when it has its font loader, else XeLaTeX."""
    if engine != "auto":
        return engine
    if shutil.which("lualatex") and shutil.which("kpsewhich"):
        r = subprocess.run(["kpsewhich", "luaotfload.sty"], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return "lualatex"
    return "xelatex" if shutil.which("xelatex") else "lualatex"


def compile_pdf(main: Path, engine: str = "auto"):
    engine = pick_engine(engine)
    if engine not in ("lualatex", "xelatex"):
        raise BuildError("engine must be lualatex, xelatex or auto")
    if not shutil.which(engine):
        raise BuildError(f"{engine} not found. Compile build/*.tex yourself with LuaLaTeX/XeLaTeX.")
    use_latexmk = shutil.which("latexmk") is not None
    if use_latexmk:
        cmd = ["latexmk", f"-{engine}", "-interaction=nonstopmode", "-halt-on-error",
               f"-output-directory={main.parent}", str(main)]
    else:
        cmd = [engine, "-interaction=nonstopmode", "-halt-on-error",
               f"-output-directory={main.parent}", str(main)]
    r = subprocess.run(cmd, cwd=main.parent, capture_output=True, text=True)
    if r.returncode != 0:
        log = main.with_suffix(".log")
        tail = log.read_text(errors="replace")[-3000:] if log.exists() else r.stdout[-3000:]
        raise BuildError(f"LaTeX failed on {main.name}. Tail of log:\n" + tail)
    print("✓", main.with_suffix(".pdf").relative_to(ROOT))


# ─────────────────────────────────────────────────────────────────────────────
#  Website output
# ─────────────────────────────────────────────────────────────────────────────
def font_faces(moodcfg) -> str:
    css = []
    for f in moodcfg["fonts"].values():
        name = f["css"]
        if f.get("variable"):
            css.append(f"@font-face{{font-family:'{name}';src:url(fonts/{f['web_upright']}) format('truetype');"
                       f"font-weight:300 900;font-style:normal;font-display:swap}}")
            css.append(f"@font-face{{font-family:'{name}';src:url(fonts/{f['web_italic']}) format('truetype');"
                       f"font-weight:300 900;font-style:italic;font-display:swap}}")
        else:
            css.append(f"@font-face{{font-family:'{name}';src:url(fonts/{f['web_upright']}) format('truetype');"
                       f"font-weight:400;font-style:normal;font-display:swap}}")
            css.append(f"@font-face{{font-family:'{name}';src:url(fonts/{f['web_italic']}) format('truetype');"
                       f"font-weight:400;font-style:italic;font-display:swap}}")
            if f.get("web_bold"):
                css.append(f"@font-face{{font-family:'{name}';src:url(fonts/{f['web_bold']}) format('truetype');"
                           f"font-weight:600;font-style:normal;font-display:swap}}")
            if f.get("web_bold_italic"):
                css.append(f"@font-face{{font-family:'{name}';src:url(fonts/{f['web_bold_italic']}) format('truetype');"
                           f"font-weight:600;font-style:italic;font-display:swap}}")
    return "\n".join(css)


def mood_css(moodcfg) -> str:
    rules = []
    for mood, m in moodcfg["moods"].items():
        qf = moodcfg["fonts"][m["quote_font"]]["css"]
        bf = moodcfg["fonts"][m["body_font"]]["css"]
        style = "italic" if m["quote_style"] == "italic" else "normal"
        rules.append(
            f".mood-{mood}{{--accent:{m['accent']};--accent-dark:{m['accent_dark']};"
            f"--quote-font:'{qf}',Georgia,serif;--body-font:'{bf}',Georgia,serif;"
            f"--quote-style:{style};--quote-scale:{m['quote_scale']};"
            f"--quote-variation:{m.get('quote_variation') or 'normal'}}}")
    return "\n".join(rules)


def read_asset(name: str) -> str:
    return (ROOT / "site" / name).read_text(encoding="utf-8")


def book_line(b, *, author=True) -> str:
    """'Author · tr. X · 1859' for headers."""
    bits = [html.escape(b["author"])] if author else []
    if b.get("translator"):
        bits.append(f"tr. {html.escape(str(b['translator']))}")
    if b.get("year"):
        bits.append(html.escape(str(b["year"])))
    return " · ".join(bits)


ORNAMENT = """<svg class="ornament fleuron" width="84" height="22" viewBox="0 0 84 22" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12.5 C 14 9.5, 22 15.5, 31 11.8"/>
          <path d="M42 4 C 37.5 8.5, 38.5 15, 42.5 18.5 C 46.5 15, 47 8, 42 4 Z"/>
          <path d="M42 18.5 C 41.2 14, 41.6 9, 42.3 6.2"/>
          <path d="M53 11.2 C 62 15.5, 70 9.5, 81 12.5"/>
          <path d="M34 11 c 1.2 -1.6, 3 -1.6, 4.2 0"/>
          <path d="M46 11 c 1.2 1.6, 3 1.6, 4.2 0"/>
        </g>
      </svg>"""


def render_entry(e, moodcfg, *, prefix="", show_book=False) -> str:
    m = moodcfg["moods"][e["mood"]]
    b = e["_book"]
    where = smarten(str(e.get("where", "") or ""))
    tags = "".join(f'<span class="tag">{html.escape(t)}</span>' for t in (e.get("tags") or []))
    commentary = ""
    if str(e.get("commentary", "") or "").strip():
        commentary = f'<div class="commentary">{prose_to_html(e["commentary"])}</div>'
    date_html = (f'<time datetime="{iso_date(e.get("date"))}">{fmt_date(e.get("date"))}</time>'
                 if e.get("date") else "")
    attribution = []
    if show_book:
        attribution.append(f'<span class="dash">—</span> {html.escape(b["author"])}')
        attribution.append(f'<span class="book"><a href="{prefix}books/{b["slug"]}.html">'
                           f'{html.escape(smarten(b["title"]))}</a>'
                           + (f', {html.escape(where)}' if where else '') + '</span>')
    elif where:
        attribution.append(f'<span class="dash">—</span> {html.escape(where)}')
    attr_html = f'<p class="attribution">{" ".join(attribution)}</p>' if attribution else ""
    anchor_href = f'{prefix}books/{b["slug"]}.html#{e["_id"]}' if show_book else f'#{e["_id"]}'
    return f"""
<article class="entry mood-{e['mood']}" id="{e['_id']}" data-mood="{e['mood']}" data-book="{b['slug']}">
  <blockquote class="quote{' verse' if is_verse(e) else ''}">{quote_to_html(e['quote'], is_verse(e))}</blockquote>
  {attr_html}
  {commentary}
  <footer class="entry-meta">
    <span class="mood-label">{html.escape(m['label'])}</span>{tags}
    {date_html}
    <a class="anchor" href="{anchor_href}" title="Link to this entry">§</a>
  </footer>
  <div class="rule" aria-hidden="true"></div>
</article>"""


def page(cfg, *, title, body, depth=0, description="") -> str:
    """depth = how many folders below the impressions root (0 = impressions/, 1 = impressions/books/)."""
    prefix = "../" * depth                 # to the impressions folder
    root = "../" * (depth + 1)             # to the site root (First Principles)
    return (read_asset("template.html")
            .replace("{{prefix}}", prefix)
            .replace("{{root}}", root)
            .replace("{{stamp}}", dt.date.today().strftime("%Y%m%d"))
            .replace("{{page_title}}", html.escape(title))
            .replace("{{description}}", html.escape(description or cfg.get("subtitle", "")))
            .replace("{{body}}", body))


def write_site(cfg, books, moodcfg):
    sdir = (ROOT / cfg.get("site_dir", "../impressions")).resolve()
    bdir = ROOT / cfg.get("build_dir", "build")
    (sdir / "books").mkdir(parents=True, exist_ok=True)
    (sdir / "fonts").mkdir(exist_ok=True)
    (sdir / "pdf").mkdir(exist_ok=True)
    for f in FONT_WEB.iterdir():
        if f.suffix == ".ttf" and not (sdir / "fonts" / f.name).exists():
            shutil.copy2(f, sdir / "fonts" / f.name)

    css = (read_asset("impressions.css")
           .replace("/*{{font-faces}}*/", font_faces(moodcfg))
           .replace("/*{{mood-rules}}*/", mood_css(moodcfg)))
    (sdir / "impressions.css").write_text(css, encoding="utf-8")

    for b in books:
        seen = {}
        for e in b["entries"]:
            base = slugify(" ".join(str(e["quote"]).split()[:6]))
            n = seen.get(base, 0) + 1
            seen[base] = n
            e["_id"] = base if n == 1 else f"{base}-{n}"

    total = sum(len(b["entries"]) for b in books)
    by_recent = sorted(books, key=latest_date, reverse=True)

    # ── library (impressions/index.html) ──
    items = ""
    for b in by_recent:
        n = len(b["entries"])
        when = html.escape(f"read {fmt_read(b['read'])}") if b.get("read") else (fmt_date(latest_date(b)) if latest_date(b) else "")
        items += f"""
<li class="mood-{b['mood']}">
  <p class="when">{when} &nbsp;&mdash;&nbsp; <b>{html.escape(moodcfg['moods'][b['mood']]['label'].lower())}</b></p>
  <h2><a href="books/{b['slug']}.html">{html.escape(smarten(b['title']))}</a></h2>
  <p>{book_line(b)} <span class="sep">&middot;</span> {n} {'entry' if n == 1 else 'entries'}</p>
</li>"""
    body = f"""
<p class="eyebrow">{html.escape(cfg.get('subtitle', 'What the books left behind'))}</p>
<h1 class="pagetitle">{html.escape(cfg['title'])}</h1>
<p class="meta">{len(books)} {'book' if len(books) == 1 else 'books'}<span class="sep">&middot;</span>{total} {'entry' if total == 1 else 'entries'}<span class="sep">&middot;</span><a href="entries.html">all entries in one stream &rarr;</a></p>
{ORNAMENT}
<ul class="booklist">{items}</ul>"""
    (sdir / "index.html").write_text(page(cfg, title=cfg["title"], body=body), encoding="utf-8")

    # ── all entries (impressions/entries.html) ──
    all_entries = sorted((e for b in books for e in b["entries"]),
                         key=lambda e: iso_date(e.get("date")), reverse=True)
    used = sorted({e["mood"] for e in all_entries}, key=list(moodcfg["moods"]).index)
    chips = "".join(
        f'<button type="button" class="mood-{m}" data-filter="{m}" aria-pressed="false">'
        f'{html.escape(moodcfg["moods"][m]["label"].lower())}</button>' for m in used)
    body = f"""
<p class="eyebrow"><a href="./">{html.escape(cfg['title'])}</a></p>
<h1 class="pagetitle">All entries</h1>
<p class="meta">{total} {'entry' if total == 1 else 'entries'}, newest first</p>
{ORNAMENT}
<div class="topics"><span class="lbl">moods</span>
  <button type="button" data-filter="all" aria-pressed="true">all</button>{chips}
</div>
<div class="entries">{"".join(render_entry(e, moodcfg, show_book=True) for e in all_entries)}</div>
<p class="empty" hidden>Nothing here with that mood yet.</p>"""
    (sdir / "entries.html").write_text(page(cfg, title="All entries", body=body), encoding="utf-8")

    # ── one page per book ──
    for b in books:
        entries = sorted(b["entries"], key=lambda e: iso_date(e.get("date")))
        pdf_src = bdir / f"{b['slug']}.pdf"
        pdf_link = ""
        if pdf_src.exists():
            shutil.copy2(pdf_src, sdir / "pdf" / f"{b['slug']}.pdf")
            pdf_link = f'<span class="sep">&middot;</span><a class="pdflink" href="../pdf/{b["slug"]}.pdf">typeset pdf</a>'
        notes = (f'<div class="book-notes">{prose_to_html(b["notes"])}</div>'
                 if str(b.get("notes", "") or "").strip() else "")
        read = f'<span class="sep">&middot;</span>read {html.escape(fmt_read(b["read"]))}' if b.get("read") else ""
        n = len(entries)
        body = f"""
<div class="mood-{b['mood']}">
<p class="eyebrow"><a href="../">{html.escape(cfg['title'])}</a></p>
<h1 class="pagetitle booktitle">{html.escape(smarten(b['title']))}</h1>
<p class="meta">{book_line(b)}{read}<span class="sep">&middot;</span>{n} {'entry' if n == 1 else 'entries'}{pdf_link}</p>
{ORNAMENT}
{notes}
<div class="entries">{"".join(render_entry(e, moodcfg, prefix="../") for e in entries)}</div>
</div>"""
        (sdir / "books" / f"{b['slug']}.html").write_text(
            page(cfg, title=b["title"], body=body, depth=1,
                 description=f"Quotes and notes from {b['title']} by {b['author']}."), encoding="utf-8")

    live = {f"{b['slug']}.html" for b in books}
    for f in (sdir / "books").glob("*.html"):
        if f.name not in live:
            f.unlink()
    print(f"✓ site: {sdir}  ({len(books)} books, {total} entries)")


# ─────────────────────────────────────────────────────────────────────────────
#  Interactive entry
# ─────────────────────────────────────────────────────────────────────────────
def _q(v: str) -> str:
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _block(key, text, indent) -> str:
    return f"{indent}{key}: |\n" + "".join(f"{indent}  {l}\n" for l in text.splitlines())


def create_book(title, author, mood, translator="", year="", read=None) -> Path:
    """Write a fresh books/<slug>.yaml and return its path."""
    BOOKS_DIR.mkdir(exist_ok=True)
    path = BOOKS_DIR / f"{slugify(title)}.yaml"
    if path.exists():
        raise FileExistsError(f"{path.name} already exists")
    text = f"title: {_q(title)}\nauthor: {_q(author)}\n"
    if translator:
        text += f"translator: {_q(translator)}\n"
    if year:
        text += f"year: {_q(str(year))}\n"
    text += f"mood: {mood}\nread: {read or dt.date.today().strftime('%Y-%m')}\n\nentries:\n"
    path.write_text(text, encoding="utf-8")
    return path


def append_entry(path: Path, quote, where="", mood="", commentary="", tags=(), verse=None, date=None):
    """Append one entry to an existing book file."""
    out = "  - quote: |\n" + "".join(f"      {l}\n" for l in quote.strip("\n").splitlines())
    if where:
        out += f"    where: {_q(where)}\n"
    out += f"    date: {(date or dt.date.today()).isoformat()}\n"
    if mood:
        out += f"    mood: {mood}\n"
    if verse is not None:
        out += f"    verse: {'true' if verse else 'false'}\n"
    tags = [t.strip() for t in tags if t.strip()]
    if tags:
        out += "    tags: [" + ", ".join(tags) + "]\n"
    if commentary.strip():
        out += _block("commentary", commentary.strip("\n"), "    ")
    text = path.read_text(encoding="utf-8")
    if "\nentries:" not in text and not text.startswith("entries:"):
        text = text.rstrip("\n") + "\n\nentries:\n"
    if not text.endswith("\n"):
        text += "\n"
    path.write_text(text + "\n" + out, encoding="utf-8")


def new_entry(moodcfg):
    """Terminal prompts for a new entry; create the book file first if needed."""
    def ask(label, multi=False):
        if not multi:
            return input(f"  {label}: ").strip()
        print(f"  {label} (blank line to finish):")
        lines = []
        while True:
            l = input("    ")
            if not l.strip():
                break
            lines.append(l)
        return "\n".join(lines)

    BOOKS_DIR.mkdir(exist_ok=True)
    books = sorted(BOOKS_DIR.glob("*.yaml"))
    print("Which book?")
    for i, p in enumerate(books, 1):
        b = load_yaml(p) or {}
        print(f"  {i:2d}. {b.get('title', p.stem)} — {b.get('author', '')}")
    print("   n. a new book")
    choice = input("  > ").strip().lower()
    moods = list(moodcfg["moods"])

    if choice == "n" or not books:
        print("New book:")
        title = ask("title")
        author = ask("author")
        mood = ask(f"mood [{'/'.join(moods)}]") or moodcfg.get("default_mood", moods[0])
        path = create_book(title, author, mood, ask("translator"), ask("year"))
        print(f"✓ created {path.relative_to(ROOT)}")
    else:
        try:
            path = books[int(choice) - 1]
        except (ValueError, IndexError):
            sys.exit("no such book")

    print("New entry:")
    quote = ask("quote", multi=True)
    where = ask("where (page/chapter)")
    mood = ask("mood override (blank = book's mood)")
    commentary = ask("commentary", multi=True)
    tags = ask("tags (comma-separated)").split(",")
    append_entry(path, quote, where, mood, commentary, tags)
    print(f"✓ appended to {path.relative_to(ROOT)} — run build.py to regenerate.")


def build(*, pdf=False, engine=None, only_slug=None, all_pdfs=False) -> list[str]:
    """Programmatic build used by app.py. Returns log lines; raises on failure."""
    log = []
    cfg = load_yaml(ROOT / "config.yaml")
    moodcfg = load_yaml(ROOT / "moods.yaml")
    books = load_books(moodcfg["moods"])
    mains = write_latex(cfg, books, moodcfg)
    log.append(f"latex: {len(mains)} documents")
    if pdf:
        eng = engine or cfg.get("engine", "auto")
        for b, main in zip(books, mains):
            if only_slug and b["slug"] != only_slug and not all_pdfs:
                continue
            compile_pdf(main, eng)
            log.append(f"pdf: {main.with_suffix('.pdf').name}")
    write_site(cfg, books, moodcfg)
    log.append(f"site: {len(books)} books, {sum(len(b['entries']) for b in books)} entries")
    return log


# ─────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf", action="store_true", help="compile PDFs after generating LaTeX")
    ap.add_argument("--all", action="store_true", help="with --pdf: recompile every book, not just changed ones")
    ap.add_argument("--check", action="store_true", help="validate books/*.yaml and exit")
    ap.add_argument("--new", action="store_true", help="interactively add an entry (or a new book)")
    ap.add_argument("--engine", default=None, help="lualatex, xelatex or auto (default); overrides config.yaml")
    ap.add_argument("--no-site", action="store_true")
    ap.add_argument("--no-latex", action="store_true")
    args = ap.parse_args()

    cfg = load_yaml(ROOT / "config.yaml")
    moodcfg = load_yaml(ROOT / "moods.yaml")
    if args.new:
        new_entry(moodcfg)
        return

    books = load_books(moodcfg["moods"])
    total = sum(len(b["entries"]) for b in books)
    print(f"✓ {len(books)} books, {total} entries valid")
    if args.check:
        return

    if not args.no_latex:
        mains = write_latex(cfg, books, moodcfg)
        print(f"✓ latex: {len(mains)} documents in {cfg.get('build_dir', 'build')}/")
        if args.pdf:
            engine = args.engine or cfg.get("engine", "auto")
            for b, main in zip(books, mains):
                pdf = main.with_suffix(".pdf")
                stale = (args.all or not pdf.exists() or pdf.stat().st_mtime < b["_mtime"]
                         or pdf.stat().st_mtime < max((ROOT / "latex" / "preamble.tex").stat().st_mtime,
                                                      (ROOT / "moods.yaml").stat().st_mtime))
                if stale:
                    compile_pdf(main, engine)
                else:
                    print("·", pdf.relative_to(ROOT), "(up to date)")
    if not args.no_site:
        write_site(cfg, books, moodcfg)


if __name__ == "__main__":
    try:
        main()
    except BuildError as ex:
        sys.exit(str(ex))
