import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A fake GRERPS: login + lookups + the draft endpoints, recording every write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manar-erpw-'));
process.env.MANAR_DATA_DIR = path.join(tmp, 'var');
process.env.MANAR_DATA_ROOT = path.join(tmp, 'data');
process.env.MANAR_DEV = '1';
fs.mkdirSync(path.join(tmp, 'var'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'data'));

const writes: { path: string; body: Record<string, unknown>; csrf: string | undefined }[] = [];
let logins = 0;
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (code: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/api/auth/login') {
      logins++;
      return send(200, { csrfToken: `csrf${logins}` }, { 'Set-Cookie': `erp_session=s${logins}; HttpOnly; Path=/` });
    }
    if (req.headers.cookie !== `erp_session=s${logins}`) return send(401, { error: 'login' });
    if (req.method === 'GET' && req.url === '/api/clients') return send(200, [{ id: 1, name: 'Emaar Properties' }, { id: 2, name: 'Nakheel' }, { id: 3, name: 'Nakheel Malls' }]);
    if (req.method === 'GET' && req.url === '/api/projects') return send(200, [{ id: 7, name: 'Villa 12 Arabian Ranches', progress: 40 }]);
    if (req.url === '/api/projects/7' && req.method === 'GET') return send(200, { id: 7, name: 'Villa 12 Arabian Ranches', client_id: 1, consultant_id: 2, start_date: '2026-01-01', status: 'Active', description: 'keep me', contract_net_value: 900000, progress: 40 });
    if (req.url?.startsWith('/api/task-center?')) return send(200, { tasks: [{ id: 3, title: 'Call the consultant', status: 'Open' }, { id: 4, title: 'Old thing', status: 'Done' }] });
    if (req.url === '/api/assist/extract-preview') {
      writes.push({ path: req.url, body: { type: String(req.headers['content-type']).split(';')[0], hasPageKeyFirst: raw.indexOf('page_key') < raw.indexOf('filename=') }, csrf: req.headers['x-csrf-token'] as string | undefined });
      return send(200, { source_file: { relative_path: '/uploads/ai_intake/ai-1-photo.jpg' } });
    }
    if (req.method === 'GET' && req.url === '/api/vendors') return send(200, [{ id: 4, name: 'Al Futtaim Steel' }]);
    if (req.method === 'GET' && req.url === '/api/petty-cash/funds') return send(200, [{ id: 9, fund_name: 'Site Cash' }]);
    writes.push({ path: req.url!, body: JSON.parse(raw || '{}'), csrf: req.headers['x-csrf-token'] as string | undefined });
    return send(200, { id: 55, invoice_number: 'AI-DRAFT-1' });
  });
});

let decide: typeof import('./actions.js').decide;
let proposeErpChange: typeof import('./actions.js').proposeErpChange;
let matchByName: typeof import('./erpWrite.js').matchByName;
let stashIncoming: typeof import('./erpWrite.js').stashIncoming;
let closeDb: () => void;
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as { port: number }).port;
  fs.writeFileSync(path.join(tmp, 'var', 'grerps-bot.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, username: 'the server-bot', password: 'x' }));
  ({ decide, proposeErpChange } = await import('./actions.js'));
  ({ matchByName, stashIncoming } = await import('./erpWrite.js'));
  ({ closeDb } = await import('../db.js'));
});
afterAll(() => {
  fake.close();
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const lastToken = async () => {
  const { getDb } = await import('../db.js');
  return (getDb().prepare("SELECT token FROM bot_actions WHERE kind = 'erp' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { token: string }).token;
};

describe('GRERPS changes', () => {
  it('matches names loosely but prefers an exact one', () => {
    const list = [{ name: 'Nakheel' }, { name: 'Nakheel Malls' }, { name: 'شركة الإمارات' }];
    expect(matchByName(list, 'nakheel')).toEqual([{ name: 'Nakheel' }]);
    expect(matchByName(list, 'malls')).toEqual([{ name: 'Nakheel Malls' }]);
    expect(matchByName(list, 'الامارات')).toEqual([{ name: 'شركة الإمارات' }]);
    expect(matchByName(list, '')).toEqual([]);
  });

  it('asks back instead of guessing, and writes nothing', async () => {
    const r = await proposeErpChange('invoice_draft', { client: 'Nak', amount: 100 });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Nakheel Malls');
    expect((await proposeErpChange('invoice_draft', { client: 'Emaar' })).message).toMatch(/amount/);
    expect((await proposeErpChange('delete_invoice', {})).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('writes only after ✅, once, with the session + CSRF', async () => {
    const r = await proposeErpChange('invoice_draft', { client: 'emaar', project: 'villa 12', amount: '10,500', description: 'Progress payment 2' });
    expect(r.ok).toBe(true);
    expect(writes).toHaveLength(0);
    const token = await lastToken();
    const done = await decide(token, true);
    expect(done.text).toContain('AI-DRAFT-1');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/api/assist/create-invoice-draft');
    expect(writes[0].csrf).toMatch(/^csrf\d$/);
    expect(writes[0].body).toMatchObject({ client_id: 1, project_id: 7, amount: 10500, vat_total: 500, status: 'Draft' });
    expect((await decide(token, true)).text).toMatch(/انتهى/);
    expect(writes).toHaveLength(1);
  });

  it('❌ cancels; petty cash uses the only fund; tasks go to the task center', async () => {
    await proposeErpChange('lpo_draft', { vendor: 'futtaim', amount: 2100 });
    expect((await decide(await lastToken(), false)).text).toContain('لغيت');
    await proposeErpChange('petty_cash', { amount: 35, purpose: 'Water for site' });
    await decide(await lastToken(), true);
    expect(writes.at(-1)).toMatchObject({ path: '/api/assist/create-petty-cash-draft', body: { fund_id: 9, transaction_type: 'Withdrawal', amount: 35 } });
    await proposeErpChange('task', { title: 'Call the consultant', priority: 'High' });
    await decide(await lastToken(), true);
    expect(writes.at(-1)).toMatchObject({ path: '/api/task-center', body: { title: 'Call the consultant', priority: 'high' } });
    expect(writes).toHaveLength(3);
  });

  it('carries the last photo with the next draft, uploads it on ✅, and only once', async () => {
    writes.length = 0;
    stashIncoming(Buffer.from('fake-jpeg'), 'receipt.jpg');
    const r = await proposeErpChange('petty_cash', { amount: 12, purpose: 'Nails' });
    expect(r.ok).toBe(true);
    const inbox = path.join(tmp, 'var', 'erp-inbox');
    expect(fs.readdirSync(inbox).filter((f) => f.startsWith('p-'))).toHaveLength(1);
    expect(fs.existsSync(path.join(inbox, 'last.jpg'))).toBe(false);
    const done = await decide(await lastToken(), true);
    expect(done.text).toContain('مرفقة');
    expect(writes[0]).toMatchObject({ path: '/api/assist/extract-preview', body: { type: 'multipart/form-data', hasPageKeyFirst: true } });
    expect(writes[1].body).toMatchObject({ source_relative_path: '/uploads/ai_intake/ai-1-photo.jpg', amount: 12 });
    expect(fs.readdirSync(inbox).filter((f) => f.startsWith('p-'))).toHaveLength(0);
    // The stash was used up: the next draft goes without a photo.
    await proposeErpChange('petty_cash', { amount: 5, purpose: 'Tea' });
    await decide(await lastToken(), false);
    expect(writes).toHaveLength(2);
  });

  it('progress keeps every other project field; closes open tasks; no duplicate clients', async () => {
    writes.length = 0;
    expect((await proposeErpChange('project_progress', { project: 'villa', progress: 140 })).ok).toBe(false);
    await proposeErpChange('project_progress', { project: 'villa', progress: '65' });
    expect((await decide(await lastToken(), true)).text).toContain('65');
    expect(writes[0]).toMatchObject({ path: '/api/projects/7', body: { progress: 65, name: 'Villa 12 Arabian Ranches', client_id: 1, consultant_id: 2, description: 'keep me', contract_net_value: 900000, status: 'Active' } });
    expect((await proposeErpChange('task_done', { title: 'old thing' })).ok).toBe(false); // already done → not offered
    await proposeErpChange('task_done', { title: 'consultant' });
    await decide(await lastToken(), true);
    expect(writes[1]).toMatchObject({ path: '/api/task-center/3/status', body: { status: 'Done' } });
    const dup = await proposeErpChange('client', { name: 'nakheel' });
    expect(dup.ok).toBe(false);
    expect(dup.message).toMatch(/already exists/);
    expect(await proposeErpChange('vendor', { name: 'Danube Building Materials', phone: '04 000 0000' })).toMatchObject({ ok: true });
    expect((await decide(await lastToken(), true)).text).toContain('انضافت');
    expect(writes[2]).toMatchObject({ path: '/api/vendors', body: { name: 'Danube Building Materials', phone: '04 000 0000' } });
  });
});
