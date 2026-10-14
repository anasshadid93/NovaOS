import {
  Apps48Color,
  AppsListDetail32Color,
  BuildingStore24Color,
  ClipboardTask24Color,
  Database48Color,
  DataTrending48Color,
  DocumentFolder24Color,
  Image48Color,
  Notebook24Color,
  Settings48Color,
  Desktop24Filled,
  WindowConsole20Filled,
  ArrowSync24Filled,
  Headphones48Color,
  Bug24Filled,
  Mic48Color,
  ArrowSquareDown32Color,
  History48Color,
  Trophy48Color,
  Video48Color,
  Heart48Color,
  PhoneLaptop32Color,
} from '@fluentui/react-icons';
import type { MessageKey } from '../i18n';
import type { Art } from '../components/AppArt';
import { resolveItem, type LauncherItem } from '../components/LauncherIcon';
import { openExternal } from '../lib/external';
import { fileUrl, type Entry } from '../lib/fm';
import { api } from '../lib/api';
import { wm } from './wm';

/** NovaOS's own screens as desktop apps. */
export interface DeskApp {
  id: string;
  title: MessageKey;
  art: Art;
  route: string;
  w?: number;
  h?: number;
  /** Opened for a file, not listed on the desktop or in Start. */
  hidden?: boolean;
}

export const DESK_APPS: DeskApp[] = [
  { id: 'files', title: 'section.files', art: { kind: 'fluent', glyph: DocumentFolder24Color }, route: '/files', w: 1000, h: 680 },
  { id: 'gallery', title: 'section.gallery', art: { kind: 'fluent', glyph: Image48Color }, route: '/gallery', w: 1000, h: 720 },
  { id: 'voice', title: 'voice.title', art: { kind: 'fluent', glyph: Mic48Color }, route: '/voice', w: 440, h: 720 },
  { id: 'music', title: 'music.title', art: { kind: 'fluent', glyph: Headphones48Color }, route: '/music', w: 520, h: 760 },
  { id: 'monitor', title: 'section.monitor', art: { kind: 'fluent', glyph: DataTrending48Color }, route: '/monitor', w: 760, h: 760 },
  { id: 'processes', title: 'section.processes', art: { kind: 'fluent', glyph: AppsListDetail32Color }, route: '/processes', w: 820, h: 680 },
  { id: 'docker', title: 'section.docker', art: { kind: 'fluent', glyph: Apps48Color }, route: '/docker', w: 860, h: 700 },
  { id: 'store', title: 'section.apps', art: { kind: 'fluent', glyph: BuildingStore24Color }, route: '/store', w: 900, h: 720 },
  { id: 'disks', title: 'section.disks', art: { kind: 'fluent', glyph: Database48Color }, route: '/disks', w: 760, h: 640 },
  { id: 'downloads', title: 'section.downloads', art: { kind: 'fluent', glyph: ArrowSquareDown32Color }, route: '/downloads', w: 820, h: 720 },
  { id: 'backup', title: 'section.backup', art: { kind: 'fluent', glyph: History48Color }, route: '/backup', w: 820, h: 720 },
  { id: 'games', title: 'section.games', art: { kind: 'fluent', glyph: Trophy48Color }, route: '/games', w: 820, h: 720 },
  { id: 'watch', title: 'section.watch', art: { kind: 'fluent', glyph: Video48Color }, route: '/watch', w: 820, h: 720 },
  { id: 'health', title: 'section.health', art: { kind: 'fluent', glyph: Heart48Color }, route: '/health', w: 820, h: 720 },
  { id: 'network', title: 'section.network', art: { kind: 'fluent', glyph: PhoneLaptop32Color }, route: '/network', w: 820, h: 720 },
  { id: 'tasks', title: 'section.tasks', art: { kind: 'fluent', glyph: ClipboardTask24Color }, route: '/tasks', w: 720, h: 600 },
  { id: 'terminal', title: 'term.title', art: { kind: 'gradient', from: '#334155', to: '#0b1220', glyph: WindowConsole20Filled }, route: '/terminal', w: 900, h: 560 },
  // REA (reverse engineering, CLI only): a terminal that starts it.
  { id: 'rea', title: 'rea.title', art: { kind: 'gradient', from: '#7c3aed', to: '#1e1b4b', glyph: Bug24Filled }, route: '/terminal?run=rea', w: 960, h: 600 },
  { id: 'display', title: 'display.title', art: { kind: 'gradient', from: '#5b8def', to: '#1a3a7c', glyph: Desktop24Filled }, route: '/display', w: 640, h: 600 },
  { id: 'updates', title: 'upd.title', art: { kind: 'gradient', from: '#22c55e', to: '#15803d', glyph: ArrowSync24Filled }, route: '/updates', w: 720, h: 720 },
  { id: 'settings', title: 'section.settings', art: { kind: 'fluent', glyph: Settings48Color }, route: '/settings', w: 760, h: 700 },
  { id: 'viewer', title: 'desk.viewer', art: { kind: 'fluent', glyph: Image48Color }, route: '/view', w: 1000, h: 720, hidden: true },
  { id: 'wallpaper', title: 'wall.title', art: { kind: 'fluent', glyph: Image48Color }, route: '/wallpaper', w: 820, h: 720, hidden: true },
  { id: 'editor', title: 'desk.editor', art: { kind: 'fluent', glyph: Notebook24Color }, route: '/edit', w: 820, h: 620, hidden: true },
];

/** The desktop is a real folder in the library, so its files are also in Files on every device. */
export const DESKTOP_DIR = 'files/Desktop';

const TEXT_RE = /\.(txt|md|markdown|csv|tsv|log|json|ya?ml|toml|ini|conf|cfg|env|sh|bash|zsh|py|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|xml|sql|go|rs|java|c|h|cpp|hpp|rb|php|lua|dockerfile|gitignore|service|desktop)$/i;

/** Double-click on a file anywhere on the desktop: folders in Files, media in the viewer, text in the editor. */
export function openFile(e: Entry) {
  const q = `?path=${encodeURIComponent(e.path)}`;
  if (e.type === 'dir') return wm.open({ app: 'files', title: e.name, route: `/files${q}`, w: 1000, h: 680, newWindow: true });
  if (TEXT_RE.test(e.name) || /^(readme|license|makefile|dockerfile)$/i.test(e.name)) return wm.open({ app: 'editor', title: e.name, route: `/edit${q}`, w: 820, h: 620 });
  if (e.cat === 'images' || e.cat === 'videos' || e.cat === 'audio' || /\.pdf$/i.test(e.name)) return wm.open({ app: 'viewer', title: e.name, route: `/view${q}`, w: 1000, h: 720 });
  const a = document.createElement('a');
  a.href = fileUrl(e.path, true);
  a.click();
}

export const deskApp = (id: string) => DESK_APPS.find((a) => a.id === id);

export function openDeskApp(a: DeskApp, title: string, route?: string) {
  wm.open({ app: a.id, title, route: route ?? a.route, w: a.w, h: a.h });
}

/** Which web apps allow being shown in a window (the server reads their headers). */
let frames: Record<string, boolean> = {};
export const loadFrames = () =>
  api<Record<string, boolean>>('/api/launcher/frames')
    .then((f) => (frames = f))
    .catch(() => frames);

export const opensInWindow = (key: string) => !!frames[key];

/** A web app (service, installed app, ArtCraft): in a window if it allows that, else in a browser tab. */
export function openWebApp(original: LauncherItem) {
  const item = resolveItem(original);
  if (!item.url) return;
  void fetch('/api/launcher/open', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: item.key }) });
  if (frames[item.key]) wm.open({ app: `web:${item.key}`, title: item.title, route: item.url, w: 1200, h: 780 });
  else openExternal(item.url);
}
