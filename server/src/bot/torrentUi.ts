import crypto from 'node:crypto';
import { kvGet, kvSet } from '../db.js';
import { addTorrent, listTorrents, magnetOf, qbList, TPB_API, TPB_CATEGORIES, type TpbRow } from './apps.js';
import { keyboard, tg, type Button } from './telegram.js';
import { history, remember, titleKey } from './torrentHistory.js';
import { archiveStatus } from './archiveDl.js';
import { addApTorrent, latest as apLatest, search as apSearch, type ApItem } from './arabp2p.js';

/**
 * /torrent on Telegram, answered by MinisManager itself (n8n only passes the update along), so it
 * never goes through the AI: a menu (new films/series in the last 48 h, all-time top, music, games,
 * apps), search, pages of 5 with ⬇️ buttons, and nothing he already downloaded — by the torrent's
 * hash, and by title + year / episode so another release of the same film is hidden too.
 */

export interface Item {
  hash: string;
  /** an ArabP2P torrent (no magnet: the .torrent comes from the site with his passkey) */
  ap?: ApItem;
  name: string;
  sizeGB: number;
  seeders: number;
  added: string;
  trusted: boolean;
}
interface View {
  id: string;
  title: string;
  items: Item[];
  page: number;
  hidden: number;
  started: string[];
  /** ArabP2P lists: his ratio at the time */
  acct?: { upGB: number; downGB: number; ratio: number } | null;
}
const PAGE = 5;
const VIEWS = 'torrent_views';

export const SOURCES: Record<string, { title: string; files: string[] }> = {
  movies: { title: '🔥 أفلام جديدة · آخر 48 ساعة', files: ['data_top100_48h_207', 'data_top100_48h_201'] },
  tv: { title: '📺 مسلسلات جديدة · آخر 48 ساعة', files: ['data_top100_48h_208', 'data_top100_48h_205'] },
  top: { title: '🏆 أعلى الأفلام', files: ['data_top100_207', 'data_top100_201'] },
  new: { title: '🆕 الأكثر تنزيلاً · آخر 48 ساعة', files: ['data_top100_48h'] },
  music: { title: '🎵 موسيقى', files: ['data_top100_48h_101', 'data_top100_101'] },
  games: { title: '🎮 ألعاب', files: ['data_top100_48h_400', 'data_top100_400'] },
  apps: { title: '💻 برامج', files: ['data_top100_48h_300', 'data_top100_300'] },
};
const MENU: Button[][] = [
  [
    { text: '🔥 أفلام جديدة', data: 'tor:m:movies' },
    { text: '📺 مسلسلات جديدة', data: 'tor:m:tv' },
  ],
  [
    { text: '🏆 أعلى الأفلام', data: 'tor:m:top' },
    { text: '🆕 الأكثر تنزيلاً', data: 'tor:m:new' },
  ],
  [
    { text: '🎵 موسيقى', data: 'tor:m:music' },
    { text: '🎮 ألعاب', data: 'tor:m:games' },
    { text: '💻 برامج', data: 'tor:m:apps' },
  ],
  [{ text: '🇸🇦 ArabP2P · عربي ومدبلج', data: 'tor:ap' }],
  [{ text: '📥 تنزيلاتي', data: 'tor:st' }],
];
const AP_MENU: Button[][] = [
  [
    { text: '🧸 أفلام كرتون مدبلجة', data: 'tor:apc:98' },
    { text: '📺 مسلسلات كرتون مدبلجة', data: 'tor:apc:100' },
  ],
  [
    { text: '🎞 كرتون كلاسيك', data: 'tor:apc:85' },
    { text: '🎌 أنمي مترجم', data: 'tor:apc:101' },
  ],
  [
    { text: '🎬 أفلام عربية', data: 'tor:apc:41' },
    { text: '🎬 أفلام مدبلجة', data: 'tor:apc:88' },
  ],
  [
    { text: '📺 مسلسلات عربية', data: 'tor:apc:44' },
    { text: '📺 مسلسلات مدبلجة', data: 'tor:apc:71' },
  ],
  [
    { text: '🎥 وثائقي', data: 'tor:apc:19' },
    { text: '🏠', data: 'tor:menu' },
  ],
];
const AP_TITLE: Record<string, string> = { 98: '🧸 أفلام كرتون مدبلجة', 100: '📺 مسلسلات كرتون مدبلجة', 85: '🎞 كرتون كلاسيك', 101: '🎌 أنمي مترجم', 41: '🎬 أفلام عربية', 88: '🎬 أفلام مدبلجة', 44: '📺 مسلسلات عربية', 71: '📺 مسلسلات مدبلجة', 19: '🎥 وثائقي' };

const esc = (x: string) => x.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);

/** What he already has: hashes and title keys, from qBittorrent and the history. */
export async function alreadyHave(): Promise<{ hashes: Set<string>; keys: Set<string> }> {
  const hashes = new Set<string>();
  const keys = new Set<string>();
  for (const x of history()) {
    hashes.add(x.h);
    keys.add(x.k);
  }
  try {
    for (const t of await qbList()) {
      hashes.add(t.hash.toUpperCase());
      keys.add(titleKey(t.name));
    }
  } catch {
    /* qBittorrent down: the history still works */
  }
  return { hashes, keys };
}
export function dropHad(items: Item[], have: { hashes: Set<string>; keys: Set<string> }): { items: Item[]; hidden: number } {
  const keep = items.filter((x) => !have.hashes.has(x.hash) && !have.keys.has(titleKey(x.name)));
  return { items: keep, hidden: items.length - keep.length };
}

const toItem = (x: TpbRow): Item => ({
  hash: x.info_hash.toUpperCase(),
  name: x.name,
  sizeGB: Math.round((+x.size / 1024 ** 3) * 100) / 100,
  seeders: +x.seeders,
  added: new Date(+x.added * 1000).toISOString().slice(0, 10),
  trusted: x.status === 'vip' || x.status === 'trusted',
});
/** Rows from TPB, adult categories and empty hits out, one per hash, the busiest first. */
export function cleanRows(rows: TpbRow[]): Item[] {
  const seen = new Set<string>();
  return rows
    .filter((x) => x.id !== '0' && x.info_hash && !/^0+$/.test(x.info_hash) && !String(x.category).startsWith('5'))
    .sort((a, b) => +b.seeders - +a.seeders)
    .map(toItem)
    .filter((x) => (seen.has(x.hash) ? false : (seen.add(x.hash), true)));
}
async function tpb(path: string): Promise<TpbRow[]> {
  const r = await fetch(`${TPB_API}/${path}`, { headers: { 'User-Agent': 'Mozilla/5.0 (MinisManager)' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`tpb_${r.status}`);
  return (await r.json()) as TpbRow[];
}

// ---- views (one per list message, so old messages' buttons still mean what they showed) ----------
function views(): View[] {
  try {
    return JSON.parse(kvGet(VIEWS) ?? '[]') as View[];
  } catch {
    return [];
  }
}
function saveView(v: View) {
  kvSet(VIEWS, JSON.stringify([v, ...views().filter((x) => x.id !== v.id)].slice(0, 12)));
}
const getView = (id: string) => views().find((v) => v.id === id) ?? null;

async function makeView(title: string, rows: TpbRow[]): Promise<View> {
  const { items, hidden } = dropHad(cleanRows(rows), await alreadyHave());
  const v: View = { id: crypto.randomBytes(3).toString('hex'), title, items: items.slice(0, 60), page: 0, hidden, started: [] };
  saveView(v);
  return v;
}

async function makeApView(title: string, r: { items: ApItem[]; acct: View['acct'] }): Promise<View> {
  const items: Item[] = r.items.map((x) => ({ hash: `AP${x.id}`, name: x.name, sizeGB: x.sizeGB, seeders: x.seeders, added: x.added, trusted: false, ap: x }));
  const { items: left, hidden } = dropHad(items, await alreadyHave());
  const v: View = { id: crypto.randomBytes(3).toString('hex'), title: `${title} · ArabP2P`, items: left.slice(0, 60), page: 0, hidden, started: [], acct: r.acct };
  saveView(v);
  return v;
}

/** The text and buttons of one page of a list. */
export function renderView(v: View): { text: string; rows: Button[][] } {
  const pages = Math.max(1, Math.ceil(v.items.length / PAGE));
  const page = Math.min(v.page, pages - 1);
  const slice = v.items.slice(page * PAGE, page * PAGE + PAGE);
  const head = `<b>${esc(v.title)}</b>${v.hidden ? `\n<i>أخفيت ${v.hidden} عندك منهم</i>` : ''}${v.acct ? `\n<i>نسبتك ${v.acct.ratio} (↑ ${v.acct.upGB.toFixed(0)} GB · ↓ ${v.acct.downGB.toFixed(0)} GB)</i>` : ''}`;
  if (!slice.length) return { text: `${head}\n\nما في شي جديد هون. 🙂`, rows: [[{ text: '🏠 القائمة', data: 'tor:menu' }]] };
  const lines = slice.map((x, i) => {
    const n = page * PAGE + i + 1;
    const done = v.started.includes(x.hash);
    return `${done ? '⏳' : `<b>${n}.</b>`} ${esc(x.name.slice(0, 90))}${x.trusted ? ' ✅' : ''}${x.ap?.free ? ' 🆓' : ''}\n    ${x.sizeGB} GB · 🌱 ${x.seeders} · ${x.added}`;
  });
  const dl: Button[] = slice.map((x, i) => {
    const n = page * PAGE + i + 1;
    return v.started.includes(x.hash) ? { text: `✓ ${n}`, data: 'tor:x' } : { text: `⬇️ ${n}`, data: `tor:dl:${v.id}:${n}` };
  });
  const nav: Button[] = [];
  if (page > 0) nav.push({ text: '⬅️', data: `tor:pg:${v.id}:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, data: 'tor:x' });
  if (page < pages - 1) nav.push({ text: '➡️', data: `tor:pg:${v.id}:${page + 1}` });
  nav.push({ text: '🏠', data: 'tor:menu' });
  return { text: `${head}\n\n${lines.join('\n')}`, rows: [dl, nav] };
}

const menuText = () => '🧲 <b>تورنت</b>\nشو بدك تشوف؟ أو اكتب <code>/torrent اسم الفلم</code> للبحث.\n<i>ما بعرضلك شي نزّلته قبل.</i>';

async function statusText(): Promise<string> {
  const { torrents } = await listTorrents();
  const archive = archiveStatus();
  if (!torrents.length && !archive.length) return '📥 <b>تنزيلاتي</b>\nما في تنزيلات.';
  return `📥 <b>تنزيلاتي</b>\n${torrents
    .slice(0, 10)
    .map((t) => `${t.percent >= 100 ? '✅' : '⬇️'} ${esc(t.name.slice(0, 60))}\n    ${t.percent}% · ${t.sizeGB} GB${t.percent < 100 && t.speedMBs ? ` · ${t.speedMBs} MB/s` : ''}${t.etaMin ? ` · ${t.etaMin < 60 ? `${t.etaMin} د` : `${Math.round(t.etaMin / 60)} س`}` : ''}`)
    .join('\n')}${archive.length ? `\n${archive.join('\n')}` : ''}`;
}
const statusRows: Button[][] = [
  [
    { text: '🔄 تحديث', data: 'tor:st' },
    { text: '🏠 القائمة', data: 'tor:menu' },
  ],
];

const CAT_WORDS: Record<string, string> = { ...Object.fromEntries(Object.keys(TPB_CATEGORIES).map((k) => [k, k])), film: 'movies', films: 'movies', movie: 'movies', series: 'tv', show: 'tv', game: 'games', app: 'apps', book: 'ebooks', books: 'ebooks', أفلام: 'movies', فلم: 'movies', فيلم: 'movies', مسلسل: 'tv', مسلسلات: 'tv', موسيقى: 'music', العاب: 'games', ألعاب: 'games', برامج: 'apps', كتب: 'ebooks' };

interface Update {
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number }; message_id: number } };
}

/** One /torrent message or button press. */
export async function torrentUpdate(u: Update): Promise<{ ok: boolean; did: string }> {
  const html = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  if (u.message) {
    const chat_id = u.message.chat.id;
    const text = (u.message.text ?? '').trim();
    const send = (t: string, rows: Button[][]) => tg('sendMessage', { chat_id, text: t, reply_markup: keyboard(rows), ...html });
    if (/^\/torrents(@\w+)?$/i.test(text)) {
      await send(await statusText(), statusRows);
      return { ok: true, did: 'status' };
    }
    const words = text.replace(/^\/torrent(@\w+)?/i, '').trim();
    if (!words) {
      await send(menuText(), MENU);
      return { ok: true, did: 'menu' };
    }
    // Arabic words (or "عربي …") search ArabP2P, the Arabic tracker; the rest search The Pirate Bay.
    if (/[\u0600-\u06FF]/.test(words) && !CAT_WORDS[words.split(/\s+/)[0]]) {
      const q = words.replace(/^عربي\s+/, '');
      const v = await makeApView(`🔍 ${q}`, await apSearch(q));
      const r = renderView(v);
      await send(v.items.length ? r.text : `🔍 ما لقيت شي جديد لـ «${esc(q)}» على ArabP2P.`, v.items.length ? r.rows : [[{ text: '🏠 القائمة', data: 'tor:menu' }]]);
      return { ok: true, did: 'ap-search' };
    }
    const [first, ...rest] = words.split(/\s+/);
    const cat = CAT_WORDS[first.toLowerCase()] && rest.length ? CAT_WORDS[first.toLowerCase()] : 'all';
    const query = cat === 'all' ? words : rest.join(' ');
    const v = await makeView(`🔍 ${query}${cat !== 'all' ? ` · ${cat}` : ''}`, await tpb(`q.php?q=${encodeURIComponent(query.slice(0, 120))}&cat=${TPB_CATEGORIES[cat] ?? 0}`));
    const r = renderView(v);
    await send(v.items.length ? r.text : `🔍 ما لقيت شي جديد لـ «${esc(query)}»${v.hidden ? ` (أخفيت ${v.hidden} عندك)` : ''}.\nجرّب كلمات أقل أو بالإنجليزي.`, v.items.length ? r.rows : [[{ text: '🏠 القائمة', data: 'tor:menu' }]]);
    return { ok: true, did: 'search' };
  }
  const q = u.callback_query;
  if (!q?.data || !q.message) return { ok: true, did: 'nothing' };
  const chat_id = q.message.chat.id;
  const message_id = q.message.message_id;
  const edit = (t: string, rows: Button[][]) => tg('editMessageText', { chat_id, message_id, text: t, reply_markup: keyboard(rows), ...html });
  const answer = (text?: string) => tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  const [, kind, a, b] = q.data.split(':');
  try {
    if (kind === 'menu') {
      await answer();
      await edit(menuText(), MENU);
    } else if (kind === 'ap') {
      await answer();
      await edit('🇸🇦 <b>ArabP2P</b> · أحدث المرفوعات\nأو اكتب <code>/torrent</code> وبعدها اسم عربي للبحث.', AP_MENU);
    } else if (kind === 'apc' && AP_TITLE[a]) {
      await answer('⏳');
      const r = renderView(await makeApView(AP_TITLE[a], await apLatest(Number(a))));
      await edit(r.text, r.rows);
    } else if (kind === 'st') {
      await answer('🔄');
      await edit(await statusText(), statusRows);
    } else if (kind === 'm' && SOURCES[a]) {
      await answer('⏳');
      const src = SOURCES[a];
      const rows = (await Promise.all(src.files.map((f) => tpb(`precompiled/${f}.json`).catch(() => [] as TpbRow[])))).flat();
      const r = renderView(await makeView(src.title, rows));
      await edit(r.text, r.rows);
    } else if (kind === 'pg') {
      const v = getView(a);
      if (!v) return (await answer('هالقائمة قديمة، افتحها من جديد'), { ok: true, did: 'stale' });
      v.page = Math.max(0, Number(b) || 0);
      saveView(v);
      await answer();
      const r = renderView(v);
      await edit(r.text, r.rows);
    } else if (kind === 'dl') {
      const v = getView(a);
      const item = v?.items[(Number(b) || 0) - 1];
      if (!v || !item) return (await answer('هالقائمة قديمة، افتحها من جديد'), { ok: true, did: 'stale' });
      if (v.started.includes(item.hash)) return (await answer('بلّش من قبل ⏳'), { ok: true, did: 'again' });
      const res = item.ap ? await addApTorrent(item.ap, v.acct ?? null) : await addTorrent(magnetOf(item.hash, item.name));
      if (!res.ok) return (await answer(`⚠️ ${res.message.slice(0, 150)}`), { ok: false, did: 'refused' });
      remember(item.hash, item.name);
      if (item.ap && !item.ap.free && v.acct) v.acct.downGB = +(v.acct.downGB + item.ap.sizeGB).toFixed(2); // the guard counts this one next time
      v.started.push(item.hash);
      saveView(v);
      await answer('⬇️ بلش التنزيل · بيوصلك مسج لما يخلص');
      const r = renderView(v);
      await edit(r.text, r.rows);
    } else await answer();
    return { ok: true, did: kind };
  } catch (e) {
    await answer(`⚠️ ${(e as Error).message.slice(0, 150)}`);
    return { ok: false, did: 'error' };
  }
}
