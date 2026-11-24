#!/usr/bin/env python3
"""List every file in a public Google Drive folder, recursively.

Uses the embeddedfolderview page, which (unlike gdown --folder's parse of the
main folder page) is not capped at 50 entries. Stdlib only.

usage: python3 -I pipeline/scan/list_drive.py FOLDER_ID OUT.tsv
Output columns: id, name, mime, subfolder (relative path, '' for root)
"""
import html
import re
import sys
import time
import urllib.request

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
ENTRY = re.compile(
    r'<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)".*?<a href="([^"]+)".*?'
    r'<div class="flip-entry-list-icon"><img src="([^"]*)".*?'
    r'<div class="flip-entry-title">([^<]*)</div>',
    re.S,
)


def fetch(url, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            time.sleep(2 ** i)
            print(f"retry {url}: {e}", file=sys.stderr)


def walk(folder_id, rel, out, seen):
    if folder_id in seen:
        return
    seen.add(folder_id)
    page = fetch(f"https://drive.google.com/embeddedfolderview?id={folder_id}")
    n = 0
    for fid, href, icon, title in ENTRY.findall(page):
        name = html.unescape(title).strip()
        n += 1
        if "/folders/" in href or "folder" in icon.rsplit("/", 2)[-1]:
            sub = f"{rel}/{name}" if rel else name
            walk(fid, sub.replace("\t", " "), out, seen)
            continue
        m = re.search(r"/type/(.+)$", icon)
        mime = m.group(1) if m else ""
        out.append((fid, name, mime, rel))
    print(f"[{rel or '/'}] {n} entries", file=sys.stderr)
    time.sleep(1)


def main():
    folder_id, out_path = sys.argv[1], sys.argv[2]
    rows = []
    walk(folder_id, "", rows, set())
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("id\tname\tmime\tsubfolder\n")
        for r in rows:
            f.write("\t".join(x.replace("\t", " ") for x in r) + "\n")
    print(f"{len(rows)} files -> {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
