#!/usr/bin/env python3
"""
app.py — the "just type the quote" interface.

    python3 app.py            # opens http://localhost:8765 in your browser
    python3 app.py --port 9000 --no-browser

One page: pick a book (or start a new one), paste the quote, add commentary if
you like, hit Save. The app writes the YAML, rebuilds the site (and that book's
PDF if TeX is installed), then commits and pushes the First Principles repo.
Nothing here needs a server on the internet; it runs only while you use it.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import subprocess
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build as B  # noqa: E402

ROOT = B.ROOT
REPO = ROOT.parent
LOCK = threading.Lock()


# ─────────────────────────────────────────────────────────────────────────────
#  Helpers
# ─────────────────────────────────────────────────────────────────────────────
def state() -> dict:
    moodcfg = B.load_yaml(ROOT / "moods.yaml")
    cfg = B.load_yaml(ROOT / "config.yaml")
    books = []
    for path in sorted(B.BOOKS_DIR.glob("*.yaml")):
        try:
            b = B.load_yaml(path) or {}
        except Exception:
            b = {}
        books.append({"slug": path.stem, "title": b.get("title", path.stem), "author": b.get("author", ""),
                      "mood": b.get("mood", moodcfg.get("default_mood")),
                      "count": len(b.get("entries") or [])})
    books.sort(key=lambda b: b["title"].lower())
    moods = {k: {"label": m["label"], "quote_font": moodcfg["fonts"][m["quote_font"]]["css"],
                 "body_font": moodcfg["fonts"][m["body_font"]]["css"], "style": m["quote_style"],
                 "scale": m["quote_scale"], "accent": m["accent"],
                 "variation": m.get("quote_variation") or "normal"}
             for k, m in moodcfg["moods"].items()}
    tex = B.shutil.which(B.pick_engine(cfg.get("engine", "auto")))
    git_ok = (REPO / ".git").exists()
    return {"books": books, "moods": moods, "default_mood": moodcfg.get("default_mood"),
            "tex": bool(tex), "git": git_ok, "repo": str(REPO), "title": cfg.get("title", "Impressions")}


def git(*args) -> str:
    r = subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)
    if r.returncode != 0:
        raise B.BuildError(f"git {' '.join(args)} failed:\n{r.stderr.strip() or r.stdout.strip()}")
    return (r.stdout + r.stderr).strip()


def save(payload: dict) -> dict:
    log = []
    quote = (payload.get("quote") or "").strip()
    if not quote:
        raise B.BuildError("The quote is empty.")

    if payload.get("new_book"):
        nb = payload["new_book"]
        if not (nb.get("title") or "").strip() or not (nb.get("author") or "").strip():
            raise B.BuildError("A new book needs a title and an author.")
        try:
            path = B.create_book(nb["title"].strip(), nb["author"].strip(),
                                 nb.get("mood") or state()["default_mood"],
                                 (nb.get("translator") or "").strip(), (nb.get("year") or "").strip())
        except FileExistsError as ex:
            raise B.BuildError(str(ex))
        log.append(f"created books/{path.name}")
    else:
        path = B.BOOKS_DIR / f"{payload.get('book', '')}.yaml"
        if not path.exists():
            raise B.BuildError("Pick a book first.")

    book = B.load_yaml(path) or {}
    mood = payload.get("mood") or ""
    if mood == book.get("mood"):
        mood = ""  # same as the book's default: don't clutter the file
    verse = payload.get("verse")
    if verse is not None:
        default_verse = (mood or book.get("mood")) == "poetry"
        verse = None if bool(verse) == default_verse else bool(verse)
    tags = [t for t in (payload.get("tags") or "").split(",")]
    before = path.read_text(encoding="utf-8")
    B.append_entry(path, quote, (payload.get("where") or "").strip(), mood,
                   payload.get("commentary") or "", tags, verse)
    log.append(f"appended entry to books/{path.name}")

    # Validate before we rebuild anything; roll back the append on failure.
    try:
        B.load_books(B.load_yaml(ROOT / "moods.yaml")["moods"])
    except B.BuildError:
        path.write_text(before, encoding="utf-8")
        raise

    do_pdf = bool(payload.get("pdf", True)) and state()["tex"]
    try:
        log += B.build(pdf=do_pdf, only_slug=path.stem)
    except B.BuildError as ex:
        # PDF failures shouldn't lose the entry; fall back to the site only.
        tail = "\n".join(l for l in str(ex).splitlines() if l.startswith("!") or "error" in l.lower())[-600:]
        log.append("PDF build failed — the site was still rebuilt. " + (tail or str(ex)[-400:]))
        log += B.build(pdf=False)

    if payload.get("publish"):
        title = book.get("title") or path.stem
        git("add", "-A", "impressions", "impressions-src")
        status = git("status", "--porcelain")
        if status.strip():
            git("commit", "-q", "-m", f"Impressions: add entry to {title}")
            log.append("committed")
            out = git("push")
            log.append("pushed" + (f" — {out.splitlines()[-1]}" if out else ""))
        else:
            log.append("nothing to commit")
    return {"ok": True, "log": log, "slug": path.stem}


def _clean_entry(e: dict) -> dict:
    """Strip the private keys load_books adds, keep only what belongs in the file."""
    keep = ("quote", "where", "date", "mood", "verse", "tags", "commentary")
    return {k: e[k] for k in keep if k in e and e[k] not in (None, "")}


def list_entries(slug: str) -> dict:
    path = B.BOOKS_DIR / f"{slug}.yaml"
    if not path.exists():
        raise B.BuildError("No such book.")
    book = B.load_yaml(path) or {}
    out = []
    for i, e in enumerate(book.get("entries") or []):
        out.append({"index": i, "quote": str(e.get("quote", "")).strip("\n"), "where": e.get("where") or "",
                    "mood": e.get("mood") or "", "verse": e.get("verse"), "tags": ", ".join(e.get("tags") or []),
                    "commentary": str(e.get("commentary", "") or "").strip("\n"),
                    "date": B.iso_date(e.get("date")) if e.get("date") else ""})
    return {"ok": True, "book": {"title": book.get("title"), "mood": book.get("mood")}, "entries": out}


def _rebuild_and_publish(path: Path, payload: dict, log: list, message: str):
    do_pdf = bool(payload.get("pdf", True)) and state()["tex"]
    try:
        log += B.build(pdf=do_pdf, only_slug=path.stem)
    except B.BuildError as ex:
        tail = "\n".join(l for l in str(ex).splitlines() if l.startswith("!") or "error" in l.lower())[-600:]
        log.append("PDF build failed — the site was still rebuilt. " + (tail or str(ex)[-400:]))
        log += B.build(pdf=False)
    if payload.get("publish"):
        git("add", "-A", str((ROOT / B.load_yaml(ROOT / "config.yaml").get("site_dir", "../impressions")).resolve().relative_to(REPO)),
            str(ROOT.relative_to(REPO)))
        if git("status", "--porcelain").strip():
            git("commit", "-q", "-m", message)
            log.append("committed")
            git("push")
            log.append("pushed")
        else:
            log.append("nothing to commit")


def update_entry(payload: dict) -> dict:
    path = B.BOOKS_DIR / f"{payload.get('book', '')}.yaml"
    if not path.exists():
        raise B.BuildError("No such book.")
    book = B.load_yaml(path) or {}
    entries = book.get("entries") or []
    try:
        i = int(payload.get("index"))
        old = entries[i]
    except (TypeError, ValueError, IndexError):
        raise B.BuildError("That entry no longer exists — reload the page.")
    quote = (payload.get("quote") or "").strip()
    if not quote:
        raise B.BuildError("The quote is empty.")
    mood = payload.get("mood") or ""
    if mood == book.get("mood"):
        mood = ""
    verse = payload.get("verse")
    if verse is not None:
        default_verse = (mood or book.get("mood")) == "poetry"
        verse = None if bool(verse) == default_verse else bool(verse)
    new = {"quote": quote, "where": (payload.get("where") or "").strip(), "date": old.get("date"),
           "mood": mood, "verse": verse,
           "tags": [t.strip() for t in (payload.get("tags") or "").split(",") if t.strip()],
           "commentary": payload.get("commentary") or ""}
    entries[i] = _clean_entry(new)
    book["entries"] = [_clean_entry(e) for e in entries]
    before = path.read_text(encoding="utf-8")
    B.write_book(path, book)
    try:
        B.load_books(B.load_yaml(ROOT / "moods.yaml")["moods"])
    except B.BuildError:
        path.write_text(before, encoding="utf-8")
        raise
    log = [f"updated entry {i + 1} in books/{path.name}"]
    _rebuild_and_publish(path, payload, log, f"Impressions: edit an entry in {book.get('title') or path.stem}")
    return {"ok": True, "log": log, "slug": path.stem}


def delete_entry(payload: dict) -> dict:
    path = B.BOOKS_DIR / f"{payload.get('book', '')}.yaml"
    if not path.exists():
        raise B.BuildError("No such book.")
    book = B.load_yaml(path) or {}
    entries = book.get("entries") or []
    try:
        i = int(payload.get("index"))
        entries.pop(i)
    except (TypeError, ValueError, IndexError):
        raise B.BuildError("That entry no longer exists — reload the page.")
    book["entries"] = [_clean_entry(e) for e in entries]
    B.write_book(path, book)
    log = [f"removed entry {i + 1} from books/{path.name}"]
    _rebuild_and_publish(path, payload, log, f"Impressions: remove an entry from {book.get('title') or path.stem}")
    return {"ok": True, "log": log, "slug": path.stem}


def delete_book(payload: dict) -> dict:
    slug = payload.get("book") or ""
    path = B.BOOKS_DIR / f"{slug}.yaml"
    if not slug or not path.exists():
        raise B.BuildError("No such book.")
    book = B.load_yaml(path) or {}
    title = book.get("title") or slug
    if (payload.get("confirm") or "").strip().lower() != title.strip().lower():
        raise B.BuildError("Type the book's title exactly to confirm.")
    log = []
    path.unlink()
    log.append(f"deleted books/{path.name}")
    cfg = B.load_yaml(ROOT / "config.yaml")
    site = (ROOT / cfg.get("site_dir", "../impressions")).resolve()
    for f in [site / "pdf" / f"{slug}.pdf", site / "books" / f"{slug}.html",
              *(ROOT / cfg.get("build_dir", "build")).glob(f"{slug}.*")]:
        if f.exists():
            f.unlink()
    remaining = list(B.BOOKS_DIR.glob("*.yaml"))
    if remaining:
        log += B.build(pdf=False)
    else:
        log.append("no books left — the section is empty until you add one")
    if payload.get("publish"):
        git("add", "-A", str(site.relative_to(REPO)), str(ROOT.relative_to(REPO)))
        if git("status", "--porcelain").strip():
            git("commit", "-q", "-m", f"Impressions: remove {title}")
            log.append("committed")
            git("push")
            log.append("pushed")
    return {"ok": True, "log": log}


# ─────────────────────────────────────────────────────────────────────────────
#  HTTP
# ─────────────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  %s\n" % (args[0],))

    def _send(self, code, body: bytes, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            return self._send(200, (ROOT / "site" / "app.html").read_bytes())
        if path == "/api/state":
            return self._json(state())
        if path == "/api/entries":
            from urllib.parse import parse_qs
            slug = (parse_qs(urlparse(self.path).query).get("book") or [""])[0]
            try:
                return self._json(list_entries(slug))
            except B.BuildError as ex:
                return self._json({"ok": False, "error": str(ex)}, 400)
        # assets straight from the generated site, so the preview uses the real fonts/CSS
        site = (ROOT / B.load_yaml(ROOT / "config.yaml").get("site_dir", "../impressions")).resolve()
        if path.startswith("/site/"):
            f = (site / path[len("/site/"):]).resolve()
            if site in f.parents and f.is_file():
                ctype = mimetypes.guess_type(str(f))[0] or "application/octet-stream"
                return self._send(200, f.read_bytes(), ctype)
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = urlparse(self.path).path
        n = int(self.headers.get("Content-Length") or 0)
        try:
            payload = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._json({"ok": False, "error": "bad JSON"}, 400)
        if path == "/api/save":
            with LOCK:
                try:
                    return self._json(save(payload))
                except B.BuildError as ex:
                    return self._json({"ok": False, "error": str(ex)}, 400)
                except Exception:
                    return self._json({"ok": False, "error": traceback.format_exc()}, 500)
        for route, fn in (("/api/update", update_entry), ("/api/delete_entry", delete_entry)):
            if path == route:
                with LOCK:
                    try:
                        return self._json(fn(payload))
                    except B.BuildError as ex:
                        return self._json({"ok": False, "error": str(ex)}, 400)
                    except Exception:
                        return self._json({"ok": False, "error": traceback.format_exc()}, 500)
        if path == "/api/delete_book":
            with LOCK:
                try:
                    return self._json(delete_book(payload))
                except B.BuildError as ex:
                    return self._json({"ok": False, "error": str(ex)}, 400)
                except Exception:
                    return self._json({"ok": False, "error": traceback.format_exc()}, 500)
        if path == "/api/build":
            with LOCK:
                try:
                    return self._json({"ok": True, "log": B.build(pdf=bool(payload.get("pdf")), all_pdfs=True)})
                except B.BuildError as ex:
                    return self._json({"ok": False, "error": str(ex)}, 400)
        self._json({"ok": False, "error": "unknown endpoint"}, 404)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    # Make sure the site (and its fonts, used by the preview) exists.
    if not (ROOT / "../impressions/impressions.css").resolve().exists():
        try:
            B.build(pdf=False)
        except B.BuildError as ex:
            print(ex, file=sys.stderr)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"Impressions — {url}   (Ctrl-C to stop)")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
