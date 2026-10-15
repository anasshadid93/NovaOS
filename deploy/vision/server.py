#!/usr/bin/env python3
"""NovaOS vision sidecar: CLIP image/text embeddings and faces, on the CPU with OpenVINO.

Models (OpenVINO IR) live next to this file in model/: a Chinese-CLIP ViT-B/16 image and text
tower with its tokenizer, RetinaFace (320) for face boxes and landmarks, and an ArcFace R50 for
face embeddings. Listens on 127.0.0.1 only; NovaOS starts it and talks JSON to it.

  GET  /health                       -> {ok, models}
  POST /embed/images {paths}         -> {vectors: [[512 floats]|null], errors}
  POST /embed/texts  {texts}         -> {vectors}
  POST /faces        {path}          -> {faces: [{box, score, vector}]}
  POST /frames       {path, every, max} -> {frames: [{t, vector}]}  (video, via ffmpeg)
"""
import json, math, os, subprocess, sys, threading, itertools, io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import openvino as ov
from PIL import Image, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
M = os.path.join(HERE, 'model')
PORT = int(os.environ.get('VISION_PORT', '7479'))
core = ov.Core()
core.set_property('CPU', {'INFERENCE_NUM_THREADS': int(os.environ.get('VISION_THREADS', '6'))})
try:
    import openvino_tokenizers
    core.add_extension(openvino_tokenizers._ext_path)
    TOK = core.compile_model(os.path.join(M, 'clip_tokenizer.xml'), 'CPU')
except Exception as e:  # text search off, images still work
    TOK = None
    print('tokenizer unavailable:', str(e).strip().split('\n')[-1][:160], file=sys.stderr)
IMG = core.compile_model(os.path.join(M, 'img_clip_vit_b_16.xml'), 'CPU')
TXT = core.compile_model(os.path.join(M, 'text_clip_vit_b_16.xml'), 'CPU')
DET = core.compile_model(os.path.join(M, 'retina_face_320.xml'), 'CPU')
REC = core.compile_model(os.path.join(M, 'webface_r50.xml'), 'CPU')
CTX = TXT.inputs[0].get_partial_shape()[1].get_length()
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)
LOCK = threading.Lock()


def norm(v):
    v = np.asarray(v, dtype=np.float32)
    return v / (np.linalg.norm(v) + 1e-9)


def clip_prep(im: Image.Image):
    im = ImageOps.exif_transpose(im).convert('RGB')
    w, h = im.size
    s = 224 / min(w, h)
    im = im.resize((max(224, round(w * s)), max(224, round(h * s))), Image.BICUBIC)
    w, h = im.size
    l, t = (w - 224) // 2, (h - 224) // 2
    im = im.crop((l, t, l + 224, t + 224))
    x = (np.asarray(im, dtype=np.float32) / 255 - MEAN) / STD
    return x.transpose(2, 0, 1)[None]


def embed_image(im: Image.Image):
    with LOCK:
        v = IMG(clip_prep(im))[IMG.output(0)][0]
    return norm(v).tolist()


def embed_text(s: str):
    if TOK is None:
        raise RuntimeError('tokenizer unavailable')
    with LOCK:
        out = TOK(np.array([s]))
        ids = out[TOK.output(0)].astype(np.int64)
        x = np.zeros((1, CTX), dtype=np.int64)
        n = min(CTX, ids.shape[1])
        x[0, :n] = ids[0, :n]
        v = TXT({'text': x})[TXT.output(0)][0]
    return norm(v).tolist()


def _priors(size=320):
    out = []
    for step, mins in zip([8, 16, 32], [[16, 32], [64, 128], [256, 512]]):
        f = math.ceil(size / step)
        for i, j in itertools.product(range(f), range(f)):
            for m in mins:
                out.append([(j + 0.5) * step / size, (i + 0.5) * step / size, m / size, m / size])
    return np.array(out, dtype=np.float32)


PRI = _priors()


def _detect(im: Image.Image, thr=0.85):
    """Faces in one 320x320 pass: (score, box in image pixels, 5 landmarks)."""
    W, H = im.size
    a = np.asarray(im.resize((320, 320)), dtype=np.float32)[:, :, ::-1] - np.array([104, 117, 123], dtype=np.float32)
    with LOCK:
        out = DET(a.transpose(2, 0, 1)[None])
    loc, conf, lm = out[DET.output(0)][0], out[DET.output(1)][0], out[DET.output(2)][0]
    scores = conf[:, 1]
    res = []
    for k in np.where(scores > thr)[0]:
        p, l = PRI[k], loc[k]
        cx, cy = p[0] + l[0] * 0.1 * p[2], p[1] + l[1] * 0.1 * p[3]
        w, h = p[2] * np.exp(l[2] * 0.2), p[3] * np.exp(l[3] * 0.2)
        box = [(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H]
        pts = [((p[0] + lm[k][2 * i] * 0.1 * p[2]) * W, (p[1] + lm[k][2 * i + 1] * 0.1 * p[3]) * H) for i in range(5)]
        res.append((float(scores[k]), box, pts))
    return res


def _nms(faces, iou_thr=0.4):
    faces = sorted(faces, key=lambda f: -f[0])
    keep = []
    for f in faces:
        x1, y1, x2, y2 = f[1]
        ok = True
        for g in keep:
            a1, b1, a2, b2 = g[1]
            ix, iy = max(0, min(x2, a2) - max(x1, a1)), max(0, min(y2, b2) - max(y1, b1))
            inter = ix * iy
            u = (x2 - x1) * (y2 - y1) + (a2 - a1) * (b2 - b1) - inter
            if u > 0 and inter / u > iou_thr:
                ok = False
                break
        if ok:
            keep.append(f)
    return keep


def detect_faces(im: Image.Image):
    """Full image, then 2x2 tiles when the image is large: small faces (ID scans, groups) survive."""
    im = ImageOps.exif_transpose(im).convert('RGB')
    W, H = im.size
    faces = _detect(im)
    if max(W, H) >= 900:
        tw, th = W / 2, H / 2
        for i in range(2):
            for j in range(2):
                ox, oy = j * tw * 0.9, i * th * 0.9  # 10% overlap
                tile = im.crop((int(ox), int(oy), int(min(W, ox + tw * 1.1)), int(min(H, oy + th * 1.1))))
                for s, box, pts in _detect(tile):
                    faces.append((s, [box[0] + ox, box[1] + oy, box[2] + ox, box[3] + oy], [(x + ox, y + oy) for x, y in pts]))
    faces = _nms(faces)
    out = []
    for s, box, pts in faces:
        x1, y1, x2, y2 = box
        w, h = x2 - x1, y2 - y1
        if w < 24 or h < 24:
            continue
        crop = im.crop((x1 - 0.15 * w, y1 - 0.15 * h, x2 + 0.15 * w, y2 + 0.15 * h)).resize((112, 112), Image.BICUBIC)
        a = (np.asarray(crop, dtype=np.float32) - 127.5) / 128.0
        with LOCK:
            v = REC(a.transpose(2, 0, 1)[None])[REC.output(0)][0]
        out.append({'box': [round(x) for x in box], 'score': round(s, 3), 'vector': norm(v).tolist()})
    return out


def video_frames(path, every=30, maximum=20):
    """Up to `maximum` frames, one every `every` seconds, embedded with CLIP."""
    try:
        dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True, timeout=30).stdout.strip() or 0)
    except Exception:
        dur = 0
    if dur <= 0:
        return []
    step = max(every, dur / maximum)
    times = [t for t in np.arange(min(5, dur / 2), dur - 1, step)][:maximum]
    out = []
    for t in times:
        try:
            r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(t), '-i', path, '-frames:v', '1', '-vf', 'scale=320:-1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], capture_output=True, timeout=60)
            if not r.stdout:
                continue
            out.append({'t': round(float(t), 1), 'vector': embed_image(Image.open(io.BytesIO(r.stdout)))})
        except Exception:
            continue
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'ok': True, 'models': {'clip': True, 'text': TOK is not None, 'faces': True}, 'dim': 512})
        self._send(404, {'error': 'not_found'})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            return self._send(400, {'error': 'bad_json'})
        try:
            if self.path == '/embed/images':
                vectors, errors = [], {}
                for p in body.get('paths', [])[:64]:
                    try:
                        with Image.open(p) as im:
                            im.draft('RGB', (448, 448))  # fast JPEG downscale on load
                            vectors.append(embed_image(im))
                    except Exception as e:
                        vectors.append(None)
                        errors[p] = str(e)[:120]
                return self._send(200, {'vectors': vectors, 'errors': errors})
            if self.path == '/embed/texts':
                return self._send(200, {'vectors': [embed_text(str(t)) for t in body.get('texts', [])[:64]]})
            if self.path == '/faces':
                with Image.open(body['path']) as im:
                    im.draft('RGB', (1600, 1600))
                    return self._send(200, {'faces': detect_faces(im)})
            if self.path == '/frames':
                return self._send(200, {'frames': video_frames(body['path'], float(body.get('every', 30)), int(body.get('max', 20)))})
            self._send(404, {'error': 'not_found'})
        except Exception as e:
            self._send(500, {'error': str(e)[:200]})


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), H)
    print(f'vision sidecar on 127.0.0.1:{PORT}', flush=True)
    srv.serve_forever()
