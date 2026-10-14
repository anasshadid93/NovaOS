import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { config } from '../config.js';
import { resolveInRoot } from './fsops.js';

/**
 * Previews for Office and CAD files: converted to PDF once (LibreOffice in the manar-libreoffice-writer
 * container; DWG first through libredwg's dwg2dxf) and cached, then shown by the same PDF viewer.
 */
const execFileP = promisify(execFile);
export const CONVERTIBLE = /\.(doc|docx|odt|rtf|xls|xlsx|ods|csv|ppt|pptx|odp|dxf|dwg|pages|numbers|key|wpd)$/i;
const LO = config.libreofficeContainer;
const DWG2DXF = config.dwg2dxf;
const CACHE = () => path.join(config.dataDir, 'previews');

/** One conversion at a time: a headless LibreOffice doesn't like parallel runs. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const p = chain.then(f, f);
  chain = p.catch(() => null);
  return p;
}

/** Streams `input` into the container, converts it, streams the PDF back. */
function convertInContainer(input: string, ext: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `d=$(mktemp -d) && cat > "$d/in.${ext}" && cd "$d" && timeout 170 soffice --headless --norestore --convert-to pdf --outdir "$d" "in.${ext}" >/dev/null 2>&1; [ -f "$d/in.pdf" ] && cat "$d/in.pdf"; rc=$?; rm -rf "$d"; exit $rc`;
    const child = spawn('docker', ['exec', '-i', LO, 'sh', '-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const dst = fs.createWriteStream(`${out}.part`);
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.stdout.pipe(dst);
    fs.createReadStream(input).pipe(child.stdin);
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      dst.end(() => {
        if (code === 0 && fs.existsSync(`${out}.part`) && fs.statSync(`${out}.part`).size > 0) {
          fs.renameSync(`${out}.part`, out);
          resolve();
        } else {
          fs.rmSync(`${out}.part`, { force: true });
          reject(new Error(err.trim().split('\n').pop() || `conversion failed (${code})`));
        }
      });
    });
  });
}

export async function previewPdf(rel: string): Promise<string> {
  const src = resolveInRoot(rel);
  const st = fs.statSync(src);
  if (!st.isFile() || !CONVERTIBLE.test(src)) throw Object.assign(new Error('not_convertible'), { status: 415 });
  if (st.size > 200 * 1024 ** 2) throw Object.assign(new Error('too_large'), { status: 413 });
  fs.mkdirSync(CACHE(), { recursive: true });
  const key = crypto.createHash('sha1').update(`${src}\0${st.mtimeMs}\0${st.size}`).digest('hex');
  const out = path.join(CACHE(), `${key}.pdf`);
  if (fs.existsSync(out)) return out;
  const failed = path.join(CACHE(), `${key}.failed`);
  if (fs.existsSync(failed)) throw Object.assign(new Error(fs.readFileSync(failed, 'utf8') || 'conversion failed'), { status: 415 });
  await serial(async () => {
    if (fs.existsSync(out)) return;
    let input = src;
    let ext = path.extname(src).slice(1).toLowerCase();
    let tmp: string | null = null;
    try {
      if (ext === 'dwg') {
        if (DWG2DXF.includes('/') && !fs.existsSync(DWG2DXF)) throw new Error('DWG converter not installed');
        tmp = path.join(os.tmpdir(), `mm-${key}.dxf`);
        await execFileP(DWG2DXF, ['-o', tmp, src], { timeout: 120_000 });
        input = tmp;
        ext = 'dxf';
      }
      await convertInContainer(input, ext, out);
    } catch (e) {
      fs.writeFileSync(failed, (e as Error).message.slice(0, 300));
      throw Object.assign(e as Error, { status: 415 });
    } finally {
      if (tmp) fs.rmSync(tmp, { force: true });
    }
  });
  return out;
}

export async function previewRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { path?: string } }>('/api/fs/preview', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const file = await previewPdf(String(req.query.path ?? ''));
      return reply.header('Content-Type', 'application/pdf').header('Cache-Control', 'private, max-age=86400').send(fs.createReadStream(file));
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return reply.code(status === 415 || status === 413 ? status : 404).send({ error: (e as Error).message.slice(0, 200) });
    }
  });
}
