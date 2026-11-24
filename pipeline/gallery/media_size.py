"""Display size (width, height) of one photo or video, read from the file itself, or None.

For the files the scan recorded without a usable size (0 x 0, empty): the page lays out
every tile by its aspect ratio, so a file is never published with a width or height <= 0.

Photos: Pillow's pixel size, swapped when the EXIF orientation turns the picture a
quarter (orientations 5-8), so it is the size the photo is shown at. Videos: ffprobe's
first video stream, swapped when its rotation (display matrix side data, or the older
`rotate` tag) is a quarter turn (+-90, +-270).
"""
import json
import subprocess

from PIL import Image

import capture_time  # noqa: F401  (registers the HEIC/HEIF opener when pillow-heif is there)

ORIENTATION = 274
QUARTER_TURNS = (5, 6, 7, 8)  # EXIF orientations that swap width and height


def dim(v):
    """A scan's width/height cell as an int; anything unusable is 0."""
    try:
        return int(float(v))
    except (TypeError, ValueError, OverflowError):
        return 0


def _ok(w, h):
    return (w, h) if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0 else None


def image_size(path):
    try:
        with Image.open(path) as im:
            w, h = im.size
            if im.getexif().get(ORIENTATION, 1) in QUARTER_TURNS:
                w, h = h, w
    except Exception:  # noqa: BLE001  (unreadable, unsupported, truncated: unknown)
        return None
    return _ok(w, h)


def _rotation(stream):
    for sd in stream.get("side_data_list") or []:
        if isinstance(sd, dict) and "rotation" in sd:
            return sd["rotation"]
    return (stream.get("tags") or {}).get("rotate", 0)


def video_size(path, ffprobe):
    if not ffprobe:
        return None
    try:
        r = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-select_streams", "v:0", "-show_streams", path],
            capture_output=True, text=True, timeout=60,
        )
        streams = json.loads(r.stdout or "{}").get("streams") or []
        s = streams[0]
        w, h = s.get("width"), s.get("height")
        rot = int(float(_rotation(s) or 0))
    except (OSError, ValueError, TypeError, IndexError, AttributeError, subprocess.TimeoutExpired):
        return None
    if rot % 180 == 90:  # -90 % 180 == 90 in Python, as is 270
        w, h = h, w
    return _ok(w, h)


def probe(path, kind, ffprobe):
    """(w, h) of the file at `path` ("photo" or "video"), or None when it cannot be told."""
    return video_size(path, ffprobe) if kind == "video" else image_size(path)
