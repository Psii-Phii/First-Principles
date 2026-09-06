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
    tex = B.shutil.which(cfg.get("engine", "lualatex")) or B.shutil.which("xelatex")
    git_ok = (REPO / ".git").exists()
    return {"books": books, "moods": moods, "default_mood": moodcfg.get("default_mood"),
            "tex": bool(tex), "git": git_ok, "repo": str(REPO), "title": cfg.get("title", "Commonplace")}


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
        git("add", "-A", "commonplace", "commonplace-src")
        status = git("status", "--porcelain")
        if status.strip():
            git("commit", "-q", "-m", f"Commonplace: add entry to {title}")
            log.append("committed")
            out = git("push")
            log.append("pushed" + (f" — {out.splitlines()[-1]}" if out else ""))
        else:
            log.append("nothing to commit")
    return {"ok": True, "log": log, "slug": path.stem}


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
        # assets straight from the generated site, so the preview uses the real fonts/CSS
        site = (ROOT / B.load_yaml(ROOT / "config.yaml").get("site_dir", "../commonplace")).resolve()
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
    if not (ROOT / "../commonplace/commonplace.css").resolve().exists():
        try:
            B.build(pdf=False)
        except B.BuildError as ex:
            print(ex, file=sys.stderr)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"Commonplace — {url}   (Ctrl-C to stop)")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
