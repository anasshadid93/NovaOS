import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/sessions.js';
import { addTorrent, magnetOf, qbList, searchTorrents } from '../bot/apps.js';
import { addApTorrent, search as apSearch, shelfFor, type ApItem } from '../bot/arabp2p.js';
import { jf, jfRaw } from '../bot/mediaLibrary.js';
import { appUrl, installedApp } from '../store/installer.js';

/** Where the browser opens Jellyfin: the store app's tailnet address. */
const jellyfinBase = () => {
  const a = installedApp('jellyfin');
  return a ? (appUrl(a)?.replace(/\/$/, '') ?? null) : null;
};

/**
 * "I want to watch": find a film or series (TMDB through Jellyfin's own search — posters, year, an
 * Arabic summary), see whether it's already in the library, and get it with one tap: the best-seeded
 * sensible release from TPB, or an Arabic-dubbed one from ArabP2P (its ratio guard applies). The
 * download lands on the right shelf and gets its Arabic subtitle like any other (mediaLibrary.ts).
 * Plus "what's new" in Jellyfin.
 */

type Kind = 'movie' | 'series';
interface Remote {
  Name: string;
  ProviderIds?: Record<string, string>;
  ProductionYear?: number;
  PremiereDate?: string;
  ImageUrl?: string;
  Overview?: string;
}
interface LibItem {
  Id: string;
  Name: string;
  Type: string;
  ProviderIds?: Record<string, string>;
}

let libCache: { at: number; items: LibItem[] } = { at: 0, items: [] };
async function libraryIds(): Promise<Map<string, LibItem>> {
  if (Date.now() - libCache.at > 60_000) {
    const r = await jf<{ Items: LibItem[] }>('/Items?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds').catch(() => ({ Items: [] as LibItem[] }));
    libCache = { at: Date.now(), items: r.Items };
  }
  const m = new Map<string, LibItem>();
  for (const it of libCache.items) for (const [k, v] of Object.entries(it.ProviderIds ?? {})) m.set(`${k.toLowerCase()}:${v}`, it);
  return m;
}

const year = (r: Remote) => r.ProductionYear ?? (r.PremiereDate ? +r.PremiereDate.slice(0, 4) : undefined);
const tmdbPath = (u?: string) => (u && /^https:\/\/image\.tmdb\.org(\/t\/p\/)original(\/[\w-]+\.(jpg|png))$/.exec(u) ? u.replace('https://image.tmdb.org', '').replace('/original/', '/w342/') : null);

/** Both languages: the English name (what releases are called) and the Arabic name and summary. */
export async function find(q: string, kind: Kind) {
  const ep = kind === 'movie' ? 'Movie' : 'Series';
  const body = (lang: string) => ({ SearchInfo: { Name: q.slice(0, 100), MetadataLanguage: lang }, IncludeDisabledProviders: false });
  const [en, ar, lib] = await Promise.all([
    jf<Remote[]>(`/Items/RemoteSearch/${ep}`, { method: 'POST', body: body('en') }).catch(() => [] as Remote[]),
    jf<Remote[]>(`/Items/RemoteSearch/${ep}`, { method: 'POST', body: body('ar') }).catch(() => [] as Remote[]),
    libraryIds(),
  ]);
  const arBy = new Map(ar.map((r) => [r.ProviderIds?.Tmdb, r]));
  return en.slice(0, 12).map((r) => {
    const tmdb = r.ProviderIds?.Tmdb;
    const a = tmdb ? arBy.get(tmdb) : undefined;
    const have = tmdb ? lib.get(`tmdb:${tmdb}`) : undefined;
    return { tmdb, kind, name: r.Name, nameAr: a?.Name && a.Name !== r.Name ? a.Name : null, year: year(r), overview: a?.Overview || r.Overview || '', poster: tmdbPath(a?.ImageUrl ?? r.ImageUrl), inLibrary: have ? { id: have.Id } : null };
  });
}

const BAD = /\b(cam|hdcam|camrip|ts|hdts|telesync|tc|hdtc|telecine|scr|screener|hindi|tamil|telugu|korsub|hc)\b/i;
/** Releases worth getting: right title and year, no cams, a sensible size; best first. */
export async function options(name: string, y: number | undefined, kind: Kind, season?: number) {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['the', 'and', 'of'].includes(w));
  const q = kind === 'movie' ? `${name} ${y ?? ''}` : `${name} ${season ? `S${String(season).padStart(2, '0')}` : ''}`;
  const { results } = await searchTorrents(q.replace(/[:'’]/g, ' ').trim(), kind === 'movie' ? 'video' : 'video', 20).catch(() => ({ results: [] }));
  const have = new Set((await qbList().catch(() => [])).map((t) => t.hash.toUpperCase()));
  return results
    .filter((r) => {
      const n = r.name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
      if (BAD.test(r.name) || !words.every((w) => n.includes(w))) return false;
      if (kind === 'movie') return (!y || r.name.includes(String(y))) && r.sizeGB > 0.6 && r.sizeGB < 30;
      return r.sizeGB > 0.1 && r.sizeGB < 120;
    })
    .map((r) => {
      let score = Math.log10(1 + r.seeders) * 10;
      if (/1080p/i.test(r.name)) score += 6;
      else if (/720p/i.test(r.name)) score += 3;
      if (/2160p|4k|remux/i.test(r.name)) score -= 4; // big and heavy to stream to a phone
      if (r.trusted) score += 2;
      if (kind === 'movie' && r.sizeGB > 12) score -= 3;
      if (kind === 'series' && /complete|season|S\d\d(?!E)/i.test(r.name)) score += 4;
      return { hash: r.hash!, name: r.name, sizeGB: r.sizeGB, seeders: r.seeders, trusted: r.trusted, score: Math.round(score), have: have.has(r.hash!.toUpperCase()) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

const JF_ID = /^[a-f0-9]{32}$/;
const CARD_FIELDS = 'ProductionYear,RunTimeTicks,CommunityRating,UserData,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,ImageTags,ParentThumbItemId,ParentBackdropItemId,ChildCount';
interface JfCard {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  CommunityRating?: number;
  ImageTags?: { Primary?: string; Thumb?: string };
  ParentThumbItemId?: string;
  ChildCount?: number;
  UserData?: { PlayedPercentage?: number; Played?: boolean; IsFavorite?: boolean; UnplayedItemCount?: number };
}
let uidCache: string | null = null;
async function userId(): Promise<string> {
  uidCache ??= (await jf<{ Id: string }[]>('/Users'))[0]?.Id ?? null;
  return uidCache ?? '';
}
/** One poster card: posters for films/series, episode stills (or the series poster) for episodes. */
function card(i: JfCard) {
  const ep = i.Type === 'Episode';
  return {
    id: i.Id,
    poster: ep ? (i.SeriesId ?? i.Id) : i.Id,
    still: ep ? (i.ImageTags?.Primary ? i.Id : (i.ParentThumbItemId ?? i.SeriesId ?? i.Id)) : i.Id,
    name: ep ? (i.SeriesName ?? i.Name) : i.Name,
    sub: ep ? `S${i.ParentIndexNumber ?? 1}:E${i.IndexNumber ?? '?'} · ${i.Name}` : null,
    type: i.Type,
    year: i.ProductionYear ?? null,
    minutes: i.RunTimeTicks ? Math.round(i.RunTimeTicks / 600_000_000) : null,
    rating: i.CommunityRating ? Math.round(i.CommunityRating * 10) / 10 : null,
    progress: i.UserData?.PlayedPercentage ? i.UserData.PlayedPercentage / 100 : 0,
    played: !!i.UserData?.Played,
    favorite: !!i.UserData?.IsFavorite,
    unplayed: i.UserData?.UnplayedItemCount ?? null,
  };
}

export async function watchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; kind?: string } }>('/api/watch/find', { preHandler: requireAuth }, async (req) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return { results: [] };
    return { results: await find(q, req.query.kind === 'series' ? 'series' : 'movie') };
  });
  app.get<{ Querystring: { name?: string; nameAr?: string; year?: string; kind?: string; season?: string } }>('/api/watch/options', { preHandler: requireAuth }, async (req) => {
    const kind: Kind = req.query.kind === 'series' ? 'series' : 'movie';
    const [tpb, ap] = await Promise.all([
      options(String(req.query.name ?? ''), req.query.year ? +req.query.year : undefined, kind, req.query.season ? +req.query.season : undefined),
      req.query.nameAr ? apSearch(String(req.query.nameAr)).catch(() => null) : Promise.resolve(null),
    ]);
    return { tpb, arabp2p: ap ? { items: ap.items.filter((i) => i.seeders > 0).slice(0, 8), ratio: ap.acct?.ratio ?? null } : null };
  });
  app.post<{ Body: { source?: string; hash?: string; name?: string; kind?: string; item?: ApItem } }>('/api/watch/get', { preHandler: requireAuth }, async (req, reply) => {
    const b = req.body ?? {};
    const shelf = b.kind === 'series' ? 'Series' : 'Movies';
    if (b.source === 'tpb' && /^[A-F0-9]{40}$/i.test(b.hash ?? '')) return addTorrent(magnetOf(b.hash!, String(b.name ?? '')), shelf);
    if (b.source === 'arabp2p' && b.item && /^download\.php\?/.test(b.item.dl) && /^\d+$/.test(b.item.id)) {
      const fresh = await apSearch(b.item.name).catch(() => null);
      const it = fresh?.items.find((x) => x.id === b.item!.id) ?? b.item;
      return { ...(await addApTorrent(it, fresh?.acct ?? null)), shelf: shelfFor(it) };
    }
    return reply.code(400).send({ ok: false, message: 'bad_request' });
  });
  app.get('/api/watch/latest', { preHandler: requireAuth }, async () => {
    const users = await jf<{ Id: string }[]>('/Users').catch(() => []);
    if (!users[0]) return { items: [] };
    const items = await jf<{ Id: string; Name: string; Type: string; SeriesName?: string; SeriesId?: string; ProductionYear?: number; ImageTags?: { Primary?: string }; DateCreated?: string }[]>(
      `/Users/${users[0].Id}/Items/Latest?Limit=30&Fields=DateCreated,ProductionYear&IncludeItemTypes=Movie,Episode,Series`,
    ).catch(() => []);
    return {
      items: items.map((i) => ({ id: i.ImageTags?.Primary ? i.Id : (i.SeriesId ?? i.Id), itemId: i.Id, name: i.SeriesName ?? i.Name, sub: i.SeriesName ? i.Name : null, type: i.Type, year: i.ProductionYear, added: i.DateCreated })),
    };
  });
  // ---- Jellyfin-style home: continue watching, next up, latest per library, library grids, details ----
  app.get('/api/watch/home', { preHandler: requireAuth }, async () => {
    const uid = await userId();
    if (!uid) return { resume: [], nextUp: [], libraries: [], jellyfin: jellyfinBase() };
    const [resume, nextUp, views] = await Promise.all([
      jf<{ Items: JfCard[] }>(`/Users/${uid}/Items/Resume?Limit=20&MediaTypes=Video&Fields=${CARD_FIELDS}`).catch(() => ({ Items: [] })),
      jf<{ Items: JfCard[] }>(`/Shows/NextUp?UserId=${uid}&Limit=20&Fields=${CARD_FIELDS}`).catch(() => ({ Items: [] })),
      jf<{ Items: { Id: string; Name: string; CollectionType?: string }[] }>(`/Users/${uid}/Views`).catch(() => ({ Items: [] })),
    ]);
    const libs = views.Items.filter((v) => ['movies', 'tvshows', 'homevideos'].includes(v.CollectionType ?? ''));
    const latest = await Promise.all(
      libs.map((v) => jf<JfCard[]>(`/Users/${uid}/Items/Latest?ParentId=${v.Id}&Limit=20&Fields=${CARD_FIELDS}`).catch(() => [] as JfCard[])),
    );
    return {
      jellyfin: jellyfinBase(),
      resume: resume.Items.map(card),
      nextUp: nextUp.Items.map(card),
      libraries: libs.map((v, i) => ({ id: v.Id, name: v.Name, type: v.CollectionType, items: latest[i].map(card) })).filter((l) => l.items.length),
    };
  });
  app.get<{ Params: { id: string }; Querystring: { sort?: string; genre?: string; start?: string; filter?: string } }>('/api/watch/library/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!JF_ID.test(req.params.id)) return reply.code(400).send();
    const uid = await userId();
    const sort = ({ added: 'DateCreated,SortName', name: 'SortName', year: 'ProductionYear,SortName', rating: 'CommunityRating,SortName', played: 'DatePlayed,SortName' } as Record<string, string>)[req.query.sort ?? 'added'] ?? 'DateCreated,SortName';
    const order = req.query.sort === 'name' ? 'Ascending' : 'Descending';
    const start = Math.max(0, Number(req.query.start) || 0);
    const filters = req.query.filter === 'unplayed' ? '&Filters=IsUnplayed' : req.query.filter === 'favorites' ? '&Filters=IsFavorite' : '';
    const genre = req.query.genre ? `&Genres=${encodeURIComponent(req.query.genre)}` : '';
    const [items, genres] = await Promise.all([
      jf<{ Items: JfCard[]; TotalRecordCount: number }>(
        `/Users/${uid}/Items?ParentId=${req.params.id}&Recursive=true&IncludeItemTypes=Movie,Series,Video&SortBy=${sort}&SortOrder=${order}&StartIndex=${start}&Limit=60&Fields=${CARD_FIELDS}${filters}${genre}`,
      ),
      jf<{ Items: { Name: string }[] }>(`/Genres?UserId=${uid}&ParentId=${req.params.id}`).catch(() => ({ Items: [] })),
    ]);
    return { total: items.TotalRecordCount, items: items.Items.map(card), genres: genres.Items.map((g) => g.Name) };
  });
  app.get<{ Params: { id: string } }>('/api/watch/item/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!JF_ID.test(req.params.id)) return reply.code(400).send();
    const uid = await userId();
    const it = await jf<JfCard & { Overview?: string; Genres?: string[]; Taglines?: string[]; OfficialRating?: string; People?: { Name: string; Type: string }[]; MediaStreams?: { Type: string; Language?: string; DisplayTitle?: string }[]; ChildCount?: number; BackdropImageTags?: string[] }>(
      `/Users/${uid}/Items/${req.params.id}?Fields=Overview,Genres,Taglines,People,MediaStreams,ChildCount,${CARD_FIELDS}`,
    );
    let seasons: { id: string; name: string; episodes: ReturnType<typeof card>[] }[] = [];
    if (it.Type === 'Series') {
      const ss = await jf<{ Items: JfCard[] }>(`/Shows/${it.Id}/Seasons?UserId=${uid}`).catch(() => ({ Items: [] }));
      seasons = await Promise.all(
        ss.Items.map(async (sn) => ({
          id: sn.Id,
          name: sn.Name,
          episodes: (await jf<{ Items: JfCard[] }>(`/Shows/${it.Id}/Episodes?UserId=${uid}&SeasonId=${sn.Id}&Fields=${CARD_FIELDS}`).catch(() => ({ Items: [] }))).Items.map(card),
        })),
      );
    }
    const subs = (it.MediaStreams ?? []).filter((m) => m.Type === 'Subtitle').map((m) => m.Language ?? m.DisplayTitle ?? '?');
    const audio = (it.MediaStreams ?? []).filter((m) => m.Type === 'Audio').map((m) => m.Language ?? m.DisplayTitle ?? '?');
    return {
      ...card(it),
      overview: it.Overview ?? '',
      tagline: it.Taglines?.[0] ?? null,
      genres: it.Genres ?? [],
      officialRating: it.OfficialRating ?? null,
      cast: (it.People ?? []).filter((p) => p.Type === 'Actor').slice(0, 8).map((p) => p.Name),
      subtitles: [...new Set(subs)],
      audio: [...new Set(audio)],
      backdrop: !!it.BackdropImageTags?.length,
      seasons,
      jellyfinUrl: `/web/#/details?id=${it.Id}`,
      jellyfin: jellyfinBase(),
    };
  });
  app.post<{ Params: { id: string; act: string } }>('/api/watch/item/:id/:act', { preHandler: requireAuth }, async (req, reply) => {
    if (!JF_ID.test(req.params.id)) return reply.code(400).send();
    const uid = await userId();
    const path = { played: ['POST', 'PlayedItems'], unplayed: ['DELETE', 'PlayedItems'], favorite: ['POST', 'FavoriteItems'], unfavorite: ['DELETE', 'FavoriteItems'] }[req.params.act];
    if (!path) return reply.code(400).send();
    await jf(`/Users/${uid}/${path[1]}/${req.params.id}`, { method: path[0] });
    return { ok: true };
  });

  // Posters: Jellyfin's and TMDB's, through MinisManager (the page only loads images from itself).
  app.get<{ Params: { id: string }; Querystring: { type?: string } }>('/api/watch/img/:id', { preHandler: requireAuth }, async (req, reply) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return reply.code(400).send();
    const type = req.query.type === 'backdrop' ? 'Backdrop' : req.query.type === 'thumb' ? 'Thumb' : 'Primary';
    const size = type === 'Primary' ? 'maxHeight=420' : 'maxWidth=1280';
    let r = await jfRaw(`/Items/${req.params.id}/Images/${type}?${size}&quality=85`).catch(() => null);
    // An episode without a thumbnail, or a film without a backdrop: fall back to its poster.
    if (!r?.ok && type !== 'Primary') r = await jfRaw(`/Items/${req.params.id}/Images/Primary?maxHeight=420&quality=85`).catch(() => null);
    if (!r?.ok) return reply.code(404).send();
    return reply.header('Content-Type', r.headers.get('content-type') ?? 'image/jpeg').header('Cache-Control', 'private, max-age=86400').send(Buffer.from(await r.arrayBuffer()));
  });
  app.get<{ Querystring: { p?: string } }>('/api/watch/tmdb-img', { preHandler: requireAuth }, async (req, reply) => {
    const p = String(req.query.p ?? '');
    if (!/^\/t\/p\/w\d{2,4}\/[\w-]+\.(jpg|png)$/.test(p)) return reply.code(400).send();
    const r = await fetch(`https://image.tmdb.org${p}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!r?.ok) return reply.code(404).send();
    return reply.header('Content-Type', r.headers.get('content-type') ?? 'image/jpeg').header('Cache-Control', 'private, max-age=604800').send(Buffer.from(await r.arrayBuffer()));
  });
}
