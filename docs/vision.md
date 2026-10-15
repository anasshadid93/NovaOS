# Smart photo search (vision sidecar)

Optional. Adds to the Gallery: search photos by words (English or Arabic), "similar photos",
people albums (faces grouped into persons you can name), automatic categories (documents,
receipts, screenshots, cars, …), duplicate finder and search inside videos. Everything runs on
this machine's CPU; no photo ever leaves it.

## What it needs

- Python 3.10+ with `venv`, and `ffmpeg` (frames, face crops).
- About 1.3 GB of RAM while it runs and ~450 MB of disk for the models.
- Four OpenVINO IR models in `<data root>/apps/vision/model/`:

  | file | model | role |
  | --- | --- | --- |
  | `img_clip_vit_b_16.xml/.bin` | Chinese-CLIP ViT-B/16 image tower | photo + video-frame vectors (512-d) |
  | `text_clip_vit_b_16.xml/.bin` + `clip_tokenizer.xml/.bin` | Chinese-CLIP text tower + tokenizer | query vectors, zero-shot categories |
  | `retina_face_320.xml/.bin` | RetinaFace (320×320) | face boxes |
  | `webface_r50.xml/.bin` | ArcFace R50 (WebFace) | face vectors for grouping people |

  Any OpenVINO export of these models with the same input/output layout works. Export your own
  (for example from [Chinese-CLIP](https://github.com/OFA-Sys/Chinese-CLIP), the
  [OpenVINO tokenizers](https://github.com/openvinotoolkit/openvino_tokenizers) tool and
  [InsightFace](https://github.com/deepinsight/insightface) checkpoints via `ovc`) or reuse a
  set you already have.

## Install

```bash
sudo mkdir -p /srv/data/apps/vision/model && sudo chown -R "$USER" /srv/data/apps/vision
cp deploy/vision/server.py /srv/data/apps/vision/
# put the model files into /srv/data/apps/vision/model/
python3 -m venv /srv/data/apps/vision/venv
/srv/data/apps/vision/venv/bin/pip install openvino openvino-tokenizers pillow numpy
sudo deploy/install.sh        # installs and starts novaos-vision.service when the folder is complete
```

NovaOS detects the folder (`visionDir` in `manar.json`, default `<data root>/apps/vision`) and
shows **People** and **Smart** tabs plus a search box in the Gallery. Settings → Integrations
lists it as "Smart photo search".

## How it runs

- `novaos-vision.service` runs `server.py` on `127.0.0.1:7479` (`visionPort`), as the NovaOS
  user, with `Nice=15`, `CPUWeight=20` and `MemoryMax=3G`, so it never slows the rest of the
  machine. It is a separate unit because manar.service itself is capped at 512 MB.
- NovaOS checks `/health` every 15 s and asks the sudo helper to start the unit when it is down.
  Without the unit (development) it spawns `server.py` as a child process instead.
- The task **Index photos for search and people** runs 2 minutes after boot and then every
  6 hours, or from the Smart tab's "Scan now": new/changed photos → vectors + category, then
  faces, then up to 150 videos per run (one frame every 30 s, at most 16 per video). Vectors live
  in the SQLite tables `media_vec`, `faces`, `people`, `video_frames`.
- People: faces with detection score ≥ 0.9 are grouped greedily when cosine ≥ 0.45 to a group's
  mean vector; a person appears once it has faces in two or more photos. Rename, hide or merge
  from the People tab (`POST /api/gallery/people/:id`).
- Arabic queries are translated to English by the local Ollama model first (if Ollama is on
  `127.0.0.1:11434`); otherwise the text is used as typed.

## API

| route | what |
| --- | --- |
| `GET /api/vision/status` | installed/ready/indexing, counts, last error |
| `POST /api/vision/index` | start a scan now |
| `GET /api/gallery/search?q=` | photos and video moments matching words |
| `GET /api/gallery/similar?path=` | photos like this one |
| `GET /api/gallery/categories[?label=]` | categories with counts and covers, or one category |
| `GET /api/gallery/duplicates` | groups of near-identical photos (cosine ≥ 0.96) |
| `GET /api/gallery/people`, `GET/POST /api/gallery/people/:id` | people, their photos, rename/hide/merge |
| `GET /api/gallery/face/:id` | 160 px crop of one face |
