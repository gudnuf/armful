"""Capture time of one photo or video, as integer unix seconds (UTC), or None.

Photos: EXIF DateTimeOriginal. With OffsetTimeOriginal the time is exact; without it
the camera's clock is taken as local time in the collection's zone (collection.json
"tz"; UTC when there is none). Videos: ffprobe's container `creation_time`, which
QuickTime/MP4 store in UTC. No usable time gives None: the file's modification
time is never used (a download or a copy resets it).
"""
import datetime as dt
import json
import shutil
import subprocess
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from PIL import Image

try:  # HEIC/HEIF photos (optional: without it they get no time)
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

EXIF_IFD = 0x8769
DATETIME_ORIGINAL = 36867
OFFSET_TIME_ORIGINAL = 36881
EARLIEST = 946684800  # 2000-01-01: anything before is an unset clock (QuickTime's 1904, unix 0)


def zone(name):
    """ZoneInfo for an IANA name; ValueError if it is not one."""
    if not isinstance(name, str) or not name:
        raise ValueError(f"not a time zone name: {name!r}")
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ValueError(f"unknown time zone {name!r}") from e


def _clean(v):
    if isinstance(v, bytes):
        v = v.decode("ascii", "replace")
    return v.strip().strip("\x00").strip() if isinstance(v, str) else ""


def _sane(t):
    return t if t is not None and EARLIEST <= t < 4102444800 else None  # before 2100


def exif_time(path, tz):
    """DateTimeOriginal (+ OffsetTimeOriginal) of an image file, or None."""
    try:
        with Image.open(path) as im:
            ifd = im.getexif().get_ifd(EXIF_IFD)
            raw, off = _clean(ifd.get(DATETIME_ORIGINAL)), _clean(ifd.get(OFFSET_TIME_ORIGINAL))
    except Exception:  # noqa: BLE001  unreadable or no EXIF
        return None
    try:
        t = dt.datetime.strptime(raw[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None  # missing, or blank "0000:00:00 00:00:00"
    if off:
        try:
            sign = -1 if off[0] == "-" else 1
            hh, mm = off.lstrip("+-").split(":")
            t = t.replace(tzinfo=dt.timezone(sign * dt.timedelta(hours=int(hh), minutes=int(mm))))
        except (ValueError, IndexError):
            t = t.replace(tzinfo=tz)
    else:
        t = t.replace(tzinfo=tz)
    return _sane(int(t.timestamp()))


def ffprobe_path(name="ffprobe"):
    return shutil.which(name)


def video_time(path, ffprobe):
    """Container creation_time (UTC) via ffprobe, or None."""
    if not ffprobe:
        return None
    try:
        r = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", path],
            capture_output=True, text=True, timeout=60,
        )
        raw = json.loads(r.stdout or "{}").get("format", {}).get("tags", {}).get("creation_time", "")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    raw = _clean(raw)
    if not raw:
        return None
    try:
        t = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return _sane(int(t.timestamp()))
