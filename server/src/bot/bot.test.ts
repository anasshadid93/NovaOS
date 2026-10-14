import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-bot-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = path.join(tmp, 'data');
process.env.MANAR_DOCKER_SOCK = path.join(tmp, 'no-docker.sock');
process.env.MANAR_DEV = '1';
fs.mkdirSync(path.join(tmp, 'data'));

const { buildBotServer, checkBotToken, revokeBotToken, rotateBotToken } = await import('./bot.js');
const { closeDb } = await import('../db.js');

let bot: FastifyInstance;
beforeAll(async () => {
  bot = await buildBotServer();
});
afterAll(async () => {
  await bot.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bot API', () => {
  it('is closed until a token exists, then needs exactly that token', async () => {
    expect((await bot.inject('/status')).statusCode).toBe(401);
    const token = rotateBotToken();
    expect(token).toMatch(/^mmbot_[\w-]{32}$/);
    expect((await bot.inject({ url: '/status', headers: { authorization: 'Bearer mmbot_' + 'x'.repeat(32) } })).statusCode).toBe(401);
    expect((await bot.inject({ url: '/status', headers: { authorization: token } })).statusCode).toBe(401);
    const ok = await bot.inject({ url: '/status', headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveProperty('storage');
    expect(ok.json().containers).toEqual({ running: 0, stopped: [] });
  });

  it('shrinks big photos for the model and can save the original', async () => {
    const { execFileSync } = await import('node:child_process');
    const big = path.join(tmp, 'big.jpg');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=4000x3000', '-frames:v', '1', '-y', big]);
    const h = { authorization: `Bearer ${rotateBotToken()}`, 'content-type': 'image/jpeg' };
    const r = await bot.inject({ method: 'POST', url: '/image/fit?save=1&name=Memco%20site.jpg', payload: fs.readFileSync(big), headers: h });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    const out = path.join(tmp, 'small.jpg');
    fs.writeFileSync(out, r.rawPayload);
    const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim();
    expect(dims).toBe('1600,1200');
    expect(decodeURI(String(r.headers['x-saved-path']))).toBe('files/Telegram/Memco site.jpg');
  });

  it('spots a DWG sent with a .jpg name: saved as .dwg, and no photo goes to the model', async () => {
    const h = { authorization: `Bearer ${rotateBotToken()}`, 'content-type': 'image/jpeg' };
    const dwg = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(200, 1)]);
    const r = await bot.inject({ method: 'POST', url: '/image/fit?save=1&name=IMG_1.jpg', payload: dwg, headers: h });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-file-type']).toBe('dwg');
    expect(r.headers['content-type']).toBe('image/png');
    expect(decodeURI(String(r.headers['x-saved-path']))).toBe('files/Telegram/IMG_1.dwg');
    expect(fs.readFileSync(path.join(tmp, 'data', 'files/Telegram/IMG_1.dwg')).subarray(0, 6).toString()).toBe('AC1032');
  });

  it('moves a received file into a folder (created if needed), renaming it', async () => {
    const h = { authorization: `Bearer ${rotateBotToken()}` };
    const r = await bot.inject({ method: 'POST', url: '/files/move', payload: { path: 'files/Telegram/Memco site.jpg', folder: 'CAD/MEMCO', name: 'Memco Drawings 07102026' }, headers: h });
    expect(r.statusCode).toBe(200);
    expect(r.json().path).toBe('files/CAD/MEMCO/Memco Drawings 07102026.jpg');
    expect(fs.existsSync(path.join(tmp, 'data', 'files/Telegram/Memco site.jpg'))).toBe(false);
    for (const bad of [{ path: '../etc/passwd', folder: 'CAD' }, { path: 'files/CAD/MEMCO/Memco Drawings 07102026.jpg', folder: '../..' }, { path: 'files/nope.jpg', folder: 'CAD' }])
      expect((await bot.inject({ method: 'POST', url: '/files/move', payload: bad, headers: h })).statusCode).toBe(422);
  });

  it('stashes a Telegram photo for the next ERP draft', async () => {
    const h = { authorization: `Bearer ${rotateBotToken()}`, 'content-type': 'image/jpeg' };
    const r = await bot.inject({ method: 'POST', url: '/erp/stash?name=x.jpg', payload: Buffer.from('jpegbytes'), headers: h });
    expect(r.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(tmp, 'var', 'erp-inbox', 'last.jpg'), 'utf8')).toBe('jpegbytes');
  });

  it('is read-only', async () => {
    const token = rotateBotToken();
    const r = await bot.inject({ method: 'POST', url: '/status', headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(405);
  });

  it('rotating or revoking kills the old token', () => {
    const a = rotateBotToken();
    const b = rotateBotToken();
    expect(checkBotToken(`Bearer ${a}`)).toBe(false);
    expect(checkBotToken(`Bearer ${b}`)).toBe(true);
    revokeBotToken();
    expect(checkBotToken(`Bearer ${b}`)).toBe(false);
  });
});

describe('read_webpage', async () => {
  const { isPrivateIp, htmlToText, readPage } = await import('./bot.js');
  it('knows private and tailnet addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.17.0.1', '192.168.1.20', '100.64.0.5', '169.254.169.254', '0.0.0.0', '::1', 'fd7a:115c:a1e0::1', '::ffff:127.0.0.1', 'fe80::1']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['1.1.1.1', '203.0.113.5', '142.250.1.1', '2606:4700::1111']) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it('refuses internal URLs', async () => {
    for (const u of ['http://127.0.0.1:7470/api/system', 'http://localhost:7470/', 'http://172.17.0.1:7478/status', 'http://[::1]/', 'http://100.64.0.5:7443/', 'file:///etc/passwd', 'http://user:pw@example.com/']) {
      await expect(readPage(u), u).rejects.toThrow(/blocked_address|bad_url/);
    }
  });
  it('turns HTML into readable text', () => {
    const r = htmlToText('<html><head><title>Release 2.0</title><style>x{}</style></head><body><nav>menu</nav><main><h1>n8n 2.0</h1><p>New &amp; improved</p><script>alert(1)</script><ul><li>A</li><li>B</li></ul></main><footer>f</footer></body></html>');
    expect(r.title).toBe('Release 2.0');
    expect(r.text).toContain('n8n 2.0');
    expect(r.text).toContain('New & improved');
    expect(r.text).toContain('- A');
    expect(r.text).not.toMatch(/alert|menu|x\{\}/);
  });
});

describe('transcribe', async () => {
  const { audioChunks } = await import('./bot.js');
  const { execFileSync } = await import('node:child_process');
  it('turns any audio into ≤2 min 16 kHz mono WAV chunks', async () => {
    const ogg = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=150', '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    const chunks = await audioChunks(ogg);
    expect(chunks.length).toBe(2);
    expect(chunks[0].subarray(0, 4).toString()).toBe('RIFF');
    expect(chunks[0].readUInt32LE(24)).toBe(16000);
    expect(chunks[0].readUInt16LE(22)).toBe(1);
  });
  it('rejects non-POST writes and needs the token', async () => {
    const token = rotateBotToken();
    expect((await bot.inject({ method: 'POST', url: '/transcribe', payload: Buffer.alloc(10), headers: { 'content-type': 'application/octet-stream' } })).statusCode).toBe(401);
    expect((await bot.inject({ method: 'POST', url: '/status', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(405);
    expect((await bot.inject({ method: 'POST', url: '/transcribe', payload: Buffer.alloc(10), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' } })).statusCode).toBe(400);
  });
});

describe('news', async () => {
  const { parseRss } = await import('./market.js');
  it('parses RSS items (CDATA, entities, links)', () => {
    const xml = '<rss><channel><item><title><![CDATA[عنوان &quot;مهم&quot;]]></title><link>https://x.y/1</link><pubDate>Sat, 10 Oct 2026 20:00:00 GMT</pubDate></item><item><title>Second &amp; last</title><guid>https://x.y/2</guid></item></channel></rss>';
    const r = parseRss(xml, 'S');
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'عنوان "مهم"', link: 'https://x.y/1', source: 'S', time: '2026-10-10T20:00:00.000Z' });
    expect(r[1]).toMatchObject({ title: 'Second & last', link: 'https://x.y/2', time: null });
  });
});

describe('confirm-gated actions', async () => {
  const { decide } = await import('./actions.js');
  const { getDb } = await import('../db.js');
  const add = (token: string, expires: number) =>
    getDb().prepare("INSERT INTO bot_actions(token, kind, target, action, status, created_at, expires_at) VALUES(?, 'container', 'manar-x', 'restart', 'pending', ?, ?)").run(token, Date.now(), expires);
  it('cancel, expiry and one use only', async () => {
    add('a'.repeat(16), Date.now() + 60_000);
    expect((await decide('a'.repeat(16), false)).text).toContain('لغيت');
    expect((await decide('a'.repeat(16), true)).text).toContain('انتهى');
    add('b'.repeat(16), Date.now() - 1);
    expect((await decide('b'.repeat(16), true)).text).toContain('انتهت صلاحية');
    expect((await decide('c'.repeat(16), true)).text).toContain('مش موجود');
  });
  it('only the exact action URLs accept POST', async () => {
    const token = rotateBotToken();
    const h = { authorization: `Bearer ${token}` };
    expect((await bot.inject({ method: 'POST', url: '/actions/short/yes', headers: h })).statusCode).toBe(405);
    expect((await bot.inject({ method: 'POST', url: '/actions/' + 'd'.repeat(16) + '/yes', headers: h })).json().text).toContain('مش موجود');
    expect((await bot.inject({ method: 'POST', url: '/actions/container', payload: { name: 'x', action: 'rm' }, headers: h })).statusCode).toBe(422);
  });
});

describe('bot files', async () => {
  const { findFiles, rawFile, saveIncoming } = await import('./files.js');
  const root = process.env.MANAR_DATA_ROOT!;
  fs.mkdirSync(path.join(root, 'files', 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.secret'), { recursive: true });
  fs.writeFileSync(path.join(root, 'files', 'Documents', 'Invoice March 2026.txt'), 'total 100');
  fs.writeFileSync(path.join(root, '.secret', 'invoice-key.txt'), 'nope');
  it('finds by name words, never hidden files', async () => {
    const r = await findFiles('invoice march');
    expect(r.files.map((f) => f.name)).toEqual(['Invoice March 2026.txt']);
  });
  it('refuses hidden paths and leaving the data root', () => {
    expect(() => rawFile('.secret/invoice-key.txt')).toThrow();
    expect(() => rawFile('../etc/passwd')).toThrow();
    expect(rawFile('files/Documents/Invoice March 2026.txt')).toContain('Invoice March 2026.txt');
  });
  it('saves incoming files without overwriting, with their text', async () => {
    const a = await saveIncoming(Buffer.from('hello world'), 'note.txt');
    const b = await saveIncoming(Buffer.from('second'), 'note.txt');
    expect(a.path).toBe('files/Telegram/note.txt');
    expect(b.path).toBe('files/Telegram/note (1).txt');
    expect(a.text).toBe('hello world');
    const c = await saveIncoming(Buffer.from('x'), '../../evil.sh');
    expect(c.path).toBe('files/Telegram/evil.sh');
  });
});

describe('personal helpers', async () => {
  const { parseWhen, reminders, notes, _test } = await import('./personal.js');
  const { getDb } = await import('../db.js');
  it('reads local times as Dubai time and refuses the past', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    expect(parseWhen('2026-10-12 09:00', now)).toBe(Date.parse('2026-10-12T05:00:00Z'));
    expect(parseWhen('2026-10-12T09:00:00+04:00', now)).toBe(Date.parse('2026-10-12T05:00:00Z'));
    expect(() => parseWhen('2026-10-10 09:00', now)).toThrow(/past/);
    expect(() => parseWhen('tomorrow', now)).toThrow(/bad_time/);
  });
  it('reminders: add, list, repeat and fire once', async () => {
    const soon = new Date(Date.now() + 120_000).toISOString();
    const r = reminders({ action: 'add', text: 'call Ahmad', when: soon, repeat: 'daily' }) as { id: number };
    expect((reminders({}) as { reminders: unknown[] }).reminders).toHaveLength(1);
    getDb().prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(Date.now() - 1000, r.id);
    await _test.fireReminders();
    const row = getDb().prepare('SELECT due_at, status FROM reminders WHERE id = ?').get(r.id) as { due_at: number; status: string };
    expect(row.status).toBe('pending');
    expect(row.due_at).toBeGreaterThan(Date.now());
    expect((reminders({ action: 'cancel', id: r.id }) as { ok: boolean }).ok).toBe(true);
    expect((reminders({}) as { reminders: unknown[] }).reminders).toHaveLength(0);
  });
  it('notes and tasks', () => {
    const t = notes({ action: 'add', kind: 'task', text: 'buy a new disk' }) as { id: number };
    notes({ action: 'add', kind: 'note', text: 'router password is on the fridge' });
    expect((notes({ kind: 'task' }) as { items: unknown[] }).items).toHaveLength(1);
    notes({ action: 'done', id: t.id });
    expect((notes({ kind: 'task' }) as { items: unknown[] }).items).toHaveLength(0);
    expect((notes({ kind: 'task', include_done: true }) as { items: { done: boolean }[] }).items[0].done).toBe(true);
  });
});

describe('video text', async () => {
  const { vttToText } = await import('./video.js');
  it('turns rolling auto-captions into clean text', () => {
    const vtt = 'WEBVTT\nKind: captions\nLanguage: en\n\n00:00:01.000 --> 00:00:02.000\nhello <c>world</c>\n\n00:00:02.000 --> 00:00:03.000\nhello world\n\n00:00:03.000 --> 00:00:04.000\nnext line &amp; more\n';
    expect(vttToText(vtt)).toBe('hello world next line & more');
  });
});

describe('tts text', async () => {
  const { numberToArabic, speakable } = await import('./tts.js');
  it('says numbers in Arabic words', () => {
    expect(numberToArabic(38)).toBe('ثمانية وثلاثين');
    expect(numberToArabic(12)).toBe('اثنا عشر');
    expect(numberToArabic(250)).toBe('ميتين وخمسين');
    expect(numberToArabic(2026)).toBe('ألفين وعشرين'.replace('عشرين', 'ستة وعشرين'));
    expect(numberToArabic(918)).toBe('تسعمية وثمانية عشر');
  });
  it('makes replies speakable', () => {
    expect(speakable('🔥 **الحرارة** 85% <b>عالية</b> https://x.y/z')).toBe('الحرارة خمسة وثمانين بالمية عالية رابط');
    expect(speakable('السعر 3.67 درهم')).toBe('السعر ثلاثة فاصلة سبعة وستين درهم');
  });
});

describe('erp (read-only)', async () => {
  const { erp, TOPICS } = await import('./erp.js');
  it('refuses a missing database', () => {
    expect(() => erp('overview', '/nonexistent/db.sqlite')).toThrow('erp_database_not_found');
  });
  const real = '/home/anas/.openclaw/workspace/grerps/runtime/database/database.sqlite';
  it.skipIf(!fs.existsSync(real))('every topic runs against the real GRERPS schema without writing', () => {
    const before = fs.statSync(real).mtimeMs;
    for (const t of TOPICS) expect(erp(t, real), t).toHaveProperty('note');
    expect(fs.statSync(real).mtimeMs).toBe(before);
  });
});

describe('telegram formatting', async () => {
  const { formatReply, formatEvent, clampHtml } = await import('./format.js');
  const balanced = (h: string) => {
    const st: string[] = [];
    for (const m of h.matchAll(/<(\/?)(b|i|code|pre|a)\b[^>]*>/g)) if (!m[1]) st.push(m[2]); else if (st.pop() !== m[2]) return false;
    return st.length === 0;
  };
  it('turns model markdown into safe Telegram HTML, fast', () => {
    const md = 'حرارة الأقراص:\n\n*   **sda**: 28 درجة (الحالة: **فاشل** - SMART).\n*   **nvme1n1**: 30 (media errors (x)).\n\n**ملاحظة:** <script> & `code`';
    const t = Date.now();
    const r = formatReply(md);
    expect(Date.now() - t).toBeLessThan(50);
    expect(r.html).toContain('• <b>sda</b>');
    expect(r.html).toContain('&lt;script&gt; &amp; <code>code</code>');
    expect(balanced(r.html)).toBe(true);
    expect(formatReply('أهلين (Ahlan! Kayf al-hal?)').html).toBe('أهلين');
    expect(formatReply('x', 'سؤال').html.startsWith('🎤 «سؤال»')).toBe(true);
  });
  it('keeps cut messages valid', () => {
    const h = clampHtml('<b>' + 'كلام '.repeat(2000) + '</b>');
    expect(h.length).toBeLessThanOrEqual(4000);
    expect(balanced(h)).toBe(true);
  });
  it('formats inbox events', () => {
    expect(formatEvent({ type: 'alert', text: '🔥 hot' }).text).toBe('🔥 hot');
    const done = formatEvent({ status: 'done', title: 'a<b', sizeMB: 2, shareUrl: 'https://s/x' }).text;
    expect(done).toContain('a&lt;b');
    expect(done).toContain('href="https://s/x/f?dl=1"');
    expect(formatEvent({ status: 'failed', url: 'u', error: 'boom' }).text).toContain('<code>boom</code>');
  });
});

describe('long-term memory', async () => {
  const { memory, memoryText } = await import('./memory.js');
  it('adds once, lists, forgets by id or words', () => {
    const a = memory({ action: 'add', text: 'رقم بابا 0501234567' }) as { id: number };
    expect((memory({ action: 'add', text: '  رقم  بابا 0501234567 ' }) as { duplicate?: boolean }).duplicate).toBe(true);
    memory({ action: 'add', text: 'The owner does not eat meat' });
    expect(memoryText()).toContain(`[${a.id}] رقم بابا`);
    expect((memory({ action: 'delete', text: 'eat meat' }) as { ok: boolean }).ok).toBe(true);
    expect((memory({ action: 'delete', id: a.id }) as { ok: boolean }).ok).toBe(true);
    expect(memoryText()).toBe('(nothing saved yet)');
    expect(() => memory({ action: 'add', text: ' ' })).toThrow('text_required');
  });
});
