import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { config } from '../config.js';
import { audit, getDb, kvGet, kvSet } from '../db.js';
import { media, type MediaItem } from '../files/gallery.js';
import { resolveInRoot } from '../files/fsops.js';
import { runHelper } from '../helper.js';
import { enqueue, registerTask } from '../tasks/tasks.js';

/**
 * Vision: photo search by words, "more like this", people (faces), automatic categories, duplicates
 * and search inside videos. The models run in a small Python sidecar (OpenVINO on the CPU, see
 * <visionDir>/server.py); this file starts it, indexes the gallery in the background and answers
 * the queries from vectors kept in SQLite. Everything stays on this machine.
 */
const execFileP = promisify(execFile);
const DIM = 512;
const BATCH = 16;
/** Zero-shot categories: the English prompt the text tower sees, and the label stored. */
const CATEGORIES: { label: string; prompts: string[] }[] = [
  { label: 'people', prompts: ['a photo of people', '人的照片', '一个人的自拍或合影'] },
  { label: 'document', prompts: ['a scanned document or paper form', '扫描的文件或表格', '一张纸质文档'] },
  { label: 'screenshot', prompts: ['a screenshot of a phone or computer screen', '手机或电脑屏幕截图', '软件界面截图'] },
  { label: 'receipt', prompts: ['a receipt or invoice', '收据或发票', '购物小票'] },
  { label: 'id', prompts: ['an identity card or passport', '身份证或护照', '证件照片'] },
  { label: 'car', prompts: ['a car or truck', '汽车或卡车', '一辆车的照片'] },
  { label: 'building', prompts: ['a building or construction site', '建筑物或建筑工地', '房子和楼房'] },
  { label: 'nature', prompts: ['a landscape, sea, sky or plants', '风景、大海、天空或植物', '自然风光'] },
  { label: 'food', prompts: ['food or a meal', '食物或一顿饭', '美食照片'] },
  { label: 'pet', prompts: ['a cat, dog or animal', '猫、狗或动物', '宠物照片'] },
  { label: 'text', prompts: ['a page of text or a chart', '一页文字或图表', '表格和数据'] },
  { label: 'logo', prompts: ['a logo or graphic design', '标志或平面设计', '图标和插画'] },
];
/** Bump when CATEGORIES change: stored labels are recomputed from the kept vectors on the next scan. */
const PROTO_VERSION = '2';
const LABEL_MIN = 0.2;
const LABEL_MARGIN = 0.01; // best must beat the runner-up by this much, else the photo stays unlabelled
const DUP_MIN = 0.96;
const PERSON_MIN = 0.45; // cosine between ArcFace vectors of the same person (this model: ~0.5+)
const MAX_VIDEOS_PER_RUN = 150;

// ---- Sidecar -------------------------------------------------------------------------------------
//
// The models need ~1.2 GB, far above manar.service's memory cap, so the sidecar runs as its own
// systemd unit (novaos-vision.service, installed by deploy/install.sh) and this process only talks
// to it. Without that unit (development, a plain `npm start`) it is spawned as a child instead.

const UNIT = 'novaos-vision.service';
let child: ChildProcess | null = null;
let alive = false;
let stopping = false;
let lastStartAsk = 0;
const serverPy = () => path.join(config.visionDir, 'server.py');
const python = () => path.join(config.visionDir, 'venv', 'bin', 'python');
export const installed = () => fs.existsSync(serverPy()) && fs.existsSync(python()) && fs.existsSync(path.join(config.visionDir, 'model', 'img_clip_vit_b_16.xml'));
const hasUnit = () => fs.existsSync(`/etc/systemd/system/${UNIT}`);
const base = () => `http://127.0.0.1:${config.visionPort}`;

function spawnChild() {
  if (child || stopping) return;
  child = spawn(python(), [serverPy()], {
    cwd: config.visionDir,
    env: { ...process.env, VISION_PORT: String(config.visionPort), VISION_THREADS: String(Math.max(2, Math.min(8, Math.floor(os.cpus().length / 4)))) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString().trim();
    if (s) lastError = s.slice(-300);
  });
  child.on('exit', () => {
    child = null;
  });
}

/** Keeps `alive` current and nudges the sidecar back up when it is down. */
async function tick() {
  const ok = await health();
  if (ok) {
    alive = true;
    return;
  }
  alive = false;
  if (stopping) return;
  if (hasUnit()) {
    if (Date.now() - lastStartAsk > 5 * 60_000) {
      lastStartAsk = Date.now();
      runHelper({ cmd: 'systemctl', action: 'start', unit: UNIT }).catch((e: unknown) => {
        lastError = `start ${UNIT}: ${(e as Error).message}`;
      });
    }
  } else spawnChild();
}

export function startVision(): () => void {
  if (process.env.VITEST || !installed()) return () => {};
  stopping = false;
  void tick();
  const watch = setInterval(() => void tick(), 15_000);
  const loop = setInterval(() => {
    if (alive && Date.now() - Number(kvGet('vision.lastIndex') ?? 0) > 6 * 3600_000) indexNow();
  }, 10 * 60_000);
  const first = setTimeout(() => alive && indexNow(), 2 * 60_000);
  return () => {
    stopping = true;
    clearInterval(watch);
    clearInterval(loop);
    clearTimeout(first);
    child?.kill('SIGTERM');
  };
}

let lastError: string | null = null;
async function health(): Promise<boolean> {
  try {
    const r = await fetch(`${base()}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
async function call<T>(route: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  const r = await fetch(`${base()}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `vision ${r.status}`);
  return j;
}

// ---- Vectors -------------------------------------------------------------------------------------

const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
const fromBlob = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
function cos(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}
const abs = (rel: string) => resolveInRoot(rel);

let photoCache: {
  at: number;
  rows: { path: string; vec: Float32Array; label: string | null; score: number }[];
} | null = null;
function photoVectors() {
  if (photoCache && Date.now() - photoCache.at < 60_000) return photoCache.rows;
  const rows = (
    getDb().prepare('SELECT path, vec, label, label_score FROM media_vec').all() as {
      path: string;
      vec: Buffer;
      label: string | null;
      label_score: number | null;
    }[]
  ).map((r) => ({ path: r.path, vec: fromBlob(r.vec), label: r.label, score: r.label_score ?? 0 }));
  photoCache = { at: Date.now(), rows };
  return rows;
}
let frameCache: {
  at: number;
  rows: { path: string; t: number; vec: Float32Array }[];
} | null = null;
function frameVectors() {
  if (frameCache && Date.now() - frameCache.at < 60_000) return frameCache.rows;
  const rows = (
    getDb().prepare('SELECT path, t, vec FROM video_frames').all() as {
      path: string;
      t: number;
      vec: Buffer;
    }[]
  ).map((r) => ({ path: r.path, t: r.t, vec: fromBlob(r.vec) }));
  frameCache = { at: Date.now(), rows };
  return rows;
}
const invalidate = () => {
  photoCache = null;
  frameCache = null;
};

let protos: { label: string; vec: Float32Array }[] | null = null;
async function prototypes() {
  if (protos) return protos;
  const texts = CATEGORIES.flatMap((c) => c.prompts);
  const r = await call<{ vectors: number[][] }>('/embed/texts', { texts });
  let k = 0;
  protos = CATEGORIES.map((c) => {
    const v = new Float32Array(DIM);
    for (const _ of c.prompts) {
      const x = r.vectors[k++];
      for (let i = 0; i < DIM; i++) v[i] += x[i];
    }
    let n = 0;
    for (let i = 0; i < DIM; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < DIM; i++) v[i] /= n;
    return { label: c.label, vec: v };
  });
  return protos;
}
function labelOf(vec: Float32Array, ps: { label: string; vec: Float32Array }[]): { label: string | null; score: number } {
  let best = { label: null as string | null, score: -1 };
  let second = -1;
  for (const p of ps) {
    const s = cos(vec, p.vec);
    if (s > best.score) {
      second = best.score;
      best = { label: p.label, score: s };
    } else if (s > second) second = s;
  }
  return best.score >= LABEL_MIN && best.score - second >= LABEL_MARGIN ? best : { label: null, score: best.score };
}

/** Common Arabic photo-search words; anything else goes through the local Ollama model (first call can take a minute while it loads). */
const AR_WORDS: Record<string, string> = {
  فاتورة: 'receipt',
  فواتير: 'receipts',
  سيارة: 'car',
  سيارات: 'cars',
  بحر: 'sea',
  شاطئ: 'beach',
  جبل: 'mountain',
  جبال: 'mountains',
  طعام: 'food',
  اكل: 'food',
  أكل: 'food',
  قطة: 'cat',
  قط: 'cat',
  كلب: 'dog',
  طفل: 'baby',
  اطفال: 'children',
  أطفال: 'children',
  عائلة: 'family',
  زفاف: 'wedding',
  عرس: 'wedding',
  حفلة: 'party',
  مستند: 'document',
  مستندات: 'documents',
  ورقة: 'document',
  هوية: 'id card',
  جواز: 'passport',
  'جواز سفر': 'passport',
  لقطة: 'screenshot',
  'لقطة شاشة': 'screenshot',
  شاشة: 'screenshot',
  بيت: 'house',
  منزل: 'house',
  مبنى: 'building',
  شجرة: 'tree',
  ورد: 'flowers',
  زهور: 'flowers',
  غروب: 'sunset',
  سماء: 'sky',
  ليل: 'night',
  ثلج: 'snow',
  مطر: 'rain',
  طائرة: 'airplane',
  مطار: 'airport',
  مسجد: 'mosque',
  صحراء: 'desert',
  جمل: 'camel',
  خيل: 'horse',
  حصان: 'horse',
  طيور: 'birds',
  عصفور: 'bird',
  سمك: 'fish',
  هاتف: 'phone',
  جوال: 'phone',
  حاسوب: 'laptop',
  لابتوب: 'laptop',
  كتاب: 'book',
  قهوة: 'coffee',
  شاي: 'tea',
  كيك: 'cake',
  كعكة: 'cake',
  بيتزا: 'pizza',
  برجر: 'burger',
  سيلفي: 'selfie',
  رياضة: 'sports',
  'كرة قدم': 'football',
  ملعب: 'stadium',
  مدرسة: 'school',
  مكتب: 'office',
  مطبخ: 'kitchen',
  شهادة: 'certificate',
  خريطة: 'map',
  شعار: 'logo',
  رسم: 'drawing',
  نص: 'text',
};

/** Arabic (or anything not Latin) is translated to English first; the text tower knows English and Chinese. */
async function queryVector(q: string): Promise<{ vec: Float32Array; used: string }> {
  let used = q.trim();
  if (/[\u0600-\u06FF]/.test(used)) {
    const key = used.replace(/^(ال)/, '').replace(/[\u064B-\u0652]/g, '');
    const hit = AR_WORDS[used] ?? AR_WORDS[key];
    if (hit) used = hit;
    else {
      try {
        const r = await fetch(`${process.env.MANAR_OLLAMA_URL ?? 'http://127.0.0.1:11434'}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: process.env.MANAR_SUB_MODEL ?? 'gemma4:latest',
            messages: [{ role: 'user', content: `Translate this photo-search query from Arabic to a short English noun phrase. Answer with the phrase only.\n${used}` }],
            stream: false,
            think: false,
            keep_alive: '30m',
            options: { temperature: 0 },
          }),
          signal: AbortSignal.timeout(90_000),
        });
        if (r.ok) {
          const t = ((await r.json()) as { message: { content: string } }).message.content
            .trim()
            .split('\n')[0]
            .replace(/^["']|["'.]$/g, '');
          if (t) used = t;
        }
      } catch {
        /* search with the original text */
      }
    }
  }
  const r = await call<{ vectors: number[][] }>('/embed/texts', { texts: [`a photo of ${used}`] }, 20_000);
  return { vec: new Float32Array(r.vectors[0]), used };
}

// ---- Indexing ------------------------------------------------------------------------------------

interface Progress {
  phase: string;
  done: number;
  total: number;
}
let progress: Progress | null = null;
let indexing = false;

export function indexNow(): number | null {
  if (indexing || !alive) return null;
  const db = getDb();
  const running = db.prepare("SELECT id FROM tasks WHERE kind = 'vision.index' AND status IN ('queued','running')").get() as { id: number } | undefined;
  return running?.id ?? enqueue('vision.index', 'Index photos for search and people');
}

registerTask('vision.index', async (ctx) => {
  if (!alive) throw new Error('vision sidecar is not running');
  indexing = true;
  try {
    const db = getDb();
    const all = await media();
    const photos = all.filter((m) => m.cat === 'images');
    const videos = all.filter((m) => m.cat === 'videos');
    const ps = await prototypes();
    if (kvGet('vision.protoVersion') !== PROTO_VERSION) {
      const rows = db.prepare('SELECT path, vec FROM media_vec').all() as { path: string; vec: Buffer }[];
      const up = db.prepare('UPDATE media_vec SET label = ?, label_score = ? WHERE path = ?');
      db.exec('BEGIN');
      for (const r of rows) {
        const l = labelOf(fromBlob(r.vec), ps);
        up.run(l.label, l.score, r.path);
      }
      db.exec('COMMIT');
      kvSet('vision.protoVersion', PROTO_VERSION);
      ctx.log(`Categories recomputed for ${rows.length} photos`);
    }

    // 1. CLIP vectors + category for new or changed photos.
    const have = new Map(
      (
        db.prepare('SELECT path, mtime FROM media_vec').all() as {
          path: string;
          mtime: number;
        }[]
      ).map((r) => [r.path, r.mtime]),
    );
    const todo = photos.filter((m) => have.get(m.path) !== m.mtime);
    const ins = db.prepare('INSERT OR REPLACE INTO media_vec(path, mtime, vec, label, label_score) VALUES(?,?,?,?,?)');
    let done = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const r = await call<{ vectors: (number[] | null)[] }>('/embed/images', { paths: batch.map((m) => abs(m.path)) }, 300_000);
      db.exec('BEGIN');
      batch.forEach((m, j) => {
        const v = r.vectors[j];
        if (!v) return;
        const l = labelOf(new Float32Array(v), ps);
        ins.run(m.path, m.mtime, toBlob(v), l.label, l.score);
      });
      db.exec('COMMIT');
      done += batch.length;
      progress = { phase: 'photos', done, total: todo.length };
      if (done % (BATCH * 10) === 0 || done === todo.length) ctx.progress(`photos ${done}/${todo.length}`);
    }
    invalidate();
    // Photos that vanished.
    const current = new Set(photos.map((m) => m.path));
    const gone = [...have.keys()].filter((p) => !current.has(p));
    if (gone.length) {
      const del = db.prepare('DELETE FROM media_vec WHERE path = ?');
      const delF = db.prepare('DELETE FROM faces WHERE path = ?');
      const delD = db.prepare('DELETE FROM faces_done WHERE path = ?');
      db.exec('BEGIN');
      for (const p of gone) {
        del.run(p);
        delF.run(p);
        delD.run(p);
      }
      db.exec('COMMIT');
    }
    ctx.log(`Photos: ${todo.length} indexed, ${gone.length} removed`);

    // 2. Faces (slower: one call per photo; photos the category says contain people go first).
    const faceDone = new Map(
      (
        db.prepare('SELECT path, mtime FROM faces_done').all() as {
          path: string;
          mtime: number;
        }[]
      ).map((r) => [r.path, r.mtime]),
    );
    const labels = new Map(
      (
        db.prepare('SELECT path, label FROM media_vec').all() as {
          path: string;
          label: string | null;
        }[]
      ).map((r) => [r.path, r.label]),
    );
    const faceTodo = photos
      .filter((m) => faceDone.get(m.path) !== m.mtime)
      .sort((a, b) => Number(labels.get(b.path) === 'people' || labels.get(b.path) === 'id') - Number(labels.get(a.path) === 'people' || labels.get(a.path) === 'id'));
    const insF = db.prepare('INSERT INTO faces(path, box, score, vec, person_id) VALUES(?,?,?,?,NULL)');
    const delF = db.prepare('DELETE FROM faces WHERE path = ?');
    const doneF = db.prepare('INSERT OR REPLACE INTO faces_done(path, mtime, n) VALUES(?,?,?)');
    let found = 0;
    for (const [i, m] of faceTodo.entries()) {
      try {
        const r = await call<{
          faces: { box: number[]; score: number; vector: number[] }[];
        }>('/faces', { path: abs(m.path) }, 120_000);
        db.exec('BEGIN');
        delF.run(m.path);
        for (const f of r.faces) insF.run(m.path, JSON.stringify(f.box), f.score, toBlob(f.vector));
        doneF.run(m.path, m.mtime, r.faces.length);
        db.exec('COMMIT');
        found += r.faces.length;
      } catch (e) {
        doneF.run(m.path, m.mtime, -1);
      }
      progress = { phase: 'faces', done: i + 1, total: faceTodo.length };
      if ((i + 1) % 50 === 0 || i + 1 === faceTodo.length) ctx.progress(`faces ${i + 1}/${faceTodo.length}`);
    }
    ctx.log(`Faces: ${faceTodo.length} photos looked at, ${found} faces found`);
    clusterPeople();

    // 3. Video frames, a bounded number of videos per run.
    const vHave = new Set(
      (
        db.prepare('SELECT DISTINCT path FROM video_frames').all() as {
          path: string;
        }[]
      ).map((r) => r.path),
    );
    const vSkip = new Set((kvGet('vision.videoSkip') ?? '').split('\n').filter(Boolean));
    const vTodo = videos.filter((m) => !vHave.has(m.path) && !vSkip.has(m.path)).slice(0, MAX_VIDEOS_PER_RUN);
    const insV = db.prepare('INSERT OR REPLACE INTO video_frames(path, t, vec) VALUES(?,?,?)');
    for (const [i, m] of vTodo.entries()) {
      try {
        const r = await call<{ frames: { t: number; vector: number[] }[] }>('/frames', { path: abs(m.path), every: 30, max: 16 }, 600_000);
        if (!r.frames.length) vSkip.add(m.path);
        db.exec('BEGIN');
        for (const f of r.frames) insV.run(m.path, f.t, toBlob(f.vector));
        db.exec('COMMIT');
      } catch {
        vSkip.add(m.path);
      }
      progress = { phase: 'videos', done: i + 1, total: vTodo.length };
      if ((i + 1) % 10 === 0 || i + 1 === vTodo.length) ctx.progress(`videos ${i + 1}/${vTodo.length}`);
    }
    kvSet('vision.videoSkip', [...vSkip].slice(-5000).join('\n'));
    const vLeft = videos.length - vHave.size - vTodo.length;
    ctx.log(`Videos: ${vTodo.length} scanned this run${vLeft > 0 ? `, ${vLeft} left for the next runs` : ''}`);
    invalidate();
    kvSet('vision.lastIndex', String(Date.now()));
    if (vLeft > 0 && vTodo.length) setTimeout(() => indexNow(), 60_000).unref();
  } finally {
    indexing = false;
    progress = null;
  }
});

/** Greedy clustering of unassigned faces onto people centroids; people need two faces to show. */
export function clusterPeople() {
  const db = getDb();
  const faces = db.prepare('SELECT id, vec, person_id FROM faces WHERE score >= 0.9').all() as { id: number; vec: Buffer; person_id: number | null }[];
  const centroids = new Map<number, { sum: Float32Array; n: number }>();
  for (const f of faces) {
    if (f.person_id === null) continue;
    const c = centroids.get(f.person_id) ?? {
      sum: new Float32Array(DIM),
      n: 0,
    };
    const v = fromBlob(f.vec);
    for (let i = 0; i < DIM; i++) c.sum[i] += v[i];
    c.n++;
    centroids.set(f.person_id, c);
  }
  const mean = (c: { sum: Float32Array; n: number }) => {
    const m = new Float32Array(DIM);
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += (c.sum[i] / c.n) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) m[i] = c.sum[i] / c.n / norm;
    return m;
  };
  const upd = db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
  const newPerson = db.prepare('INSERT INTO people(name, cover_face, hidden, created_at) VALUES(NULL, ?, 0, ?)');
  db.exec('BEGIN');
  for (const f of faces) {
    if (f.person_id !== null) continue;
    const v = fromBlob(f.vec);
    let best: { id: number; s: number } | null = null;
    for (const [id, c] of centroids) {
      const s = cos(v, mean(c));
      if (s >= PERSON_MIN && (!best || s > best.s)) best = { id, s };
    }
    let pid: number;
    if (best) pid = best.id;
    else {
      pid = Number(newPerson.run(f.id, Date.now()).lastInsertRowid);
      centroids.set(pid, { sum: new Float32Array(DIM), n: 0 });
    }
    const c = centroids.get(pid)!;
    for (let i = 0; i < DIM; i++) c.sum[i] += v[i];
    c.n++;
    upd.run(pid, f.id);
  }
  db.exec('COMMIT');
}

// ---- Queries -------------------------------------------------------------------------------------

function itemsByPath(all: MediaItem[]) {
  return new Map(all.map((m) => [m.path, m]));
}

export async function search(q: string, limit = 120) {
  const { vec, used } = await queryVector(q);
  const all = itemsByPath(await media());
  const photos = photoVectors()
    .map((r) => ({ path: r.path, score: cos(vec, r.vec) }))
    .filter((r) => r.score >= 0.17 && all.has(r.path))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      ...all.get(r.path)!,
      score: Math.round(r.score * 100) / 100,
    }));
  const bestFrame = new Map<string, { t: number; score: number }>();
  for (const f of frameVectors()) {
    const s = cos(vec, f.vec);
    if (s < 0.17) continue;
    const b = bestFrame.get(f.path);
    if (!b || s > b.score) bestFrame.set(f.path, { t: f.t, score: s });
  }
  const videos = [...bestFrame.entries()]
    .filter(([p]) => all.has(p))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 40)
    .map(([p, b]) => ({
      ...all.get(p)!,
      t: b.t,
      score: Math.round(b.score * 100) / 100,
    }));
  return { query: q, used, photos, videos };
}

export async function similar(rel: string, limit = 60) {
  const row = getDb().prepare('SELECT vec FROM media_vec WHERE path = ?').get(rel) as { vec: Buffer } | undefined;
  if (!row) return null;
  const vec = fromBlob(row.vec);
  const all = itemsByPath(await media());
  return photoVectors()
    .filter((r) => r.path !== rel && all.has(r.path))
    .map((r) => ({ path: r.path, score: cos(vec, r.vec) }))
    .filter((r) => r.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      ...all.get(r.path)!,
      score: Math.round(r.score * 100) / 100,
    }));
}

export async function duplicates(limit = 60) {
  const all = itemsByPath(await media());
  const rows = photoVectors().filter((r) => all.has(r.path));
  const groups: { items: MediaItem[]; score: number }[] = [];
  const used = new Set<string>();
  for (let i = 0; i < rows.length && groups.length < limit; i++) {
    if (used.has(rows[i].path)) continue;
    const g: MediaItem[] = [];
    let best = 0;
    for (let j = i + 1; j < rows.length; j++) {
      if (used.has(rows[j].path)) continue;
      const s = cos(rows[i].vec, rows[j].vec);
      if (s >= DUP_MIN) {
        g.push(all.get(rows[j].path)!);
        used.add(rows[j].path);
        best = Math.max(best, s);
      }
    }
    if (g.length) {
      used.add(rows[i].path);
      groups.push({
        items: [all.get(rows[i].path)!, ...g],
        score: Math.round(best * 100) / 100,
      });
    }
  }
  return groups;
}

export async function categories() {
  const all = itemsByPath(await media());
  const counts = new Map<string, { n: number; cover: MediaItem; best: number }>();
  for (const r of photoVectors()) {
    if (!r.label) continue;
    const m = all.get(r.path);
    if (!m) continue;
    const c = counts.get(r.label);
    if (!c) counts.set(r.label, { n: 1, cover: m, best: r.score });
    else {
      c.n++;
      if (r.score > c.best) {
        c.best = r.score;
        c.cover = m;
      }
    }
  }
  return CATEGORIES.map((c) => ({
    label: c.label,
    ...(counts.get(c.label) ?? { n: 0, cover: null }),
  }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n);
}

export async function byCategory(label: string) {
  const all = itemsByPath(await media());
  return photoVectors()
    .filter((r) => r.label === label && all.has(r.path))
    .map((r) => all.get(r.path)!)
    .sort((a, b) => b.taken - a.taken);
}

export function people() {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT p.id, p.name, p.cover_face, COUNT(f.id) AS faces, COUNT(DISTINCT f.path) AS photos
         FROM people p JOIN faces f ON f.person_id = p.id WHERE p.hidden = 0 GROUP BY p.id HAVING photos >= 2 ORDER BY (p.name IS NULL), photos DESC`,
      )
      .all() as {
      id: number;
      name: string | null;
      cover_face: number;
      faces: number;
      photos: number;
    }[]
  ).map((p) => ({
    id: p.id,
    name: p.name,
    coverFace: p.cover_face,
    photos: p.photos,
  }));
}

export async function personPhotos(id: number) {
  const all = itemsByPath(await media());
  const rows = getDb().prepare('SELECT DISTINCT path FROM faces WHERE person_id = ?').all(id) as { path: string }[];
  return rows
    .map((r) => all.get(r.path))
    .filter((m): m is MediaItem => !!m)
    .sort((a, b) => b.taken - a.taken);
}

/** A 160px crop of one face, made once with ffmpeg and cached. */
async function faceCrop(id: number): Promise<string | null> {
  const row = getDb().prepare('SELECT path, box FROM faces WHERE id = ?').get(id) as { path: string; box: string } | undefined;
  if (!row) return null;
  const dir = path.join(config.dataDir, 'faces');
  const out = path.join(dir, `${id}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(dir, { recursive: true });
  const [x1, y1, x2, y2] = JSON.parse(row.box) as number[];
  const w = x2 - x1;
  const h = y2 - y1;
  const pad = Math.round(Math.max(w, h) * 0.35);
  const side = Math.round(Math.max(w, h) + 2 * pad);
  const cx = Math.round((x1 + x2) / 2 - side / 2);
  const cy = Math.round((y1 + y2) / 2 - side / 2);
  await execFileP('ffmpeg', ['-v', 'error', '-y', '-i', abs(row.path), '-vf', `crop=${side}:${side}:${Math.max(0, cx)}:${Math.max(0, cy)},scale=160:160`, '-frames:v', '1', '-q:v', '4', out], {
    timeout: 30_000,
  });
  return out;
}

export function status() {
  const db = getDb();
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    installed: installed(),
    ready: alive,
    indexing,
    progress,
    lastIndex: Number(kvGet('vision.lastIndex') ?? 0) || null,
    photos: n('SELECT COUNT(*) AS n FROM media_vec'),
    faces: n('SELECT COUNT(*) AS n FROM faces'),
    people: n('SELECT COUNT(*) AS n FROM (SELECT person_id FROM faces GROUP BY person_id HAVING COUNT(DISTINCT path) >= 2)'),
    videos: n('SELECT COUNT(DISTINCT path) AS n FROM video_frames'),
    lastError,
  };
}

export async function visionRoutes(app: FastifyInstance) {
  app.get('/api/vision/status', { preHandler: requireAuth }, async () => status());
  app.post('/api/vision/index', { preHandler: requireAuth }, async (_req, reply) => {
    const id = indexNow();
    return id ? { task: id } : reply.code(409).send({ error: alive ? 'busy' : 'not_ready' });
  });

  app.get<{ Querystring: { q?: string } }>('/api/gallery/search', { preHandler: requireAuth }, async (req, reply) => {
    const q = String(req.query.q ?? '')
      .trim()
      .slice(0, 120);
    if (!q) return reply.code(400).send({ error: 'empty' });
    if (!alive) return reply.code(503).send({ error: 'not_ready' });
    return search(q);
  });
  app.get<{ Querystring: { path?: string } }>('/api/gallery/similar', { preHandler: requireAuth }, async (req, reply) => {
    const r = await similar(String(req.query.path ?? ''));
    return r ?? reply.code(404).send({ error: 'not_indexed' });
  });
  app.get('/api/gallery/duplicates', { preHandler: requireAuth }, async () => duplicates());
  app.get<{ Querystring: { label?: string } }>('/api/gallery/categories', { preHandler: requireAuth }, async (req) => (req.query.label ? byCategory(String(req.query.label)) : categories()));
  app.get('/api/gallery/people', { preHandler: requireAuth }, async () => people());
  app.get<{ Params: { id: string } }>('/api/gallery/people/:id', { preHandler: requireAuth }, async (req) => personPhotos(Number(req.params.id)));
  app.post<{
    Params: { id: string };
    Body: { name?: string; hidden?: boolean; mergeInto?: number };
  }>('/api/gallery/people/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
    const b = req.body ?? {};
    if (typeof b.name === 'string') db.prepare('UPDATE people SET name = ? WHERE id = ?').run(b.name.trim().slice(0, 60) || null, id);
    if (typeof b.hidden === 'boolean') db.prepare('UPDATE people SET hidden = ? WHERE id = ?').run(b.hidden ? 1 : 0, id);
    if (typeof b.mergeInto === 'number' && b.mergeInto !== id) {
      db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(b.mergeInto, id);
      db.prepare('DELETE FROM people WHERE id = ?').run(id);
    }
    audit(req.session!.userId, 'people_edit', {
      id,
      name: !!b.name,
      hidden: b.hidden,
      mergeInto: b.mergeInto,
    });
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/gallery/face/:id', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const file = await faceCrop(Number(req.params.id));
      if (!file) return reply.code(404).send({ error: 'not_found' });
      return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=604800').send(fs.createReadStream(file));
    } catch {
      return reply.code(404).send({ error: 'no_crop' });
    }
  });
}
