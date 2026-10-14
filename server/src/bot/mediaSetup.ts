import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { kvSet } from '../db.js';
import { qb } from './apps.js';
import { postHook } from './hook.js';
import { FOLDERS, jf, LIB, LIBRARIES, linkInto, parseRelease, destination, placed } from './mediaLibrary.js';
import { config } from '../config.js';

/**
 * One-time switch to the media library on the Toshiba (run after its full surface scan passed):
 *  1. folders: Media/{Movies,Series,Cartoons,Cartoon Series,Anime,Documentaries,Videos}, Downloads/Torrents;
 *  2. qBittorrent: torrents paused, their files moved to the Toshiba, /downloads re-pointed there, resumed;
 *  3. Jellyfin: the Toshiba's Media mounted, one library per folder (Arabic subtitles), the old
 *     "Torrents" library removed;
 *  4. films from files/Videos moved onto the Toshiba into Movies;
 *  5. the library turned on (NovaOS's mediaLibrary.ts sorts every finished torrent from then on).
 * Compose files are backed up next to themselves first. `--dry-run` only prints the plan.
 * Usage: node dist/bot/mediaSetup.js [--dry-run]
 */
const DRY = process.argv.includes('--dry-run');
const OLD_DOWNLOADS = path.join(config.dataRoot, 'files', 'Downloads');
const OLD_VIDEOS = path.join(config.dataRoot, 'files', 'Videos');
const log: string[] = [];
const say = (s: string) => {
  log.push(s);
  console.log(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function compose(app: string, edit: (yaml: string) => string) {
  const f = path.join(config.appsDir, app, 'compose.yaml');
  const before = fs.readFileSync(f, 'utf8');
  const after = edit(before);
  if (after === before) return say(`${app}: compose already up to date`);
  if (DRY) return say(`${app}: would edit compose.yaml (backup first)`);
  fs.copyFileSync(f, `${f}.bak-${stamp}`);
  fs.writeFileSync(f, after);
  execFileSync('docker', ['compose', '-p', `${config.containerPrefix}${app}`, '-f', f, '--env-file', path.join(config.appsDir, app, '.env'), 'up', '-d'], { stdio: 'inherit', timeout: 300_000 });
  say(`${app}: compose edited (backup compose.yaml.bak-${stamp}) and container recreated`);
}

/** Moves a file or folder to another disk (copy, then delete the original). */
function moveAcross(src: string, dest: string) {
  if (DRY) return say(`would move ${src} → ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('mv', ['-n', src, dest], { timeout: 6 * 3600_000 });
}

async function waitFor(what: string, fn: () => Promise<unknown>, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fn();
      return;
    } catch {
      await sleep(3000);
    }
  }
  throw new Error(`${what} did not come back`);
}

async function main() {
  // 0. The disk must be mounted (fstab nofail: if it isn't, the folders would land on the system disk).
  const mounted = execFileSync('findmnt', ['-n', '-o', 'TARGET', LIB.root], { encoding: 'utf8' }).trim();
  if (mounted !== LIB.root) throw new Error(`${LIB.root} is not mounted`);

  // 1. Folders
  for (const k of Object.values(FOLDERS)) if (!DRY) fs.mkdirSync(path.join(LIB.media, k), { recursive: true });
  if (!DRY) fs.mkdirSync(path.join(LIB.downloads, 'Torrents', '.incomplete'), { recursive: true });
  say(`folders ready under ${LIB.media} and ${LIB.downloads}/Torrents`);

  // 2. qBittorrent: pause, move the torrent files, re-point /downloads, resume.
  const pause = async (on: boolean) => {
    // qBittorrent 5 says stop/start; older versions pause/resume.
    const r = await qb(`torrents/${on ? 'stop' : 'start'}`, { hashes: 'all' }).catch(() => null);
    if (!r || r.status === 404) await qb(`torrents/${on ? 'pause' : 'resume'}`, { hashes: 'all' });
  };
  if (!DRY) await pause(true);
  say('torrents paused');
  const oldT = path.join(OLD_DOWNLOADS, 'Torrents');
  if (fs.existsSync(oldT))
    for (const e of fs.readdirSync(oldT)) {
      const dest = path.join(LIB.downloads, 'Torrents', e);
      if (fs.existsSync(dest) && e === '.incomplete') {
        for (const x of fs.readdirSync(path.join(oldT, e))) moveAcross(path.join(oldT, e, x), path.join(dest, x));
        continue;
      }
      moveAcross(path.join(oldT, e), dest);
      say(`moved torrent data: ${e}`);
    }
  compose('qbittorrent', (y) => y.replace(`source: ${OLD_DOWNLOADS}\n        target: /downloads`, `source: ${LIB.downloads}\n        target: /downloads`));
  if (!DRY) {
    await waitFor('qBittorrent', async () => {
      const r = await qb('app/version');
      if (!r.ok) throw new Error('not yet');
    });
    await qb('app/setPreferences', { json: JSON.stringify({ save_path: '/downloads/Torrents', temp_path_enabled: true, temp_path: '/downloads/Torrents/.incomplete' }) });
    await pause(false);
  }
  say('qBittorrent now saves to the Toshiba (Downloads/Torrents); torrents resumed');

  // 3. Jellyfin: mount Media (read-write so subtitles can sit next to the films), drop the old Torrents mount.
  compose('jellyfin', (y) => {
    let out = y;
    const torrents = `      - type: bind\n        source: ${OLD_DOWNLOADS}/Torrents\n        target: /media/Torrents\n        read_only: true\n`;
    out = out.replace(torrents, '');
    if (!out.includes(`target: ${LIB.jfMedia}`)) out = out.replace(`        target: /config\n`, `        target: /config\n      - type: bind\n        source: ${LIB.media}\n        target: ${LIB.jfMedia}\n`);
    return out;
  });
  if (!DRY) await waitFor('Jellyfin', () => jf('/System/Info'));
  const folders = DRY ? [] : await jf<{ Name: string; Locations: string[] }[]>('/Library/VirtualFolders');
  for (const f of folders.filter((x) => x.Locations.some((l) => l.startsWith('/media/Torrents')))) {
    await jf(`/Library/VirtualFolders?name=${encodeURIComponent(f.Name)}&refreshLibrary=false`, { method: 'DELETE' });
    say(`Jellyfin: removed the old library "${f.Name}" (torrents now reach the shelves on their own)`);
  }
  for (const l of LIBRARIES) {
    if (folders.some((f) => f.Name === l.name)) continue;
    const p = path.join(LIB.jfMedia, FOLDERS[l.kind]);
    if (DRY) {
      say(`Jellyfin: would add library "${l.name}" (${l.type}) at ${p}`);
      continue;
    }
    await jf(`/Library/VirtualFolders?name=${encodeURIComponent(l.name)}&collectionType=${l.type}&refreshLibrary=false`, {
      method: 'POST',
      body: {
        LibraryOptions: {
          PathInfos: [{ Path: p }],
          EnableRealtimeMonitor: true,
          SubtitleDownloadLanguages: ['ara'],
          RequirePerfectSubtitleMatch: false,
          SaveSubtitlesWithMedia: true,
          SkipSubtitlesIfEmbeddedSubtitlesPresent: false,
          SkipSubtitlesIfAudioTrackMatches: true,
          PreferredMetadataLanguage: 'en',
          MetadataCountryCode: 'US',
        },
      },
    });
    say(`Jellyfin: library "${l.name}" added`);
  }

  // 4. Films already in files/Videos (a title with a year) move onto the Toshiba into Movies.
  if (fs.existsSync(OLD_VIDEOS))
    for (const e of fs.readdirSync(OLD_VIDEOS)) {
      const full = path.join(OLD_VIDEOS, e);
      const files = fs.statSync(full).isDirectory() ? fs.readdirSync(full).map((x) => path.join(full, x)) : [full];
      const vid = files.find((x) => /\.(mkv|mp4|avi|m4v|mov)$/i.test(x) && fs.statSync(x).size > 300 * 1024 * 1024);
      if (!vid) continue;
      const r = parseRelease(path.basename(vid));
      if (r.kind !== 'movie' || !r.year) continue; // personal videos stay where they are
      const dest = path.join(LIB.media, destination(r, 'movies', path.extname(vid).toLowerCase()));
      moveAcross(vid, dest);
      for (const s of files.filter((x) => /\.(srt|ass|vtt)$/i.test(x))) moveAcross(s, dest.replace(/\.[^.]+$/, `.ar${path.extname(s)}`));
      if (!DRY && fs.statSync(full).isDirectory() && !fs.readdirSync(full).length) fs.rmdirSync(full);
      // Into the library's queue too, so it gets sorted (cartoon/anime/…) and an Arabic subtitle like a new torrent.
      if (!DRY) {
        const list = placed();
        list.push({ hash: `import:${path.basename(vid)}`, src: dest, dest, kind: 'movies', title: r.title, year: r.year, at: Date.now(), sorted: false, subs: 'pending', subTries: 0, told: false });
        kvSet('media_placed', JSON.stringify(list));
      }
      say(`moved film: ${r.title} (${r.year}) → Movies`);
    }

  // 5. On.
  if (!DRY) {
    kvSet('media_library_on', '1');
    await jf('/Library/Refresh', { method: 'POST' }).catch(() => {});
    void linkInto; // (the library code links each finished torrent from now on)
    await postHook({
      type: 'notice',
      text: `🎬 <b>مكتبة الأفلام صارت على التوشيبا</b>\nJellyfin فيه هلأ: أفلام · مسلسلات · كرتون · مسلسلات كرتون · أنمي · وثائقي · فيديوهات\nأي تورنت بيخلص بيترتب لحاله بمكانه وبيجيه ترجمة عربي، وبيوصلك سطر لكل عنوان.\nالتنزيلات صارت على التوشيبا كمان (Downloads/Torrents).`,
    });
  }
  say(DRY ? 'dry run: nothing changed' : 'done');
}

main().catch(async (e: Error) => {
  console.error(e);
  if (!DRY) await postHook({ type: 'notice', text: `⚠️ <b>نقل المكتبة للتوشيبا وقف بالنص</b>\n<code>${String(e.message).slice(0, 200).replace(/[<>&]/g, '')}</code>\nما حذفت شي. اللي صار: ${log.slice(-4).join(' · ').slice(0, 400)}` }).catch(() => {});
  process.exit(1);
});
