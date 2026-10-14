import { getDb } from '../db.js';

/**
 * The assistant's long-term memory: short facts the owner asked it to remember ("my father's number
 * is…", "I don't eat meat"). Every reply gets them in its instructions; he can list or forget them.
 * Kept small on purpose (each one is read on every message).
 */

const MAX_ITEMS = 200;
const MAX_LEN = 500;
type Row = { id: number; text: string; created_at: number };
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export function memory(b: Record<string, unknown>) {
  const db = getDb();
  const action = typeof b.action === 'string' ? b.action : 'list';
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, MAX_LEN) : '';
  if (action === 'add') {
    if (!text) throw new Error('text_required');
    const all = db.prepare('SELECT id, text FROM bot_memory').all() as Row[];
    const same = all.find((r) => norm(r.text) === norm(text));
    if (same) return { ok: true, id: same.id, duplicate: true };
    if (all.length >= MAX_ITEMS) throw new Error(`memory_full: ${MAX_ITEMS} items, forget some first`);
    const r = db.prepare('INSERT INTO bot_memory(text, created_at) VALUES(?, ?)').run(text, Date.now());
    return { ok: true, id: Number(r.lastInsertRowid) };
  }
  if (action === 'delete') {
    const id = Number(b.id);
    // By id, or by words ("forget my car plate") when the model has no id.
    if (Number.isFinite(id) && id > 0) return { ok: db.prepare('DELETE FROM bot_memory WHERE id = ?').run(id).changes > 0 };
    if (!text) throw new Error('id_or_text_required');
    const words = norm(text).split(' ').filter((w) => w.length > 2);
    const hits = (db.prepare('SELECT id, text FROM bot_memory').all() as Row[]).filter((r) => words.length && words.every((w) => norm(r.text).includes(w)));
    if (hits.length !== 1) return { ok: false, matches: hits.map((h) => ({ id: h.id, text: h.text })), note: hits.length ? 'several match: delete by id' : 'nothing matches' };
    db.prepare('DELETE FROM bot_memory WHERE id = ?').run(hits[0].id);
    return { ok: true, deleted: hits[0].text };
  }
  return { items: (db.prepare('SELECT id, text, created_at FROM bot_memory ORDER BY id').all() as Row[]).map((r) => ({ id: r.id, text: r.text, saved: new Date(r.created_at).toISOString().slice(0, 10) })) };
}

/** The facts as a short block for the assistant's instructions. */
export function memoryText(): string {
  const rows = getDb().prepare('SELECT id, text FROM bot_memory ORDER BY id').all() as Row[];
  return rows.length ? rows.map((r) => `- [${r.id}] ${r.text}`).join('\n') : '(nothing saved yet)';
}
