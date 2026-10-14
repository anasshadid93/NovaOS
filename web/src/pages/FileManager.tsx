import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useSearch } from 'wouter';
import {
  Add24Regular,
  ArrowDownload24Regular,
  ArrowSort24Regular,
  ArrowUpload24Regular,
  Camera24Regular,
  CheckmarkCircle24Filled,
  ChevronDown20Regular,
  Circle24Regular,
  Copy24Regular,
  Delete24Regular,
  Dismiss24Regular,
  Eye24Regular,
  FolderAdd24Regular,
  FolderArrowRight24Regular,
  Grid24Regular,
  Home24Regular,
  Image24Filled,
  Info24Regular,
  MoreVertical24Regular,
  Rename24Regular,
  Search24Regular,
  SelectAllOn24Regular,
  TextBulletListLtr24Regular,
  ArrowExportUp24Regular,
  HardDrive24Filled,
  LockClosed24Filled,
  UsbStick24Filled,
  Link24Regular,
  Link16Regular,
  FolderZip24Regular,
  FolderZip16Regular,
} from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { errorKey, fileUrl, list, parentOf, sortEntries, uploadTo, type Category, type Entry, type SortKey } from '../lib/fm';
import { formatBytes } from '../lib/format';
import { useWindowCtx } from '../desktop/context';
import { carriesFiles, carriesPaths, dragPaths, setDragPaths } from '../lib/dnd';
import { useI18n, type MessageKey } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Dialog } from '../components/Dialog';
import { Button, TextField } from '../components/ui';
import { catStyle, EmptyFolderArt, FileIcon } from '../components/fm/FileIcon';
import { FolderPicker } from '../components/fm/FolderPicker';
import { Preview } from '../components/fm/Preview';
import { ShareDialog } from '../components/fm/ShareDialog';
import { PlacesSidebar } from '../components/fm/PlacesSidebar';
import { ContextMenu, type MenuItem } from '../desktop/ContextMenu';
import {
  ArrowClockwise16Regular,
  ArrowDownload16Regular,
  ArrowUpload16Regular,
  Checkmark16Regular,
  Copy16Regular,
  Delete16Regular,
  FolderAdd16Regular,
  FolderArrowRight16Regular,
  Info16Regular,
  Open16Regular,
  Rename16Regular,
  SelectAllOn16Regular,
} from '@fluentui/react-icons';

const CATS: Category[] = ['images', 'videos', 'documents', 'audio', 'ebooks', 'archives', 'installers', 'others'];
const pref = <T,>(k: string, d: T): T => (localStorage.getItem(`manar.fm.${k}`) as T | null) ?? d;
const setPref = (k: string, v: string) => localStorage.setItem(`manar.fm.${k}`, v);

/** "Storage" dropdown like the MinisCloud file manager: places on the left, categories on the right. */
interface Volume {
  id: string;
  name: string;
  transport: string | null;
  removable: boolean;
  size: number;
  used: number | null;
  state: 'mounted' | 'unmounted' | 'encrypted' | 'unsupported';
  path: string | null;
}

/**
 * "Files ⌄" menu like a NAS file manager: every drive (internal storage, USB sticks,
 * other disks) with free space, mount-on-tap and eject; then the recycle bin and categories.
 */
function StorageMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [vols, setVols] = useState<Volume[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const load = useCallback(() => api<Volume[]>('/api/storage/volumes').then(setVols).catch(() => setVols([])), []);
  useEffect(() => {
    if (!open) return;
    setNote('');
    void load();
    // Live while open: drives plugged in or pulled out show up within seconds.
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [open, load]);

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const openVol = async (v: Volume) => {
    setNote('');
    if (v.id === 'internal') return go('/files');
    if (v.state === 'encrypted') return setNote(t('vol.encryptedHint', { name: v.name }));
    if (v.state === 'unsupported') return setNote(t('vol.unsupported'));
    if (v.state === 'mounted' && v.path !== null) return go(`/files?path=${encodeURIComponent(v.path)}`);
    setBusy(v.id);
    try {
      const r = await api<Volume>(`/api/storage/volumes/${v.id}/mount`, { body: {} });
      go(`/files?path=${encodeURIComponent(r.path ?? '')}`);
    } catch (e) {
      setNote(t('vol.failed', { detail: e instanceof ApiError ? e.code : '' }));
    } finally {
      setBusy(null);
    }
  };

  const eject = async (v: Volume) => {
    setBusy(v.id);
    try {
      await api(`/api/storage/volumes/${v.id}/unmount`, { body: {} });
      setNote(t('vol.ejected', { name: v.name }));
      void load();
    } catch (e) {
      setNote(e instanceof ApiError && e.code === 'busy' ? t('vol.busy') : t('fm.err.generic'));
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;
  return (
    <>
      <button type="button" aria-label={t('common.close')} className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      <div className="absolute inset-x-0 top-full z-40 mx-3 max-h-[75dvh] space-y-4 overflow-auto rounded-card bg-surface p-4 shadow-card">
        <div>
          <p className="mb-1 text-xs font-medium text-muted">{t('fm.storage')}</p>
          <ul className="space-y-0.5">
            {(vols ?? [{ id: 'internal', name: 'internal', transport: null, removable: false, size: 0, used: null, state: 'mounted', path: '' } as Volume]).map((v) => {
              const I = v.id === 'internal' ? Home24Regular : v.state === 'encrypted' ? LockClosed24Filled : v.removable || v.transport === 'usb' ? UsbStick24Filled : HardDrive24Filled;
              const name = v.id === 'internal' ? t('vol.internal') : v.name;
              const free = v.used !== null ? Math.max(0, v.size - v.used) : null;
              const sub =
                v.state === 'encrypted'
                  ? t('vol.encrypted')
                  : v.state === 'unsupported'
                    ? t('vol.unsupported')
                    : busy === v.id
                      ? t('vol.mounting')
                      : v.state === 'unmounted'
                        ? `${formatBytes(v.size)} · ${t('vol.notMounted')}`
                        : free !== null
                          ? t('vol.free', { free: formatBytes(free), size: formatBytes(v.size) })
                          : formatBytes(v.size);
              return (
                <li key={v.id} className="flex items-center">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void openVol(v)}
                    className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-start active:bg-primary-soft disabled:opacity-60"
                  >
                    <I className={`shrink-0 ${v.state === 'encrypted' ? 'text-muted' : v.id === 'internal' ? 'text-primary-ink' : 'text-tile-orange'}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span dir="auto" className="block truncate text-start text-sm text-ink">
                        {name}
                      </span>
                      <span className="block truncate text-xs text-muted">{sub}</span>
                    </span>
                  </button>
                  {v.id !== 'internal' && v.state === 'mounted' && v.path !== null && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void eject(v)}
                      aria-label={t('vol.eject', { name })}
                      className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted active:bg-primary-soft"
                    >
                      <ArrowExportUp24Regular aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
            <li>
              <button type="button" onClick={() => go('/files/bin')} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 text-start text-sm text-ink active:bg-primary-soft">
                <Delete24Regular className="shrink-0 text-danger" aria-hidden />
                {t('fm.bin')}
              </button>
            </li>
          </ul>
          {note && (
            <p className="mt-2 rounded-lg bg-canvas p-2 text-xs text-ink" role="status">
              {note}
            </p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-muted">{t('fm.categories')}</p>
          <div className="grid grid-cols-2 gap-0.5">
            {CATS.map((c) => {
              const { icon: CI, bg } = catStyle(c);
              return (
                <button key={c} type="button" onClick={() => go(`/files/c/${c}`)} className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-start text-sm text-ink active:bg-primary-soft">
                  <CI style={{ color: bg }} aria-hidden />
                  {t(`files.cat.${c}` as MessageKey)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

export function FilesHeader({ title, back, extra }: { title: string; back?: string; extra?: React.ReactNode }) {
  const { t } = useI18n();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const [menu, setMenu] = useState(false);
  const win = useWindowCtx();
  // In a desktop window the first screen has nothing to go back to.
  const showBack = !win || win.canGoBack() || `${location}${search ? `?${search}` : ''}` !== win.start;
  return (
    <header className={`${win ? 'pt-2' : 'safe-top'} sticky top-0 z-20 bg-canvas/90 backdrop-blur-md`}>
      <div className="relative flex items-center gap-1 px-2 pb-2">
        {showBack ? (
          <button type="button" onClick={() => (win ? win.back() : navigate(back ?? '/'))} className="inline-flex size-10 items-center justify-center rounded-full text-heading" aria-label={t('common.back')}>
            <ChevronDown20Regular className="rotate-90 rtl:-rotate-90" aria-hidden />
          </button>
        ) : (
          <span className="size-10" aria-hidden />
        )}
        <button type="button" onClick={() => setMenu((v) => !v)} aria-expanded={menu} className="flex min-w-0 flex-1 items-center justify-center gap-1 text-lg font-semibold text-heading">
          <span className="truncate">{title}</span>
          <ChevronDown20Regular className={`shrink-0 transition-transform ${menu ? 'rotate-180' : ''}`} aria-hidden />
        </button>
        {extra}
        <StorageMenu open={menu} onClose={() => setMenu(false)} />
      </div>
    </header>
  );
}

/** Running "Extract" jobs, as a small bar above the bottom of the Files page. */
function ExtractProgress({ onFinished }: { onFinished: () => void }) {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<{ id: number; title: string; progress: string | null }[]>([]);
  const prev = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await api<{ tasks: { id: number; kind: string; title: string; progress: string | null }[] }>('/api/tasks?status=running').catch(() => null);
      if (!alive || !r) return;
      const now = r.tasks.filter((x) => x.kind === 'fs.extract');
      if (now.length < prev.current) onFinished();
      prev.current = now.length;
      setJobs(now);
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!jobs.length) return null;
  return (
    <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-30 mx-auto max-w-md space-y-2">
      {jobs.map((j) => {
        const pct = Number(/(\d+)%/.exec(j.progress ?? '')?.[1] ?? 0);
        return (
          <div key={j.id} className="rounded-2xl bg-surface p-3 shadow-lg" role="status">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate text-heading" dir="auto">
                {t('fm.extractingNow', { name: j.title.replace(/^Extract /, '') })}
              </span>
              <span className="shrink-0 font-semibold text-primary">{pct}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas">
              <div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

const isArchiveName = (n: string) => /\.(zip|rar|7z|tar|tgz|tbz2?|txz|tzst|gz|bz2|xz|zst|iso|cab|lzh|arj|001|wim|dmg)$/i.test(n);

function ActionSheet({ entry, onClose, onAction }: { entry: Entry | null; onClose: () => void; onAction: (a: string) => void }) {
  const { t } = useI18n();
  const items: { key: string; icon: typeof Copy24Regular; label: MessageKey; danger?: boolean; file?: boolean; archive?: boolean }[] = [
    { key: 'open', icon: Eye24Regular, label: 'fm.open' },
    { key: 'extract', icon: FolderZip24Regular, label: 'fm.extract', archive: true },
    { key: 'download', icon: ArrowDownload24Regular, label: 'fm.download', file: true },
    { key: 'rename', icon: Rename24Regular, label: 'fm.rename' },
    { key: 'copy', icon: Copy24Regular, label: 'fm.copy' },
    { key: 'move', icon: FolderArrowRight24Regular, label: 'fm.move' },
    { key: 'share', icon: Link24Regular, label: 'share.action' },
    { key: 'details', icon: Info24Regular, label: 'fm.details' },
    { key: 'delete', icon: Delete24Regular, label: 'fm.delete', danger: true },
  ];
  return (
    <Dialog open={!!entry} onClose={onClose} title={entry?.name ?? ''}>
      <ul className="-mx-2">
        {items
          .filter((i) => (!i.file || entry?.type !== 'dir') && (!i.archive || (entry?.type === 'file' && isArchiveName(entry.name))))
          .map(({ key, icon: I, label, danger }) => (
            <li key={key}>
              <button
                type="button"
                onClick={() => onAction(key)}
                className={`flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-start active:bg-primary-soft ${danger ? 'text-danger' : 'text-ink'}`}
              >
                <I aria-hidden />
                {t(label)}
              </button>
            </li>
          ))}
      </ul>
    </Dialog>
  );
}

function NameDialog({ open, title, label, initial, confirm, onSubmit, onClose }: { open: boolean; title: string; label: string; initial: string; confirm: string; onSubmit: (v: string) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const [v, setV] = useState(initial);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setV(initial);
    setErr('');
    // Pre-select the name without the extension, like desktop file managers.
    setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      const dot = initial.lastIndexOf('.');
      el.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }, 50);
  }, [open, initial]);
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(v.trim()).catch((ex) => setErr(t(errorKey(ex))));
        }}
      >
        <TextField ref={ref} label={label} value={v} onChange={(e) => setV(e.target.value)} autoCapitalize="off" dir="auto" />
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!v.trim()}>
            {confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function FileManager() {
  const { t, tn, formatRelative } = useI18n();
  const ask = useConfirm();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(useSearch());
  // Opens in the organised library (/srv/data/files) unless a path is given; "?path=" is the data root.
  const path = params.get('path') ?? 'files';
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'list' | 'grid'>(pref('view', 'list'));
  const [sort, setSort] = useState<SortKey>(pref('sort', 'name'));
  const [hidden, setHidden] = useState(pref<string>('hidden', '0') === '1');
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [sheet, setSheet] = useState<Entry | null>(null);
  const [sharing, setSharing] = useState<Entry | null>(null);
  const [menu, setMenu] = useState(false);
  const [fab, setFab] = useState(false);
  const [naming, setNaming] = useState<{ kind: 'mkdir' | 'rename'; entry?: Entry } | null>(null);
  const [picker, setPicker] = useState<{ mode: 'move' | 'copy'; paths: string[] } | null>(null);
  const [details, setDetails] = useState<Entry | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [upload, setUpload] = useState<{ done: number; total: number; pct: number } | null>(null);
  const [toast, setToast] = useState('');
  const inputs = { files: useRef<HTMLInputElement>(null), media: useRef<HTMLInputElement>(null), camera: useRef<HTMLInputElement>(null) };
  // Desktop window: mouse selection (click / Ctrl / Shift), double-click opens, right-click menus.
  const win = useWindowCtx();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef(-1);
  const pointer = useRef('mouse');
  const [ctx, setCtx] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries((await list(path, hidden)).entries);
      setError('');
    } catch (e) {
      setEntries([]);
      setError(t(errorKey(e)));
    }
  }, [path, hidden, t]);

  useEffect(() => {
    setEntries(null);
    setSelected(null);
    setPicked(new Set());
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const sorted = useMemo(() => sortEntries(entries ?? [], sort), [entries, sort]);
  const files = useMemo(() => sorted.filter((e) => e.type !== 'dir'), [sorted]);
  const open = (e: Entry) => {
    if (e.type === 'dir') navigate(`/files?path=${encodeURIComponent(e.path)}`);
    else setPreview(files.findIndex((f) => f.path === e.path));
  };

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    try {
      await fn();
      if (okMsg) setToast(okMsg);
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'confirm_required')) setToast(t(errorKey(e)));
    }
    await load();
  };

  const extract = (e: Entry) =>
    run(async () => {
      const r = await api<{ folder: string }>('/api/fs/extract', { body: { path: e.path } });
      setToast(t('fm.extracting', { folder: r.folder.split('/').pop() ?? '' }));
    });

  const remove = async (paths: string[]) => {
    const one = paths.length === 1;
    const ok = await ask({
      title: one ? t('fm.deleteTitle.one', { name: paths[0].split('/').pop()! }) : t('fm.deleteTitle.other', { n: paths.length }),
      body: t('fm.deleteBody'),
      confirmLabel: t('fm.delete'),
      danger: true,
    });
    if (ok) await run(() => api('/api/fs/delete', { body: { paths } }));
    setSelected(null);
    setPreview(null);
  };

  const onAction = (a: string) => {
    const e = sheet!;
    setSheet(null);
    if (a === 'open') open(e);
    else if (a === 'download') location.href = fileUrl(e.path, true);
    else if (a === 'rename') setNaming({ kind: 'rename', entry: e });
    else if (a === 'extract') void extract(e);
    else if (a === 'copy' || a === 'move') setPicker({ mode: a, paths: [e.path] });
    else if (a === 'share') setSharing(e);
    else if (a === 'details') setDetails(e);
    else if (a === 'delete') void remove([e.path]);
  };

  const doUpload = async (list: FileList | null) => {
    if (!list?.length) return;
    const all = Array.from(list);
    setFab(false);
    setUpload({ done: 0, total: all.length, pct: 0 });
    let done = 0;
    try {
      // Batches of 10 keep progress meaningful and avoid one huge request.
      for (let i = 0; i < all.length; i += 10) {
        const batch = all.slice(i, i + 10);
        await uploadTo(path, batch, (l, tot) => setUpload({ done, total: all.length, pct: Math.round((l / tot) * 100) }));
        done += batch.length;
      }
      setToast(tn('fm.uploaded', done));
    } catch (e) {
      setToast(t(errorKey(e)));
    } finally {
      setUpload(null);
      for (const r of Object.values(inputs)) if (r.current) r.current.value = '';
      void load();
    }
  };

  // Drag & drop (desktop): files from the computer upload here; files from the desktop or
  // another Files window move here, or into the folder they're dropped on.
  const [dropOn, setDropOn] = useState<string | null>(null);
  const dropInto = (ev: React.DragEvent, dest: string) => {
    ev.preventDefault();
    ev.stopPropagation();
    setDropOn(null);
    const paths = dragPaths(ev);
    if (paths) {
      const real = paths.filter((p) => parentOf(p) !== dest && p !== dest && !dest.startsWith(p + '/'));
      if (!real.length) return;
      void api('/api/fs/transfer', { body: { paths: real, dest, mode: 'move' } })
        .then(() => setToast(tn('fm.moved', real.length)))
        .catch((e) => setToast(t(errorKey(e))))
        .finally(() => void load());
    } else if (dest === path && ev.dataTransfer.files.length) void doUpload(ev.dataTransfer.files);
  };
  const dragTarget = (dest: string) => ({
    onDragOver: (ev: React.DragEvent) => {
      if (!carriesPaths(ev) && !(carriesFiles(ev) && dest === path)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setDropOn(dest);
    },
    onDragLeave: (ev: React.DragEvent) => ev.currentTarget === ev.target && setDropOn(null),
    onDrop: (ev: React.DragEvent) => dropInto(ev, dest),
  });
  const dragSource = (e: Entry) => ({
    draggable: true,
    onDragStart: (ev: React.DragEvent) => setDragPaths(ev, sel?.has(e.path) ? [...sel] : [e.path]),
  });

  const deskMouse = () => !!win && pointer.current === 'mouse';
  const clickItem = (ev: React.MouseEvent, e: Entry, idx: number) => {
    if (sel) return toggle(e.path);
    if (!deskMouse()) return open(e);
    if (ev.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, idx), Math.max(anchor.current, idx)];
      setPicked(new Set(sorted.slice(a, b + 1).map((x) => x.path)));
      return;
    }
    if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(picked);
      if (next.has(e.path)) next.delete(e.path);
      else next.add(e.path);
      setPicked(next);
    } else setPicked(new Set([e.path]));
    anchor.current = idx;
  };
  const itemMenu = (e: Entry): MenuItem[] => {
    const many = picked.has(e.path) && picked.size > 1;
    const targets = many ? [...picked] : [e.path];
    return [
      ...(many ? [] : [{ label: t('fm.open'), icon: Open16Regular, onClick: () => open(e) }]),
      ...(!many && e.type === 'file' ? [{ label: t('fm.download'), icon: ArrowDownload16Regular, onClick: () => (location.href = fileUrl(e.path, true)) }] : []),
      ...(!many && e.type === 'file' && isArchiveName(e.name) ? [{ label: t('fm.extract'), icon: FolderZip16Regular, onClick: () => void extract(e) }] : []),
      { label: t('fm.copy'), icon: Copy16Regular, onClick: () => setPicker({ mode: 'copy', paths: targets }) },
      { label: t('fm.move'), icon: FolderArrowRight16Regular, onClick: () => setPicker({ mode: 'move', paths: targets }) },
      ...(many ? [] : [{ label: t('fm.rename'), icon: Rename16Regular, onClick: () => setNaming({ kind: 'rename', entry: e }) }]),
      ...(many ? [] : [{ label: t('share.action'), icon: Link16Regular, onClick: () => setSharing(e) }]),
      { separator: true, label: '' },
      ...(many ? [] : [{ label: t('props.title'), icon: Info16Regular, onClick: () => setDetails(e) }]),
      { label: many ? tn('fm.deleteN', targets.length) : t('fm.delete'), icon: Delete16Regular, danger: true, onClick: () => void remove(targets) },
    ];
  };
  const backgroundMenu = (): MenuItem[] => [
    { label: t('fm.newFolder'), icon: FolderAdd16Regular, onClick: () => setNaming({ kind: 'mkdir' }) },
    { label: t('fm.upload'), icon: ArrowUpload16Regular, onClick: () => inputs.files.current?.click() },
    { label: t('desk.refresh'), icon: ArrowClockwise16Regular, onClick: () => void load() },
    { label: t('fm.selectAll'), icon: SelectAllOn16Regular, onClick: () => setPicked(new Set(sorted.map((x) => x.path))) },
    { separator: true, label: '' },
    ...(['list', 'grid'] as const).map((v) => ({ label: t(`fm.view.${v}`), icon: view === v ? Checkmark16Regular : undefined, onClick: () => (setView(v), setPref('view', v)) })),
    { separator: true, label: '' },
    ...(['name', 'date', 'size'] as const).map((k) => ({ label: t(`fm.sort.${k}`), icon: sort === k ? Checkmark16Regular : undefined, onClick: () => (setSort(k), setPref('sort', k)) })),
    { separator: true, label: '' },
    { label: hidden ? t('fm.hideHidden') : t('fm.showHidden'), onClick: () => (setHidden(!hidden), setPref('hidden', hidden ? '0' : '1')) },
  ];
  const onDeskKey = (ev: React.KeyboardEvent) => {
    if (!win || (ev.target as HTMLElement).closest('input, textarea')) return;
    const chosen = sorted.filter((x) => picked.has(x.path));
    if (ev.key === 'Delete' && chosen.length) void remove(chosen.map((x) => x.path));
    else if (ev.key === 'F2' && chosen.length === 1) setNaming({ kind: 'rename', entry: chosen[0] });
    else if (ev.key === 'Enter' && chosen.length === 1) open(chosen[0]);
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') setPicked(new Set(sorted.map((x) => x.path)));
    else if (ev.key === 'Escape') setPicked(new Set());
    else if (ev.key === 'Backspace' && path) navigate(`/files?path=${encodeURIComponent(parentOf(path))}`);
    else return;
    ev.preventDefault();
  };

  const crumbs = path ? path.split('/') : [];
  const sel = selected;
  const toggle = (p: string) => {
    const next = new Set(sel ?? []);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSelected(next);
  };
  const iconBtn = 'inline-flex size-10 items-center justify-center rounded-full text-heading active:bg-primary-soft';

  const body = (
    <>
      {sel ? (
        <header className="safe-top sticky top-0 z-20 flex items-center gap-2 bg-canvas/90 px-2 pb-2 backdrop-blur-md">
          <button type="button" className={iconBtn} onClick={() => setSelected(null)} aria-label={t('common.cancel')}>
            <Dismiss24Regular aria-hidden />
          </button>
          <span className="flex-1 font-semibold text-heading">{tn('fm.selected', sel.size)}</span>
          <button type="button" className={iconBtn} onClick={() => setSelected(new Set(sorted.map((e) => e.path)))} aria-label={t('fm.selectAll')}>
            <SelectAllOn24Regular aria-hidden />
          </button>
        </header>
      ) : (
        <FilesHeader
          title={t('fm.title')}
          extra={
            <>
              <Link href={`/files/search?path=${encodeURIComponent(path)}`} className={iconBtn} aria-label={t('fm.search')}>
                <Search24Regular aria-hidden />
              </Link>
              <button type="button" className={iconBtn} onClick={() => setMenu(true)} aria-label={t('fm.more')}>
                <MoreVertical24Regular aria-hidden />
              </button>
            </>
          }
        />
      )}

      {/* Breadcrumbs */}
      <nav aria-label={t('fm.location')} className="mx-auto max-w-md overflow-x-auto px-3 pb-2">
        <ol className="flex items-center gap-1 whitespace-nowrap text-sm">
          <li>
            <Link href="/files?path=" className={`rounded-lg px-2 py-1 ${path ? 'text-primary-ink' : 'font-semibold text-heading'}`}>
              {t('fm.root')}
            </Link>
          </li>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join('/');
            const last = i === crumbs.length - 1;
            return (
              <li key={p} className="flex items-center gap-1">
                <span className="flip-rtl text-muted" aria-hidden>
                  ›
                </span>
                {last ? (
                  <span dir="auto" className="rounded-lg px-2 py-1 font-semibold text-heading" aria-current="page">
                    {c}
                  </span>
                ) : (
                  <Link href={`/files?path=${encodeURIComponent(p)}`} dir="auto" className="rounded-lg px-2 py-1 text-primary-ink">
                    {c}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <main
        tabIndex={win ? -1 : undefined}
        onKeyDown={onDeskKey}
        onPointerDown={(ev) => win && !(ev.target as HTMLElement).closest('li') && setPicked(new Set())}
        onContextMenu={(ev) => {
          if (!win || (ev.target as HTMLElement).closest('li')) return;
          ev.preventDefault();
          setCtx({ x: ev.clientX, y: ev.clientY, items: backgroundMenu() });
        }}
        className={`mx-auto min-h-[60vh] max-w-md px-3 pb-28 outline-none ${dropOn === path ? 'rounded-2xl bg-primary/5 ring-2 ring-primary/40' : ''}`}
        {...dragTarget(path)}
      >
        {upload && (
          <div className="card mb-3 p-3" role="status">
            <p className="mb-2 text-sm text-ink">{t('fm.uploading', { done: upload.done, total: upload.total, pct: `${upload.pct}%` })}</p>
            <div className="h-2 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${((upload.done + upload.pct / 100) / upload.total) * 100}%` }} />
            </div>
          </div>
        )}
        {error && <p className="mb-3 rounded-xl bg-danger/10 p-3 text-sm text-danger-ink">{error}</p>}

        {entries === null ? (
          <p className="py-16 text-center text-sm text-muted">{t('common.loading')}</p>
        ) : sorted.length === 0 && !error ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <EmptyFolderArt />
            <p className="font-medium text-ink">{t('fm.empty')}</p>
            <p className="text-sm text-muted">{t('fm.emptyHint')}</p>
          </div>
        ) : view === 'grid' ? (
          <ul className="grid grid-cols-3 gap-2 @2xl:grid-cols-5 @5xl:grid-cols-7">
            {sorted.map((e, idx) => {
              const on = sel?.has(e.path) || picked.has(e.path);
              return (
                <li key={e.path} className="relative">
                  <button
                    type="button"
                    onPointerDown={(ev) => (pointer.current = ev.pointerType || 'mouse')}
                    onClick={(ev) => clickItem(ev, e, idx)}
                    onDoubleClick={() => deskMouse() && !sel && open(e)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      if (!win) return setSheet(e);
                      if (!picked.has(e.path)) setPicked(new Set([e.path]));
                      setCtx({ x: ev.clientX, y: ev.clientY, items: itemMenu(e) });
                    }}
                    {...dragSource(e)}
                    {...(e.type === 'dir' ? dragTarget(e.path) : {})}
                    className={`flex w-full flex-col items-center gap-1 rounded-xl p-2 ${dropOn === e.path ? 'bg-primary/20 ring-2 ring-primary' : on ? 'bg-primary-soft' : 'bg-surface shadow-card'} active:scale-[0.98]`}
                  >
                    <FileIcon entry={e} size={84} />
                    <span dir="auto" className="line-clamp-2 w-full break-all text-center text-xs leading-tight text-ink">
                      {e.name}
                    </span>
                  </button>
                  {sel ? (
                    <span className="pointer-events-none absolute end-2 top-2">{on ? <CheckmarkCircle24Filled className="text-primary" /> : <Circle24Regular className="text-muted" />}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSheet(e)}
                      aria-label={`${t('fm.more')}: ${e.name}`}
                      className="absolute end-1 top-1 inline-flex size-8 items-center justify-center rounded-full bg-surface/80 text-muted backdrop-blur"
                    >
                      <MoreVertical24Regular className="size-5" aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="overflow-hidden rounded-list bg-surface shadow-card">
            {sorted.map((e, idx) => {
              const on = sel?.has(e.path) || picked.has(e.path);
              return (
                <li key={e.path} className={`flex items-center border-line [&+&]:border-t ${dropOn === e.path ? 'bg-primary/20' : on ? 'bg-primary-soft' : ''}`}>
                  <button
                    type="button"
                    onPointerDown={(ev) => (pointer.current = ev.pointerType || 'mouse')}
                    onClick={(ev) => clickItem(ev, e, idx)}
                    onDoubleClick={() => deskMouse() && !sel && open(e)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      if (!win) return setSheet(e);
                      if (!picked.has(e.path)) setPicked(new Set([e.path]));
                      setCtx({ x: ev.clientX, y: ev.clientY, items: itemMenu(e) });
                    }}
                    {...dragSource(e)}
                    {...(e.type === 'dir' ? dragTarget(e.path) : {})}
                    className="flex min-h-16 min-w-0 flex-1 items-center gap-3 ps-3 text-start active:bg-primary-soft"
                  >
                    {sel && (on ? <CheckmarkCircle24Filled className="shrink-0 text-primary" /> : <Circle24Regular className="shrink-0 text-muted" />)}
                    <FileIcon entry={e} />
                    <span className="min-w-0 flex-1 py-2">
                      <span dir="auto" className="block truncate text-start text-[0.95rem] text-ink">
                        {e.name}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {e.type === 'dir' ? (e.items === undefined ? t('fm.folder') : tn('fm.items', e.items)) : formatBytes(e.size)} · {formatRelative(e.mtime)}
                      </span>
                    </span>
                  </button>
                  {!sel && (
                    <button type="button" className={`${iconBtn} me-1 text-muted`} onClick={() => setSheet(e)} aria-label={`${t('fm.more')}: ${e.name}`}>
                      <MoreVertical24Regular aria-hidden />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {/* Bottom bar for multi-select, otherwise the + button */}
      {sel ? (
        <div className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 px-3 pt-2 backdrop-blur-md">
          <div className="mx-auto grid max-w-md grid-cols-3 gap-2">
            <Button variant="secondary" className="min-h-11 flex-col gap-0 text-xs" disabled={!sel.size} onClick={() => setPicker({ mode: 'copy', paths: [...sel] })}>
              <Copy24Regular aria-hidden />
              {t('fm.copy')}
            </Button>
            <Button variant="secondary" className="min-h-11 flex-col gap-0 text-xs" disabled={!sel.size} onClick={() => setPicker({ mode: 'move', paths: [...sel] })}>
              <FolderArrowRight24Regular aria-hidden />
              {t('fm.move')}
            </Button>
            <Button variant="secondary" className="min-h-11 flex-col gap-0 text-xs text-danger" disabled={!sel.size} onClick={() => void remove([...sel])}>
              <Delete24Regular aria-hidden />
              {t('fm.delete')}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setFab(true)}
          aria-label={t('fm.upload')}
          className="fixed bottom-[max(env(safe-area-inset-bottom),1.25rem)] end-5 z-30 inline-flex size-14 items-center justify-center rounded-full bg-primary text-white shadow-lg active:scale-95"
        >
          <Add24Regular aria-hidden />
        </button>
      )}

      <ExtractProgress onFinished={() => void load()} />

      {toast && (
        <div role="status" className="fixed inset-x-0 bottom-24 z-40 mx-auto w-fit max-w-[90%] rounded-full bg-ink px-4 py-2 text-sm text-surface shadow-lg">
          {toast}
        </div>
      )}

      <input ref={inputs.files} type="file" multiple hidden onChange={(e) => void doUpload(e.target.files)} />
      <input ref={inputs.media} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => void doUpload(e.target.files)} />
      <input ref={inputs.camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void doUpload(e.target.files)} />

      {/* + menu */}
      <Dialog open={fab} onClose={() => setFab(false)} title={t('fm.title')}>
        <div className="grid grid-cols-2 gap-3">
          {[
            { icon: ArrowUpload24Regular, label: t('fm.upload'), on: () => inputs.files.current?.click() },
            { icon: Image24Filled, label: t('fm.uploadMedia'), on: () => inputs.media.current?.click() },
            { icon: Camera24Regular, label: t('fm.camera'), on: () => inputs.camera.current?.click() },
            {
              icon: FolderAdd24Regular,
              label: t('fm.newFolder'),
              on: () => {
                setFab(false);
                setNaming({ kind: 'mkdir' });
              },
            },
          ].map(({ icon: I, label, on }) => (
            <button key={label} type="button" onClick={on} className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl bg-primary-soft p-3 text-sm text-primary-ink active:scale-[0.98]">
              <I className="size-7" aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </Dialog>

      {/* ⋮ menu: view, sort, select, hidden files */}
      <Dialog open={menu} onClose={() => setMenu(false)} title={t('fm.more')}>
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-canvas p-1">
          {(['list', 'grid'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => {
                setView(v);
                setPref('view', v);
              }}
              className={`flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm ${view === v ? 'bg-surface font-medium text-heading shadow-card' : 'text-muted'}`}
            >
              {v === 'list' ? <TextBulletListLtr24Regular aria-hidden /> : <Grid24Regular aria-hidden />}
              {t(`fm.view.${v}`)}
            </button>
          ))}
        </div>
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm text-muted">
            <ArrowSort24Regular aria-hidden />
            {t('fm.sort')}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {(['name', 'date', 'size'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={sort === s}
                onClick={() => {
                  setSort(s);
                  setPref('sort', s);
                }}
                className={`min-h-10 rounded-full text-sm ${sort === s ? 'bg-primary text-white' : 'bg-primary-soft text-primary-ink'}`}
              >
                {t(`fm.sort.${s}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setMenu(false);
              setSelected(new Set());
            }}
          >
            {t('fm.select')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setHidden(!hidden);
              setPref('hidden', hidden ? '0' : '1');
              setMenu(false);
            }}
          >
            {hidden ? t('fm.hideHidden') : t('fm.showHidden')}
          </Button>
        </div>
      </Dialog>

      <ActionSheet entry={sheet} onClose={() => setSheet(null)} onAction={onAction} />

      <NameDialog
        open={!!naming}
        title={naming?.kind === 'rename' ? t('fm.rename') : t('fm.newFolder')}
        label={naming?.kind === 'rename' ? t('fm.newName') : t('fm.folderName')}
        initial={naming?.entry?.name ?? ''}
        confirm={naming?.kind === 'rename' ? t('fm.save') : t('fm.create')}
        onClose={() => setNaming(null)}
        onSubmit={async (v) => {
          if (naming?.kind === 'rename') await api('/api/fs/rename', { body: { path: naming.entry!.path, name: v } });
          else await api('/api/fs/mkdir', { body: { path, name: v } });
          setNaming(null);
          await load();
        }}
      />

      <FolderPicker
        open={!!picker}
        start={path}
        title={picker?.mode === 'copy' ? t('fm.copy') : t('fm.move')}
        confirmLabel={picker?.mode === 'copy' ? t('fm.copyHere') : t('fm.moveHere')}
        onClose={() => setPicker(null)}
        onPick={(dest) => {
          const p = picker!;
          setPicker(null);
          setSelected(null);
          void run(() => api('/api/fs/transfer', { body: { paths: p.paths, dest, mode: p.mode } }), t('fm.done'));
        }}
      />

      <Dialog open={!!details} onClose={() => setDetails(null)} title={details?.name ?? ''}>
        {details && (
          <dl className="space-y-2 text-sm">
            {[
              [t('fm.type'), details.type === 'dir' ? t('fm.folder') : t(`files.cat.${details.cat ?? 'others'}` as MessageKey)],
              [t('fm.size'), details.type === 'dir' ? tn('fm.items', details.items ?? 0) : formatBytes(details.size)],
              [t('fm.modified'), new Date(details.mtime).toLocaleString()],
              [t('fm.location'), parentOf(details.path) || '/'],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-muted">{k}</dt>
                <dd dir="auto" className="min-w-0 break-all text-end text-ink">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        )}
        <Button variant="secondary" className="w-full" onClick={() => setDetails(null)}>
          {t('common.close')}
        </Button>
      </Dialog>

      <ShareDialog target={sharing} onClose={() => setSharing(null)} />

      {preview !== null && files[preview] && (
        <Preview items={files} index={preview} onIndex={setPreview} onClose={() => setPreview(null)} onDelete={(e) => void remove([e.path])} />
      )}

      {/* The desktop's menus live on the desktop layer (windows clip their own content). */}
      {ctx && createPortal(<ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />, document.querySelector('.desktop') ?? document.body)}
    </>
  );

  if (!win) return body;
  // Desktop window: places on the side once the window is wide enough.
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 hidden max-h-screen w-52 shrink-0 self-start overflow-y-auto border-e border-line bg-surface/50 @3xl:block">
        <PlacesSidebar current={path} onDrop={(ev, dest) => dropInto(ev, dest)} />
      </aside>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}
