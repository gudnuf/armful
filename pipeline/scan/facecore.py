"""Shared local face pipeline: InsightFace buffalo_l on ONNX Runtime (CPU).

No network after the one-time model download to ~/.insightface/models/buffalo_l.
"""
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except ImportError:  # pragma: no cover
    pass

def _need(name, what):
    """An env var the pipeline cannot run without (no default: paths are local to each machine)."""
    v = os.environ.get(name)
    if not v:
        sys.exit(f"{name} is not set: {what}")
    return os.path.expanduser(v)


HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = _need("ARMFUL_SCAN_ROOT", "the folder holding the scan output (data/, crops/)")
DATA = os.path.join(ROOT, "data")  # git-ignored: embeddings, face tables
CROPS = os.path.join(ROOT, "crops")  # git-ignored: face crops
FOOTAGE = _need("ARMFUL_FOOTAGE", "the local copy of the collection's photos and videos (drive/ inside it)")
DRIVE = os.path.join(FOOTAGE, "drive")
WORK = os.path.join(FOOTAGE, "work")  # converted DNG etc.

IMG_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".dng", ".webp", ".tif", ".tiff"}
VID_EXT = {".mov", ".mp4", ".m4v", ".avi", ".mkv"}
MAX_SIDE = 2560  # downscale big photos before detection (keeps memory flat)

_app = None


def app():
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis

        a = FaceAnalysis(
            name="buffalo_l",
            allowed_modules=["detection", "recognition"],
            providers=["CPUExecutionProvider"],
        )
        a.prepare(ctx_id=-1, det_size=(1024, 1024), det_thresh=0.5)
        _app = a
    return _app


def load_image(path):
    """Return an RGB->BGR numpy image with EXIF orientation applied, plus scale."""
    ext = os.path.splitext(path)[1].lower()
    src = path
    if ext == ".dng":
        os.makedirs(os.path.join(WORK, "dng"), exist_ok=True)
        out = os.path.join(WORK, "dng", os.path.basename(path) + ".jpg")
        if not os.path.exists(out):
            subprocess.run(
                ["/usr/bin/sips", "-s", "format", "jpeg", path, "--out", out],
                check=True,
                capture_output=True,
            )
        src = out
    im = Image.open(src)
    im = ImageOps.exif_transpose(im).convert("RGB")
    w, h = im.size
    scale = 1.0
    if max(w, h) > MAX_SIDE:
        scale = MAX_SIDE / max(w, h)
        im = im.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
    arr = np.asarray(im)[:, :, ::-1].copy()
    return arr, scale, (w, h)


def sharpness(bgr, box):
    """Variance of Laplacian on the face crop normalised to 112 px (scale-free)."""
    x1, y1, x2, y2 = [int(round(v)) for v in box]
    h, w = bgr.shape[:2]
    x1, y1, x2, y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
    if x2 - x1 < 4 or y2 - y1 < 4:
        return 0.0
    g = cv2.cvtColor(bgr[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, (112, 112), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def image_sharpness(bgr):
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    s = 1024 / max(g.shape)
    if s < 1:
        g = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def save_crop(bgr, box, path, size=160):
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = max(x2 - x1, y2 - y1) * 0.75
    h, w = bgr.shape[:2]
    a, b = int(max(0, cx - half)), int(max(0, cy - half))
    c, d = int(min(w, cx + half)), int(min(h, cy + half))
    crop = bgr[b:d, a:c]
    if crop.size == 0:
        return
    crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    cv2.imwrite(path, crop, [cv2.IMWRITE_JPEG_QUALITY, 85])


def faces(bgr):
    """Detect + embed. Returns list of dicts (box in this image's coordinates)."""
    out = []
    for f in app().get(bgr):
        out.append(
            {
                "box": [float(v) for v in f.bbox],
                "det": float(f.det_score),
                "emb": f.normed_embedding.astype(np.float32),
            }
        )
    return out


def video_frames(path, every_s=4.0, max_frames=30):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    dur = n / fps if n else 0
    step = max(every_s, dur / max_frames) if dur else every_s
    t = 0.5
    while (not dur or t < dur) and max_frames > 0:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            break
        h, w = frame.shape[:2]
        s = 1.0
        if max(h, w) > 1920:
            s = 1920 / max(h, w)
            frame = cv2.resize(frame, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        yield t, frame
        t += step
        max_frames -= 1
    cap.release()


# ---- orientation: inverted / strongly rolled faces -------------------------------------------
# ArcFace embeddings of upside-down faces are poor (the detector's landmarks on them are
# unreliable, so the alignment is wrong) and they cluster with strangers. Every face gets a
# roll estimate; faces rolled more than ROLL_MAX are re-embedded from an upright-rotated patch,
# or dropped from clustering when no upright face can be found there.
ROLL_MAX = 60.0  # degrees; beyond this a face is re-embedded upright or dropped
PATCH = 320  # px; the face is ~1/3 of the patch side, the size the detector likes


def patch(bgr, box, size=PATCH, margin=3.0):
    """Square region centred on the face box (side = margin x the box), black-padded, resized."""
    x1, y1, x2, y2 = box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = max(x2 - x1, y2 - y1) * margin / 2
    a, b, c, d = (int(round(v)) for v in (cx - half, cy - half, cx + half, cy + half))
    h, w = bgr.shape[:2]
    out = np.zeros((d - b, c - a, 3), np.uint8)
    sa, sb, sc, sd = max(a, 0), max(b, 0), min(c, w), min(d, h)
    if sc > sa and sd > sb:
        out[sb - b : sd - b, sa - a : sc - a] = bgr[sb:sd, sa:sc]
    return cv2.resize(out, (size, size), interpolation=cv2.INTER_AREA if out.shape[0] > size else cv2.INTER_LINEAR)


def patch_from_crop(crop):
    """The same geometry from a saved 160 px review crop (1.5x the box): pad it to 3x."""
    h, w = crop.shape[:2]
    big = cv2.copyMakeBorder(crop, h // 2, h // 2, w // 2, w // 2, cv2.BORDER_CONSTANT)
    return cv2.resize(big, (PATCH, PATCH), interpolation=cv2.INTER_LINEAR)


def _rot(img, deg):
    """Rotate counter-clockwise (as seen) about the centre, same size."""
    if not deg:
        return img
    h, w = img.shape[:2]
    return cv2.warpAffine(img, cv2.getRotationMatrix2D((w / 2, h / 2), deg, 1.0), (w, h))


def _central_face(img, min_score=0.3):
    """Detect on a patch; return (score, kps, bbox) of the face nearest the centre, or None."""
    det = app().det_model
    n = img.shape[0] // 32 * 32
    boxes, kpss = det.detect(img, input_size=(n, n), max_num=0, metric="default")
    best, bd = None, 1e9
    c = img.shape[0] / 2
    for bb, kp in zip(boxes, kpss):
        if bb[4] < min_score:
            continue
        d = max(abs((bb[0] + bb[2]) / 2 - c), abs((bb[1] + bb[3]) / 2 - c))
        side = max(bb[2] - bb[0], bb[3] - bb[1])
        if d <= 0.2 * img.shape[0] and side >= 0.12 * img.shape[0] and d < bd:
            best, bd = (float(bb[4]), kp, bb[:4]), d
    return best


def _tilt(kps):
    """Degrees the eyes->mouth line is off straight-down. 0 = upright, +-180 = upside down."""
    eye, mouth = (kps[0] + kps[1]) / 2, (kps[3] + kps[4]) / 2
    v = mouth - eye
    return float(np.degrees(np.arctan2(v[0], v[1])))


def roll_of(p):
    """Roll of the central face in a patch: (degrees or None, det score at the best rotation).

    Landmarks on an upside-down face cannot be trusted, so the patch is tried at 0/90/180/270
    and the rotation where the detector is most confident AND sees the face upright wins."""
    cands = []
    for th in (0, 90, 180, 270):
        f = _central_face(_rot(p, th))
        if f is None:
            continue
        t = _tilt(f[1])
        if abs(t) <= 50:
            cands.append((f[0], th, t))
    if not cands:
        return None, 0.0
    sc, th, t = max(cands)
    zero = [c for c in cands if c[1] == 0]
    if zero and zero[0][0] >= sc - 0.05:  # as good unrotated: leave it alone
        sc, th, t = zero[0]
    roll = (t - th + 180) % 360 - 180
    return roll, sc


def upright_embed(p, roll):
    """Rotate the patch so the face is upright, detect and embed again.
    Returns (embedding, det score) or None when no upright face is found at the centre."""
    from insightface.app.common import Face

    img = _rot(p, -roll)
    f = _central_face(img, min_score=0.5)
    if f is None or abs(_tilt(f[1])) > 30:
        return None
    face = Face(bbox=f[2], kps=f[1], det_score=f[0])
    app().models["recognition"].get(img, face)
    return face.normed_embedding.astype(np.float32), f[0]


def orient(bgr, box, emb):
    """Roll + upright fix for one freshly detected face: returns (roll, fix, embedding).
    fix is "" (left alone), "reemb" (embedding replaced by the upright one) or "drop"."""
    roll, _sc = roll_of(patch(bgr, box))
    if roll is None or abs(roll) <= ROLL_MAX:
        return (None if roll is None else round(roll, 1)), "", emb
    got = upright_embed(patch(bgr, box, size=480), roll)
    if got is None:
        return round(roll, 1), "drop", emb
    return round(roll, 1), "reemb", got[0]
