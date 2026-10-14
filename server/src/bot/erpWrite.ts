import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Changes in GRERPS (the owner's ERP) requested from Telegram. Always two steps:
 *   1. propose — names are resolved against GRERPS (clients, projects, vendors, petty cash funds)
 *      and a plain summary goes to the owner with ✅/❌ buttons (bot/actions.ts);
 *   2. his ✅ — the change is made through GRERPS's own API as the `the server-bot` user (role "AI Bot":
 *      create/edit only, no delete/approve/post), so GRERPS's validation, permissions and audit apply.
 * Invoices, LPOs and petty cash go in as GRERPS *drafts* (its assistant's draft endpoints) for
 * review inside GRERPS. Credentials: var/grerps-bot.json (mode 600).
 *
 * Photos/documents the owner sends are stashed (var/erp-inbox, last one only, 30 min); a draft proposed
 * soon after takes that file with it and, on ✅, it is uploaded to GRERPS and linked to the draft.
 */

const CRED = path.join(config.dataDir, 'grerps-bot.json');
const VAT = 5;

export const ERP_OPERATIONS = ['invoice_draft', 'lpo_draft', 'petty_cash', 'task', 'task_done', 'project_progress', 'client', 'vendor'] as const;
const INBOX = path.join(config.dataDir, 'erp-inbox');
const STASH_TTL = 30 * 60_000;
const PAGE: Partial<Record<ErpOperation, string>> = { invoice_draft: 'invoices', lpo_draft: 'lpos', petty_cash: 'petty-cash' };
export type ErpOperation = (typeof ERP_OPERATIONS)[number];
type Json = Record<string, unknown>;

// ---- GRERPS session -----------------------------------------------------------------------
let session: { cookie: string; csrf: string; at: number } | null = null;

function creds(): { baseUrl: string; username: string; password: string } {
  return JSON.parse(fs.readFileSync(CRED, 'utf8'));
}

async function login() {
  const c = creds();
  const r = await fetch(`${c.baseUrl}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: c.username, password: c.password }), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`erp_login_${r.status}`);
  const j = (await r.json()) as { csrfToken?: string };
  session = { cookie: r.headers.getSetCookie().map((x) => x.split(';')[0]).join('; '), csrf: j.csrfToken ?? '', at: Date.now() };
}

export async function erpRequest(method: string, p: string, body?: Json): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session || Date.now() - session.at > 6 * 3600_000) await login();
    const r = await fetch(`${creds().baseUrl}${p}`, {
      method,
      headers: { Cookie: session!.cookie, 'x-csrf-token': session!.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    if ((r.status === 401 || r.status === 403) && attempt === 0) {
      session = null; // expired session or CSRF: log in again once
      continue;
    }
    const text = await r.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new Error(`erp_${r.status}: ${typeof data === 'object' && data && 'error' in data ? String((data as Json).error) : text.slice(0, 200)}`);
    return data;
  }
  throw new Error('erp_unauthorized');
}

/** Upload a file into GRERPS (its assistant intake) → the /uploads/… path a draft can link to. */
async function erpUpload(file: string, name: string, pageKey: string): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session || Date.now() - session.at > 6 * 3600_000) await login();
    const form = new FormData();
    form.append('page_key', pageKey); // before the file: GRERPS checks it while the upload streams
    form.append('file', new Blob([fs.readFileSync(file)]), name);
    const r = await fetch(`${creds().baseUrl}/api/assist/extract-preview`, { method: 'POST', headers: { Cookie: session!.cookie, 'x-csrf-token': session!.csrf }, body: form, signal: AbortSignal.timeout(120_000) });
    if (r.status === 401 && attempt === 0) {
      session = null;
      continue;
    }
    const j = (await r.json().catch(() => ({}))) as { source_file?: { relative_path?: string }; error?: string };
    if (!r.ok || !j.source_file?.relative_path) throw new Error(j.error || `upload_${r.status}`);
    return j.source_file.relative_path;
  }
  throw new Error('erp_unauthorized');
}

// ---- the latest photo/document from Telegram ----------------------------------------------
const safeExt = (name: string) => (/\.(jpe?g|png|webp|heic|pdf|tiff?)$/i.exec(name)?.[0] ?? '.jpg').toLowerCase();

export function stashIncoming(body: Buffer, name: string) {
  fs.mkdirSync(INBOX, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(INBOX)) if (f.startsWith('last')) fs.rmSync(path.join(INBOX, f), { force: true });
  const ext = safeExt(name);
  fs.writeFileSync(path.join(INBOX, `last${ext}`), body, { mode: 0o600 });
  fs.writeFileSync(path.join(INBOX, 'last.json'), JSON.stringify({ name: path.basename(name || `photo${ext}`).slice(0, 80), ext, at: Date.now() }), { mode: 0o600 });
  // Drop proposal copies nobody confirmed (older than a day).
  for (const f of fs.readdirSync(INBOX)) if (f.startsWith('p-') && Date.now() - fs.statSync(path.join(INBOX, f)).mtimeMs > 86_400_000) fs.rmSync(path.join(INBOX, f), { force: true });
  return { ok: true, sizeKB: Math.round(body.length / 1024) };
}

/** Take the stashed file (if fresh) for a proposal: its own copy, and the stash is emptied. */
function takeStash(): { file: string; name: string } | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(INBOX, 'last.json'), 'utf8')) as { name: string; ext: string; at: number };
    const src = path.join(INBOX, `last${meta.ext}`);
    if (Date.now() - meta.at > STASH_TTL || !fs.existsSync(src)) return null;
    const file = path.join(INBOX, `p-${crypto.randomBytes(6).toString('hex')}${meta.ext}`);
    fs.renameSync(src, file);
    fs.rmSync(path.join(INBOX, 'last.json'), { force: true });
    return { file, name: meta.name };
  } catch {
    return null;
  }
}

// ---- name resolution ----------------------------------------------------------------------
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Exact (normalized) match wins; else every word of the query inside the name. */
export function matchByName<T extends Json>(list: T[], query: string, field = 'name'): T[] {
  const q = norm(query);
  if (!q) return [];
  const exact = list.filter((x) => norm(String(x[field] ?? '')) === q);
  if (exact.length) return exact;
  const words = q.split(' ');
  return list.filter((x) => {
    const n = norm(String(x[field] ?? ''));
    return words.every((w) => n.includes(w));
  });
}

class Ambiguous extends Error {
  constructor(
    public what: string,
    public query: string,
    public options: string[],
  ) {
    super(`${what} "${query}" is unclear. Ask the owner which one he means: ${options.join(' | ') || '(none exist)'}`);
  }
}

type Kind = 'client' | 'project' | 'vendor' | 'fund' | 'task';
async function listOf(kind: Kind): Promise<Json[]> {
  const src = { client: '/api/clients', project: '/api/projects', vendor: '/api/vendors', fund: '/api/petty-cash/funds', task: '/api/task-center?include_suggestions=0' }[kind];
  const all = (await erpRequest('GET', src)) as Json[] | { tasks?: Json[] };
  if (kind === 'task') return ((all as { tasks?: Json[] }).tasks ?? []).filter((t) => !['Done', 'Cancelled'].includes(String(t.status)));
  return Array.isArray(all) ? all : [];
}

async function pick(kind: Kind, query: string, onlyIfSingle = false): Promise<Json> {
  const field = kind === 'fund' ? 'fund_name' : kind === 'task' ? 'title' : 'name';
  const list = await listOf(kind);
  if (onlyIfSingle && !query && list.length === 1) return list[0];
  const hits = matchByName(list, query, field);
  if (hits.length === 1) return hits[0];
  const names = (hits.length ? hits : list).map((x) => String(x[field])).slice(0, 15);
  throw new Ambiguous(kind, query, names);
}

// ---- proposals ----------------------------------------------------------------------------
const num = (v: unknown) => {
  const t = String(v ?? '').replace(/[, ]/g, '');
  const n = t ? Number(t) : NaN; // empty ≠ 0 (missing VAT must be computed, not zero)
  return Number.isFinite(n) ? n : NaN;
};
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
const str = (v: unknown, n = 500) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Amounts are VAT-inclusive (GRERPS stores invoice amounts with VAT); VAT is the 5/105 share unless given. */
const vatOf = (gross: number, given: unknown, noVat: boolean) => (noVat ? 0 : Number.isFinite(num(given)) && num(given) >= 0 ? num(given) : Math.round(((gross * VAT) / (100 + VAT)) * 100) / 100);

export interface ErpProposal {
  operation: ErpOperation;
  request: { method: string; path: string; body: Json };
  summary: string;
  /** A photo/document to upload and link to the draft on ✅ (bot-owned copy in var/erp-inbox). */
  attachment?: { file: string; name: string };
}

/** Drop a proposal's attachment copy (after it ran, or was cancelled / expired). */
export function discardProposal(p: ErpProposal) {
  if (p.attachment && p.attachment.file.startsWith(INBOX + path.sep)) fs.rmSync(p.attachment.file, { force: true });
}

/** Validate + resolve names → the exact GRERPS call and an Arabic summary. Throws with options when a name is unclear. */
export async function prepareErp(operation: string, f: Json): Promise<ErpProposal> {
  const p = await prepareBare(operation, f);
  if (PAGE[p.operation] && f.attach !== false && f.attach !== 'false') {
    const a = takeStash();
    if (a) {
      p.attachment = a;
      p.summary += '\n📎 مع صورة المستند';
    }
  }
  return p;
}

async function prepareBare(operation: string, f: Json): Promise<ErpProposal> {
  if (!(ERP_OPERATIONS as readonly string[]).includes(operation)) throw new Error(`operation must be one of ${ERP_OPERATIONS.join(', ')}`);
  const op = operation as ErpOperation;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.timezone });
  const project = str(f.project) ? await pick('project', str(f.project)) : null;
  const pLine = project ? `\nالمشروع: <b>${esc(String(project.name))}</b>` : '';
  const noVat = f.no_vat === true || f.no_vat === 'true';

  if (op === 'task') {
    const title = str(f.title, 200);
    if (!title) throw new Error('title_required');
    const body = { title, description: str(f.description, 2000), priority: ['low', 'medium', 'high', 'urgent'].includes(str(f.priority).toLowerCase()) ? str(f.priority).toLowerCase() : 'medium', category: str(f.category, 60) || 'General', owner: str(f.owner, 120), due_date: date(f.due_date) || null, status: 'Open' };
    return { operation: op, request: { method: 'POST', path: '/api/task-center', body }, summary: `📝 <b>مهمة جديدة</b>\n${esc(title)}${body.description ? `\n${esc(body.description)}` : ''}${body.due_date ? `\nالموعد: ${body.due_date}` : ''}\nالأولوية: ${body.priority}` };
  }

  if (op === 'task_done') {
    const task = await pick('task', str(f.title, 200) || str(f.description, 200));
    return { operation: op, request: { method: 'POST', path: `/api/task-center/${Number(task.id)}/status`, body: { status: 'Done' } }, summary: `✔️ <b>تسكير مهمة</b>\n${esc(String(task.title))}` };
  }

  if (op === 'project_progress') {
    if (!project) throw new Error('project_required');
    const progress = num(f.progress ?? f.amount);
    if (!(progress >= 0 && progress <= 100)) throw new Error('progress_required (0-100)');
    const pct = Math.round(progress);
    // The body is rebuilt from a fresh copy of the project at ✅ time (GRERPS's PUT replaces every field).
    return { operation: op, request: { method: 'PUT', path: `/api/projects/${Number(project.id)}`, body: { progress: pct } }, summary: `📈 <b>نسبة إنجاز مشروع</b>\nالمشروع: <b>${esc(String(project.name))}</b>\nمن ${Number(project.progress ?? 0)}٪ ← <b>${pct}٪</b>` };
  }

  if (op === 'client' || op === 'vendor') {
    const name = str(f.name || (op === 'client' ? f.client : f.vendor), 200);
    if (!name) throw new Error('name_required');
    const same = matchByName(await listOf(op), name).filter((x) => norm(String(x.name)) === norm(name));
    if (same.length) throw new Error(`${op} "${String(same[0].name)}" already exists in GRERPS (id ${String(same[0].id)}); nothing to add.`);
    const body = { name, contact_person: str(f.contact, 120), phone: str(f.phone, 40), email: str(f.email, 120), trn: str(f.trn, 30), address: str(f.address, 300) };
    const extra = [body.contact_person && `المسؤول: ${esc(body.contact_person)}`, body.phone && `هاتف: ${esc(body.phone)}`, body.email && `إيميل: ${esc(body.email)}`, body.trn && `TRN: ${esc(body.trn)}`].filter(Boolean).join('\n');
    return { operation: op, request: { method: 'POST', path: op === 'client' ? '/api/clients' : '/api/vendors', body }, summary: `${op === 'client' ? '👤 <b>عميل جديد</b>' : '🏪 <b>مورّد جديد</b>'}\n<b>${esc(name)}</b>${extra ? `\n${extra}` : ''}` };
  }

  const amount = num(f.amount);
  if (!(amount > 0)) throw new Error('amount_required (a positive number, VAT included)');

  if (op === 'invoice_draft') {
    const client = await pick('client', str(f.client) || '?');
    const vat = vatOf(amount, f.vat, noVat);
    const body = { client_id: client.id, project_id: project?.id ?? null, amount, vat_total: vat, vat_rate: noVat ? 0 : VAT, date: date(f.date) || today, due_date: date(f.due_date) || null, line_description: str(f.description, 300) || 'Invoice', notes: str(f.notes, 1000), status: 'Draft' };
    return { operation: op, request: { method: 'POST', path: '/api/assist/create-invoice-draft', body: { ...body, page_key: 'invoices' } }, summary: `🧾 <b>مسودة فاتورة</b> (Draft)\nالعميل: <b>${esc(String(client.name))}</b>${pLine}\nالبيان: ${esc(body.line_description)}\nالمبلغ: <b>${money(amount)} درهم</b> شامل ضريبة ${money(vat)}\nالتاريخ: ${body.date}` };
  }

  if (op === 'lpo_draft') {
    const vendor = await pick('vendor', str(f.vendor) || '?');
    const vat = vatOf(amount, f.vat, noVat);
    const body = { vendor_id: vendor.id, vendor_name: vendor.name, project_id: project?.id ?? null, amount, vat_total: vat, vat_rate: noVat ? 0 : VAT, date: date(f.date) || today, delivery_date: date(f.delivery_date) || null, line_description: str(f.description, 300) || 'LPO', notes: str(f.notes, 1000), status: 'Draft' };
    return { operation: op, request: { method: 'POST', path: '/api/assist/create-lpo-draft', body: { ...body, page_key: 'lpos' } }, summary: `📦 <b>مسودة LPO</b> (Draft)\nالمورّد: <b>${esc(String(vendor.name))}</b>${pLine}\nالبيان: ${esc(body.line_description)}\nالمبلغ: <b>${money(amount)} درهم</b> شامل ضريبة ${money(vat)}${body.delivery_date ? `\nالتسليم: ${body.delivery_date}` : ''}` };
  }

  // petty_cash
  const fund = await pick('fund', str(f.fund), true); // one fund only → no need to ask
  const purpose = str(f.purpose || f.description, 300);
  if (!purpose) throw new Error('purpose_required');
  const vatAmount = Number.isFinite(num(f.vat)) ? num(f.vat) : 0;
  const body = { fund_id: fund.id, project_id: project?.id ?? null, transaction_type: 'Withdrawal', amount, purpose, category: str(f.category, 60) || 'General', vendor_name: str(f.vendor, 120), receipt_date: date(f.date) || today, vat_amount: vatAmount, notes: str(f.notes, 1000), reference_number: str(f.reference, 60) };
  return { operation: 'petty_cash', request: { method: 'POST', path: '/api/assist/create-petty-cash-draft', body: { ...body, page_key: 'petty-cash' } }, summary: `💵 <b>مصروف عهدة</b> (Draft)\nالعهدة: <b>${esc(String(fund.fund_name))}</b>${pLine}\nالبيان: ${esc(purpose)}${body.vendor_name ? `\nالمورد: ${esc(body.vendor_name)}` : ''}\nالمبلغ: <b>${money(amount)} درهم</b>\nالتاريخ: ${body.receipt_date}` };
}

export async function executeErp(p: ErpProposal): Promise<string> {
  let body = p.request.body;
  if (p.operation === 'project_progress') {
    const cur = (await erpRequest('GET', p.request.path)) as Json;
    const keep = ['name', 'client_id', 'consultant_id', 'start_date', 'end_date', 'location', 'status', 'description', 'contract_value_basis', 'contract_vat_rate', 'contract_net_value', 'contract_gross_value'];
    body = { ...Object.fromEntries(keep.map((k) => [k, cur[k]])), progress: p.request.body.progress };
  }
  let attachNote = '';
  if (p.attachment && PAGE[p.operation]) {
    try {
      body = { ...body, source_relative_path: await erpUpload(p.attachment.file, p.attachment.name, PAGE[p.operation]!), source_file_name: p.attachment.name };
      attachNote = ' 📎 الصورة مرفقة.';
    } catch (e) {
      attachNote = ` (ما قدرت أرفق الصورة: ${esc((e as Error).message.slice(0, 80))})`;
    }
  }
  const res = (await erpRequest(p.request.method, p.request.path, body)) as Json;
  discardProposal(p);
  const ref = res && typeof res === 'object' ? (res.invoice_number ?? res.lpo_number ?? (res.draft as Json | undefined)?.number ?? res.id ?? (res.task as Json | undefined)?.id ?? '') : '';
  if (p.operation === 'task_done') return '✅ تسكّرت المهمة بـ GRERPS.';
  if (p.operation === 'project_progress') return `✅ صارت نسبة الإنجاز ${String(p.request.body.progress)}٪ بـ GRERPS.`;
  const draft = PAGE[p.operation] ? ' هي مسودة: راجعها واعتمدها من البرنامج.' : '';
  return `✅ انضافت بـ GRERPS${ref ? ` (<code>${esc(String(ref))}</code>)` : ''}.${draft}${attachNote}`;
}

export function isAmbiguous(e: unknown): e is Ambiguous {
  return e instanceof Ambiguous;
}
