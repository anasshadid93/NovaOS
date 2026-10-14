import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowClockwise16Regular,
  ArrowDownload16Regular,
  ArrowUpload16Regular,
  Delete16Regular,
  DocumentAdd16Regular,
  FolderAdd16Regular,
  FolderOpen16Regular,
  Board16Regular,
  Desktop16Regular,
  ImageEdit16Regular,
  Open16Regular,
  Rename16Regular,
  Settings16Regular,
  ArrowUndo16Regular,
  ClipboardPaste16Regular,
  Copy16Regular,
  Cut16Regular,
  Eye16Regular,
  EyeOff16Regular,
  Info16Regular,
  Pin16Regular,
  PinOff16Regular,
  WindowNew16Regular,
  ArrowMove20Regular,
  TextSortAscending16Regular,
  Link16Regular,
} from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { errorKey, fileUrl, list, parentOf, uploadTo, type Entry } from '../lib/fm';
import { carriesFiles, carriesPaths, dragPaths, setDragPaths } from '../lib/dnd';
import { useI18n } from '../i18n';
import { useConfirm } from '../components/ConfirmProvider';
import { Dialog } from '../components/Dialog';
import { formatBytes } from '../lib/format';
import { FileIcon } from '../components/fm/FileIcon';
import { ShareDialog } from '../components/fm/ShareDialog';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { DESKTOP_DIR, openFile } from './apps';
import { setWallpaper } from './wallpaper';
import { TASKBAR_H, wm } from './wm';
import { clip, ordered, setGroups, setList, toggleIn, useDeskLists, type AppGroup } from './prefs';
import { TrashArt } from './TrashArt';
import { FolderArt, FolderPanel } from './AppFolder';

export interface Shortcut {
  key: string;
  title: string;
  icon: ReactNode;
  open: () => void;
  /** MinisManager screens can open a second window. */
  openNew?: () => void;
  /** Rows for the Properties sheet. */
  props: [string, string][];
}

const SHORTCUT_MIME = 'application/x-minis-shortcut';
const TRASH_KEY = 'trash';
const GROUP = 'grp:';

/** Dropping on the middle of an icon puts the two in a folder; on its edges it just moves there. */
const onMiddle = (el: Element, x: number, y: number) => {
  const r = el.getBoundingClientRect();
  return x > r.left + r.width * 0.22 && x < r.right - r.width * 0.22 && y > r.top + r.height * 0.08 && y < r.top + r.height * 0.68;
};
/** A folder's first name: the word its apps share ("DesignCraft" + "PhotoCraft" → "Craft"), else none. */
const sharedWord = (a: string, b: string) => {
  const words = (t: string) => t.split(/\s+|(?<=[a-z])(?=[A-Z])/).filter((w) => w.length > 2 && !/^\(/.test(w));
  const other = new Set(words(b).map((w) => w.toLowerCase()));
  return words(a).find((w) => other.has(w.toLowerCase())) ?? '';
};

const nextName = (base: string, taken: Set<string>, ext = '') => {
  if (!taken.has(base + ext)) return base + ext;
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
};

/**
 * The desktop surface: app shortcuts, then the files in ~/files/Desktop. Files dragged in from
 * the computer are uploaded there; files dragged from a Files window are moved there.
 */
export function DesktopIcons({
  shortcuts,
  onSettings,
  onWallpaper,
  onWidgets,
  onDisplay,
  onDark,
  endInset = 0,
}: {
  shortcuts: Shortcut[];
  onSettings: () => void;
  onWallpaper: () => void;
  onWidgets: (x: number, y: number) => void;
  onDisplay: () => void;
  onDark: boolean;
  /** Room kept free on the far side for the widget column. */
  endInset?: number;
}) {
  const { t, tn } = useI18n();
  const [files, setFiles] = useState<Entry[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [toast, setToast] = useState<string>('');
  const [progress, setProgress] = useState<number | null>(null);
  const toastTimer = useRef<number>(undefined);
  const lastPos = useRef({ x: 0, y: 0 });
  const lastPointer = useRef<string>('mouse');
  const notePointer = (e: React.PointerEvent) => (lastPointer.current = e.pointerType || 'mouse');
  const ask = useConfirm();
  const lists = useDeskLists();
  const [sharing, setSharing] = useState<Entry | null>(null);
  const [props, setProps] = useState<{ title: string; rows: [string, string][] } | null>(null);
  const [trashCount, setTrashCount] = useState(0);
  const [, rerender] = useState(0);

  // Long-press on touch screens opens the same menu as a right-click.
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const holdHandlers = (openMenu: (x: number, y: number) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      notePointer(e);
      if (e.pointerType === 'mouse') return;
      const { clientX: x, clientY: y } = e;
      hold.current = { fired: false, timer: window.setTimeout(() => hold.current && ((hold.current.fired = true), navigator.vibrate?.(12), openMenu(x, y)), 500) };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (hold.current && e.pointerType !== 'mouse' && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) clearTimeout(hold.current.timer);
    },
    onPointerUp: () => hold.current && clearTimeout(hold.current.timer),
    onPointerCancel: () => hold.current && clearTimeout(hold.current.timer),
  });
  /** A tap that ended a long-press must not also open the item. */
  const consumedByHold = () => {
    const fired = !!hold.current?.fired;
    hold.current = null;
    return fired;
  };

  const say = (msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 4000);
  };

  const load = useCallback(async () => {
    void api<unknown[]>('/api/fs/trash')
      .then((l) => setTrashCount(l.length))
      .catch(() => {});
    try {
      setFiles((await list(DESKTOP_DIR, false)).entries);
    } catch (e) {
      // First time: create the Desktop folder in the library.
      if (e instanceof ApiError && e.status === 404) {
        await api('/api/fs/mkdir', { body: { path: 'files', name: 'Desktop' } }).catch(() => {});
        setFiles([]);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 10_000);
    const onFocus = () => void load();
    addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      removeEventListener('focus', onFocus);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) say(ok);
    } catch (e) {
      say(t(errorKey(e)));
    }
    void load();
  };

  const upload = async (list: File[], dir = DESKTOP_DIR) => {
    if (!list.length) return;
    setProgress(0);
    await act(
      async () => {
        for (let i = 0; i < list.length; i += 10)
          await uploadTo(dir, list.slice(i, i + 10), (l, tot) => setProgress(Math.round(((i + (l / tot) * Math.min(10, list.length - i)) / list.length) * 100)));
      },
      tn('fm.uploaded', list.length),
    );
    setProgress(null);
  };

  const move = (paths: string[], dest: string) => {
    const real = paths.filter((p) => parentOf(p) !== dest && p !== dest && !dest.startsWith(p + '/'));
    if (real.length) void act(() => api('/api/fs/transfer', { body: { paths: real, dest, mode: 'move' } }));
  };

  const remove = (paths: string[]) => void act(() => api('/api/fs/delete', { body: { paths } }), tn('desk.trashed', paths.length));

  const setClip = (mode: 'copy' | 'move', paths: string[]) => {
    clip.mode = mode;
    clip.paths = paths;
    say(tn(mode === 'copy' ? 'desk.copied' : 'desk.cut', paths.length));
    rerender((n) => n + 1);
  };
  const paste = (dest: string) => {
    if (!clip.mode || !clip.paths.length) return;
    const { mode, paths } = clip;
    if (mode === 'move') {
      clip.mode = null;
      clip.paths = [];
    }
    void act(() => api('/api/fs/transfer', { body: { paths: paths.filter((p) => p !== dest && !dest.startsWith(p + '/')), dest, mode } }), tn('fm.moved', paths.length));
  };

  const openTrash = () => wm.open({ app: 'files', title: t('desk.trash'), route: '/files/bin', w: 820, h: 620 });
  const emptyTrash = async () => {
    if (!(await ask({ title: t('desk.emptyTrashTitle'), body: tn('desk.emptyTrashBody', trashCount), confirmLabel: t('desk.emptyTrash'), danger: true }))) return;
    void act(() => api('/api/fs/trash/purge', { body: { all: true } }), t('desk.trashEmptied'));
  };
  const restoreAll = () =>
    void act(async () => {
      const items = await api<{ id: string }[]>('/api/fs/trash');
      if (items.length) await api('/api/fs/trash/restore', { body: { ids: items.map((i) => i.id) } });
    });
  const trashMenu: MenuItem[] = [
    { label: t('fm.open'), icon: Open16Regular, onClick: openTrash },
    { label: t('desk.restoreAll'), icon: ArrowUndo16Regular, disabled: !trashCount, onClick: restoreAll },
    { label: t('desk.arrange'), icon: ArrowMove20Regular, onClick: startArrange },
    { separator: true, label: '' },
    { label: t('desk.emptyTrash'), icon: Delete16Regular, danger: true, disabled: !trashCount, onClick: () => void emptyTrash() },
  ];

  const fileProps = (e: Entry): [string, string][] => [
    [t('props.name'), e.name],
    [t('props.type'), e.type === 'dir' ? t('props.folder') : (e.name.includes('.') ? e.name.split('.').pop()!.toUpperCase() + ' · ' : '') + t(`files.cat.${e.cat ?? 'others'}` as never)],
    [t('props.location'), parentOf(e.path) || '/'],
    ...(e.type === 'dir' ? ([[t('props.items'), String(e.items ?? '–')]] as [string, string][]) : ([[t('props.size'), formatBytes(e.size)]] as [string, string][])),
    [t('props.modified'), new Date(e.mtime).toLocaleString()],
  ];

  const shortcutMenu = (s: Shortcut): MenuItem[] => {
    const pinned = lists.pinned.includes(s.key);
    return [
      { label: t('fm.open'), icon: Open16Regular, onClick: s.open },
      ...(s.openNew ? [{ label: t('desk.newWindow'), icon: WindowNew16Regular, onClick: s.openNew }] : []),
      { separator: true, label: '' },
      { label: t(pinned ? 'desk.unpin' : 'desk.pin'), icon: pinned ? PinOff16Regular : Pin16Regular, onClick: () => toggleIn('pinned', s.key) },
      { label: t('desk.hideIcon'), icon: EyeOff16Regular, onClick: () => toggleIn('hidden', s.key) },
      { label: t('desk.arrange'), icon: ArrowMove20Regular, onClick: startArrange },
      { separator: true, label: '' },
      { label: t('props.title'), icon: Info16Regular, onClick: () => setProps({ title: s.title, rows: s.props }) },
    ];
  };

  // Drag a shortcut onto another to put it there.
  const reorder = (from: string, to: string) => {
    if (from === to) return;
    const keys = items.map((x) => x.key);
    const rest = keys.filter((k) => k !== from);
    rest.splice(rest.indexOf(to), 0, from);
    setList('order', rest);
  };

  // Mouse drag of app icons: onto an icon's middle makes a folder, onto its edge moves it there.
  const shortcutDrop = (key: string) => ({
    onDragOver: (ev: React.DragEvent) => {
      if (!ev.dataTransfer.types.includes(SHORTCUT_MIME)) return;
      ev.preventDefault();
      ev.stopPropagation();
      setDropOn(onMiddle(ev.currentTarget, ev.clientX, ev.clientY) ? `sc:${key}` : null);
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (ev: React.DragEvent) => {
      const from = ev.dataTransfer.getData(SHORTCUT_MIME);
      if (!from) return;
      ev.preventDefault();
      ev.stopPropagation();
      setDropOn(null);
      if (!(onMiddle(ev.currentTarget, ev.clientX, ev.clientY) && merge(from, key, currentOrder()))) reorder(from, key);
    },
  });

  const taken = new Set(files.map((f) => f.name));
  const newFolder = () =>
    void act(async () => {
      const r = await api<{ path: string }>('/api/fs/mkdir', { body: { path: DESKTOP_DIR, name: nextName(t('desk.newFolderName'), taken) } });
      setRenaming(r.path);
    });
  const newText = () =>
    void act(async () => {
      const r = await api<{ path: string }>('/api/fs/write', { body: { dir: DESKTOP_DIR, name: nextName(t('desk.newTextName'), taken, '.txt'), text: '' } });
      setRenaming(r.path);
    });
  const pickUpload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => void upload(Array.from(input.files ?? []));
    input.click();
  };

  const selectedEntries = () => files.filter((f) => sel.has(f.path));

  const fileMenu = (e: Entry): MenuItem[] => {
    const many = sel.size > 1 && sel.has(e.path);
    const paths = many ? [...sel] : [e.path];
    return [
      { label: t('fm.open'), icon: Open16Regular, onClick: () => (many ? selectedEntries().forEach(openFile) : openFile(e)) },
      ...(e.type === 'file'
        ? [
            { label: t('fm.download'), icon: ArrowDownload16Regular, onClick: () => paths.forEach((p) => window.open(fileUrl(p, true), '_self')) },
            { label: t('desk.openInFiles'), icon: FolderOpen16Regular, onClick: () => wm.open({ app: 'files', title: t('section.files'), route: `/files?path=${encodeURIComponent(DESKTOP_DIR)}` }) },
          ]
        : []),
      ...(e.cat === 'images' && !many ? [{ label: t('wall.setThis'), icon: ImageEdit16Regular, onClick: () => void setWallpaper({ kind: 'file', path: e.path }) }] : []),
      { separator: true, label: '' },
      { label: t('desk.copy'), icon: Copy16Regular, onClick: () => setClip('copy', paths) },
      { label: t('desk.cutMove'), icon: Cut16Regular, onClick: () => setClip('move', paths) },
      ...(e.type === 'dir' && clip.mode ? [{ label: t('desk.pasteInto'), icon: ClipboardPaste16Regular, onClick: () => paste(e.path) }] : []),
      { label: t('fm.rename'), icon: Rename16Regular, disabled: many, onClick: () => setRenaming(e.path) },
      { label: t('fm.delete'), icon: Delete16Regular, danger: true, onClick: () => remove(paths) },
      { separator: true, label: '' },
      { label: t('desk.arrange'), icon: ArrowMove20Regular, onClick: startArrange },
      { label: t('share.action'), icon: Link16Regular, disabled: many, onClick: () => setSharing(e) },
      { label: t('props.title'), icon: Info16Regular, disabled: many, onClick: () => setProps({ title: e.name, rows: fileProps(e) }) },
    ];
  };

  const backgroundMenu: MenuItem[] = [
    ...(clip.mode
      ? [
          { label: tn('desk.paste', clip.paths.length), icon: ClipboardPaste16Regular, onClick: () => paste(DESKTOP_DIR) },
          { separator: true, label: '' },
        ]
      : []),
    { label: t('desk.newFolder'), icon: FolderAdd16Regular, onClick: newFolder },
    { label: t('desk.newText'), icon: DocumentAdd16Regular, onClick: newText },
    { label: t('desk.upload'), icon: ArrowUpload16Regular, onClick: pickUpload },
    { separator: true, label: '' },
    { label: t('desk.refresh'), icon: ArrowClockwise16Regular, onClick: () => void load() },
    { label: t('desk.arrange'), icon: ArrowMove20Regular, onClick: startArrange },
    {
      label: t('desk.sortByName'),
      icon: TextSortAscending16Regular,
      // Alphabetical; the Recycle Bin stays last.
      onClick: () =>
        setList(
          'order',
          baseItems
            .filter((i) => i.kind !== 'trash')
            .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
            .map((i) => i.key)
            .concat(TRASH_KEY),
        ),
    },
    ...(lists.hidden.length ? [{ label: tn('desk.showHidden', lists.hidden.length), icon: Eye16Regular, onClick: () => setList('hidden', []) }] : []),
    { label: t('desk.openInFiles'), icon: FolderOpen16Regular, onClick: () => wm.open({ app: 'files', title: t('section.files'), route: `/files?path=${encodeURIComponent(DESKTOP_DIR)}` }) },
    { label: t('wall.change'), icon: ImageEdit16Regular, onClick: onWallpaper },
    // Opens the widget list where this menu was (after this menu has closed).
    { label: t('display.title'), icon: Desktop16Regular, onClick: onDisplay },
    { label: t('desk.widgets'), icon: Board16Regular, onClick: () => setTimeout(() => onWidgets(lastPos.current.x, lastPos.current.y), 0) },
    { label: t('desk.settings'), icon: Settings16Regular, onClick: onSettings },
  ];

  // Keyboard on the desktop itself (not inside windows or inputs).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const chosen = selectedEntries();
    if (e.key === 'Delete' && chosen.length) remove(chosen.map((f) => f.path));
    else if (e.key === 'F2' && chosen.length === 1) setRenaming(chosen[0].path);
    else if (e.key === 'Enter' && chosen.length) chosen.forEach(openFile);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') setSel(new Set(files.map((f) => f.path)));
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && chosen.length)
      setClip(
        'copy',
        chosen.map((f) => f.path),
      );
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && chosen.length)
      setClip(
        'move',
        chosen.map((f) => f.path),
      );
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clip.mode) paste(DESKTOP_DIR);
    else return;
    e.preventDefault();
  };

  const onDrop = (e: React.DragEvent, dest = DESKTOP_DIR) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOn(null);
    const paths = dragPaths(e);
    if (paths) move(paths, dest);
    else if (e.dataTransfer.files.length) void upload(Array.from(e.dataTransfer.files), dest);
  };
  const accepts = (e: React.DragEvent) => carriesPaths(e) || carriesFiles(e);

  // ---- Icon order (apps and desktop files together) and arrange mode --------------------------
  type Item =
    | { key: string; kind: 'sc'; s: Shortcut }
    | { key: string; kind: 'grp'; g: AppGroup; apps: Shortcut[] }
    | { key: string; kind: 'file'; f: Entry }
    | { key: string; kind: 'trash' };
  const fileKey = (f: Entry) => `f:${f.name}`;
  const byKey = new Map(shortcuts.filter((x) => !lists.hidden.includes(x.key)).map((x) => [x.key, x]));
  const folders = lists.groups.map((g) => ({ g, apps: g.keys.flatMap((k) => byKey.get(k) ?? []) })).filter((x) => x.apps.length);
  const inFolder = new Set(lists.groups.flatMap((g) => g.keys));
  const baseItems: Item[] = [
    ...[...byKey.values()].filter((x) => !inFolder.has(x.key)).map((x) => ({ key: x.key, kind: 'sc' as const, s: x })),
    ...folders.map(({ g, apps }) => ({ key: GROUP + g.id, kind: 'grp' as const, g, apps })),
    ...files.map((f) => ({ key: fileKey(f), kind: 'file' as const, f })),
    { key: TRASH_KEY, kind: 'trash' as const },
  ];
  const nameOf = (i: Item) => (i.kind === 'sc' ? i.s.title : i.kind === 'grp' ? i.g.name || t('desk.folder') : i.kind === 'file' ? i.f.name : '');
  const [arranging, setArranging] = useState(false);
  const [live, setLive] = useState<string[] | null>(null);
  const liveRef = useRef<string[] | null>(null);
  liveRef.current = live;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const items = ordered(baseItems, (i) => i.key, live ?? lists.order);

  // ---- App folders --------------------------------------------------------------------------
  const [openFolder, setOpenFolder] = useState<{ id: string; rename: boolean } | null>(null);
  /** Puts app `from` into the folder `to`, or makes a folder of the two apps. */
  const merge = (from: string, to: string, order: string[]) => {
    if (from === to || from.startsWith(GROUP) || !byKey.has(from)) return false;
    const rest = order.filter((k) => k !== from);
    if (to.startsWith(GROUP)) {
      const id = to.slice(GROUP.length);
      setGroups(lists.groups.map((g) => (g.id === id ? { ...g, keys: [...g.keys.filter((k) => k !== from), from] } : g)));
      setList('order', rest);
      return true;
    }
    const a = byKey.get(to);
    if (!a) return false;
    const id = 'g' + Date.now().toString(36);
    setGroups([...lists.groups, { id, name: sharedWord(a.title, byKey.get(from)!.title), keys: [to, from] }]);
    setList(
      'order',
      rest.map((k) => (k === to ? GROUP + id : k)),
    );
    navigator.vibrate?.(15);
    return true;
  };
  const mergeRef = useRef(merge);
  mergeRef.current = merge;
  const currentOrder = () => items.map((i) => i.key);
  /** Removes the folder; its apps go back on the desktop where the folder was. */
  const ungroup = (id: string, extra: string[] = []) => {
    const g = lists.groups.find((x) => x.id === id);
    if (!g) return;
    setGroups(lists.groups.filter((x) => x.id !== id));
    setList(
      'order',
      currentOrder().flatMap((k) => (k === GROUP + id ? [...g.keys.filter((x) => !extra.includes(x)), ...extra] : [k])),
    );
    setOpenFolder(null);
  };
  const takeOut = (id: string, key: string) => {
    const g = lists.groups.find((x) => x.id === id);
    if (!g) return;
    const keys = g.keys.filter((k) => k !== key);
    if (keys.length < 2) return ungroup(id, [key]);
    setGroups(lists.groups.map((x) => (x.id === id ? { ...x, keys } : x)));
    setList(
      'order',
      currentOrder().flatMap((k) => (k === GROUP + id ? [k, key] : [k])),
    );
  };
  const renameFolder = (id: string, name: string) => setGroups(lists.groups.map((g) => (g.id === id ? { ...g, name } : g)));
  const folderMenu = (g: AppGroup): MenuItem[] => [
    { label: t('fm.open'), icon: Open16Regular, onClick: () => setOpenFolder({ id: g.id, rename: false }) },
    { label: t('desk.renameFolder'), icon: Rename16Regular, onClick: () => setOpenFolder({ id: g.id, rename: true }) },
    { label: t('desk.arrange'), icon: ArrowMove20Regular, onClick: startArrange },
    { separator: true, label: '' },
    { label: t('desk.ungroup'), icon: ArrowUndo16Regular, onClick: () => ungroup(g.id) },
  ];

  // A function declaration: the menus above refer to it before this line runs.
  function startArrange() {
    setMenu(null);
    setSel(new Set());
    setArranging(true);
  }
  const [mergeOn, setMergeOn] = useState<string | null>(null);
  const mergeOnRef = useRef<string | null>(null);
  mergeOnRef.current = mergeOn;
  const ghost = useRef<{ el: HTMLElement; dx: number; dy: number } | null>(null);
  const stopArrange = () => {
    setArranging(false);
    setDragKey(null);
    setLive(null);
    setMergeOn(null);
  };
  // Arrange mode: press an icon and slide it. A copy follows the finger; resting on another icon's
  // edge moves it there, on its middle (an app or a folder) puts them in a folder.
  const arrangeDown = (key: string) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    const copy = el.cloneNode(true) as HTMLElement;
    copy.classList.remove('jiggle');
    Object.assign(copy.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: '0', zIndex: '9998', pointerEvents: 'none', transform: 'scale(1.12)', opacity: '0.92', transition: 'none' });
    document.body.appendChild(copy);
    ghost.current = { el: copy, dx: e.clientX - r.left, dy: e.clientY - r.top };
    setLive(items.map((i) => i.key));
    setDragKey(key);
  };
  useEffect(() => {
    if (!dragKey) return;
    let wait: { over: string; timer: number } | null = null;
    const move = (e: PointerEvent) => {
      const g = ghost.current;
      if (g) Object.assign(g.el.style, { left: `${e.clientX - g.dx}px`, top: `${e.clientY - g.dy}px` });
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-key]') as HTMLElement | null;
      const over = el?.dataset.key;
      const canMerge = over && !dragKey.startsWith(GROUP) && byKey.has(dragKey) && (byKey.has(over) || over.startsWith(GROUP));
      if (!over || over === dragKey || (canMerge && onMiddle(el!, e.clientX, e.clientY))) {
        setMergeOn(over && over !== dragKey ? over : null);
        if (wait) clearTimeout(wait.timer);
        wait = null;
        return;
      }
      setMergeOn(null);
      if (wait?.over === over) return;
      if (wait) clearTimeout(wait.timer);
      // Move only after a short rest on the edge, so passing over icons on the way doesn't shuffle them.
      wait = {
        over,
        timer: window.setTimeout(() => {
          wait = null;
          setLive((cur) => {
            if (!cur) return cur;
            const l = cur.filter((k) => k !== dragKey);
            l.splice(l.indexOf(over), 0, dragKey);
            return l;
          });
        }, 220),
      };
    };
    const up = () => {
      if (wait) clearTimeout(wait.timer);
      ghost.current?.el.remove();
      ghost.current = null;
      const target = mergeOnRef.current;
      if (!(target && mergeRef.current(dragKey, target, liveRef.current ?? currentOrder())) && liveRef.current) setList('order', liveRef.current);
      setDragKey(null);
      setLive(null);
      setMergeOn(null);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up, { once: true });
    addEventListener('pointercancel', up, { once: true });
    return () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      removeEventListener('pointercancel', up);
    };
  }, [dragKey]);
  useEffect(() => {
    if (!arranging) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && stopArrange();
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [arranging]);
  /** In arrange mode a tile only moves: no opening, menus or native drag. */
  const arrangeProps = (key: string) =>
    arranging
      ? {
          'data-key': key,
          draggable: false,
          onPointerDown: arrangeDown(key),
          onClick: undefined,
          onDoubleClick: undefined,
          onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
          style: { touchAction: 'none' as const },
        }
      : { 'data-key': key };

  const tile = (selected: boolean, drop = false) =>
    `flex w-[92px] flex-col items-center gap-1 rounded-lg p-1.5 outline-none ${drop ? 'bg-primary/25 ring-2 ring-primary' : selected ? 'bg-primary/15 ring-1 ring-primary/40' : 'hover:bg-white/40 dark:hover:bg-white/10'}`;
  // Labels stay readable on any wallpaper: dark text on light ones, white text on photos and dark ones.
  const label = `line-clamp-2 break-words text-center text-xs leading-tight ${onDark ? 'text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.9)]' : 'text-ink [text-shadow:0_1px_2px_rgb(255_255_255/0.8)]'}`;

  // Recycle Bin: drop files on it to delete them; right-click to empty. Movable like any icon.
  const renderTrash = () => (
    <button
      key={TRASH_KEY}
      type="button"
      onDragOver={(ev) => {
        if (!carriesPaths(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        setDropOn(TRASH_KEY);
      }}
      onDragLeave={() => setDropOn(null)}
      onDrop={(ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setDropOn(null);
        const paths = dragPaths(ev);
        if (paths?.length) remove(paths);
      }}
      {...holdHandlers((x, y) => {
        setSel(new Set([TRASH_KEY]));
        setMenu({ x, y, items: trashMenu });
      })}
      onClick={() => {
        if (consumedByHold()) return;
        if (lastPointer.current === 'mouse') setSel(new Set([TRASH_KEY]));
        else openTrash();
      }}
      onDoubleClick={() => lastPointer.current === 'mouse' && openTrash()}
      onContextMenu={(ev) => {
        ev.preventDefault();
        if (lastPointer.current !== 'mouse') return;
        setSel(new Set([TRASH_KEY]));
        setMenu({ x: ev.clientX, y: ev.clientY, items: trashMenu });
      }}
      {...arrangeProps(TRASH_KEY)}
      className={`${tile(sel.has(TRASH_KEY), dropOn === TRASH_KEY)} ${arranging ? 'jiggle' : ''} ${dragKey === TRASH_KEY ? 'opacity-30' : ''} transition-transform`}
      title={tn('desk.trashItems', trashCount)}
    >
      <TrashArt full={trashCount > 0} />
      <span className={label}>{t('desk.trash')}</span>
    </button>
  );

  return (
    <>
      <div
        tabIndex={-1}
        className={`absolute start-0 top-0 grid auto-cols-[96px] grid-flow-col grid-rows-[repeat(auto-fill,108px)] content-start justify-start gap-1 overflow-x-auto overflow-y-hidden p-3 outline-none ${dropOn === DESKTOP_DIR ? 'bg-primary/5' : ''}`}
        style={{ bottom: TASKBAR_H, insetInlineEnd: endInset }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          setSel(new Set());
          if (arranging) stopArrange();
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          setSel(new Set());
          lastPos.current = { x: e.clientX, y: e.clientY };
          setMenu({ x: e.clientX, y: e.clientY, items: backgroundMenu });
        }}
        onKeyDown={onKeyDown}
        onDragOver={(e) => {
          if (!accepts(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = carriesPaths(e) ? 'move' : 'copy';
          setDropOn((d) => (d && d !== DESKTOP_DIR ? d : DESKTOP_DIR));
        }}
        onDragLeave={(e) => e.target === e.currentTarget && setDropOn(null)}
        onDrop={(e) => onDrop(e)}
      >
        {items.map((it) => {
          if (it.kind === 'trash') return renderTrash();
          if (it.kind === 'grp') {
            const { g, apps } = it;
            const open = () => setOpenFolder({ id: g.id, rename: false });
            return (
              <button
                key={it.key}
                type="button"
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(SHORTCUT_MIME, it.key);
                  ev.dataTransfer.effectAllowed = 'move';
                }}
                {...shortcutDrop(it.key)}
                {...holdHandlers((x, y) => {
                  setSel(new Set([it.key]));
                  setMenu({ x, y, items: folderMenu(g) });
                })}
                onClick={() => {
                  if (consumedByHold()) return;
                  if (lastPointer.current === 'mouse') setSel(new Set([it.key]));
                  else open();
                }}
                onDoubleClick={() => lastPointer.current === 'mouse' && open()}
                onKeyDown={(ev) => ev.key === 'Enter' && open()}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  if (lastPointer.current !== 'mouse') return;
                  setSel(new Set([it.key]));
                  setMenu({ x: ev.clientX, y: ev.clientY, items: folderMenu(g) });
                }}
                {...arrangeProps(it.key)}
                className={`${tile(sel.has(it.key), dropOn === `sc:${it.key}` || mergeOn === it.key)} ${arranging ? 'jiggle' : ''} ${dragKey === it.key ? 'opacity-30' : ''} transition-transform`}
                title={apps.map((a) => a.title).join(' · ')}
              >
                <FolderArt apps={apps} />
                <span className={label} dir="auto">
                  {g.name || t('desk.folder')}
                </span>
              </button>
            );
          }
          if (it.kind === 'sc') {
            const s = it.s;
            return (
              <button
                key={s.key}
                type="button"
                draggable
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(SHORTCUT_MIME, s.key);
                  ev.dataTransfer.effectAllowed = 'move';
                }}
                {...shortcutDrop(s.key)}
                {...holdHandlers((x, y) => {
                  setSel(new Set([s.key]));
                  setMenu({ x, y, items: shortcutMenu(s) });
                })}
                onClick={() => {
                  if (consumedByHold()) return;
                  if (lastPointer.current === 'mouse') setSel(new Set([s.key]));
                  else s.open();
                }}
                onDoubleClick={() => lastPointer.current === 'mouse' && s.open()}
                onKeyDown={(ev) => ev.key === 'Enter' && s.open()}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  if (lastPointer.current !== 'mouse') return; // touch: the long-press handler opens it
                  setSel(new Set([s.key]));
                  setMenu({ x: ev.clientX, y: ev.clientY, items: shortcutMenu(s) });
                }}
                {...arrangeProps(s.key)}
                className={`${tile(sel.has(s.key), dropOn === `sc:${s.key}` || mergeOn === s.key)} ${arranging ? 'jiggle' : ''} ${dragKey === s.key ? 'opacity-30' : ''} transition-transform`}
              >
                {s.icon}
                <span className={label} dir="auto">
                  {s.title}
                </span>
              </button>
            );
          }
          const f = it.f;
          return renaming === f.path ? (
            <RenameTile
              key={f.path}
              entry={f}
              onDone={(name) => {
                setRenaming(null);
                if (name && name !== f.name) void act(() => api('/api/fs/rename', { body: { path: f.path, name } }));
              }}
            />
          ) : (
            <button
              key={f.path}
              type="button"
              draggable
              onDragStart={(ev) => {
                const paths = sel.has(f.path) ? [...sel].filter((p) => p.includes('/')) : [f.path];
                if (!sel.has(f.path)) setSel(new Set([f.path]));
                setDragPaths(ev, paths);
              }}
              {...holdHandlers((x, y) => {
                setSel(new Set([f.path]));
                setMenu({ x, y, items: fileMenu(f) });
              })}
              onClick={(ev) => {
                if (consumedByHold()) return;
                // Touch: one tap opens (like a tablet). Mouse: click selects, double-click opens.
                if (lastPointer.current !== 'mouse') return openFile(f);
                if (ev.ctrlKey || ev.metaKey) {
                  const next = new Set(sel);
                  if (next.has(f.path)) next.delete(f.path);
                  else next.add(f.path);
                  setSel(next);
                } else setSel(new Set([f.path]));
              }}
              onDoubleClick={() => lastPointer.current === 'mouse' && openFile(f)}
              onContextMenu={(ev) => {
                ev.preventDefault();
                if (lastPointer.current !== 'mouse') return;
                if (!sel.has(f.path)) setSel(new Set([f.path]));
                setMenu({ x: ev.clientX, y: ev.clientY, items: fileMenu(f) });
              }}
              {...(f.type === 'dir'
                ? {
                    onDragOver: (ev: React.DragEvent) => {
                      if (!accepts(ev)) return;
                      ev.preventDefault();
                      ev.stopPropagation();
                      setDropOn(f.path);
                    },
                    onDragLeave: () => setDropOn(null),
                    onDrop: (ev: React.DragEvent) => onDrop(ev, f.path),
                  }
                : {})}
              {...arrangeProps(fileKey(f))}
              className={`${tile(sel.has(f.path), dropOn === f.path)} ${arranging ? 'jiggle' : ''} ${dragKey === fileKey(f) ? 'opacity-30' : ''} transition-transform`}
              title={f.name}
            >
              <FileIcon entry={f} size={52} />
              <span className={label} dir="auto">
                {f.name}
              </span>
            </button>
          );
        })}
      </div>

      {arranging && (
        <div
          style={{ bottom: TASKBAR_H + 12 }}
          className="fixed start-1/2 z-[9997] flex -translate-x-1/2 items-center gap-3 rounded-full border border-line bg-surface/95 py-1.5 ps-4 pe-1.5 text-sm text-ink shadow-[0_12px_40px_rgb(15_23_42/0.25)] backdrop-blur-xl rtl:translate-x-1/2"
        >
          {t('desk.arrangeHint')}
          <button type="button" onClick={stopArrange} className="rounded-full bg-primary px-4 py-1.5 font-medium text-white">
            {t('launcher.done')}
          </button>
        </div>
      )}

      <ShareDialog target={sharing} onClose={() => setSharing(null)} onManage={() => wm.open({ app: 'settings', title: t('share.links'), route: '/settings/shares', w: 560, h: 680, newWindow: true })} />
      <Dialog open={!!props} onClose={() => setProps(null)} title={props?.title ?? ''}>
        {props && (
          <dl className="divide-y divide-line text-sm">
            {props.rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 py-2">
                <dt className="shrink-0 text-muted">{k}</dt>
                <dd className="min-w-0 break-all text-end text-ink" dir="auto">
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Dialog>

      {(() => {
        const f = openFolder && folders.find((x) => x.g.id === openFolder.id);
        return f ? (
          <FolderPanel
            key={f.g.id}
            group={f.g}
            apps={f.apps}
            renameNow={openFolder!.rename}
            onRename={(name) => renameFolder(f.g.id, name)}
            onAppMenu={(s, x, y) =>
              setMenu({
                x,
                y,
                items: [
                  { label: t('fm.open'), icon: Open16Regular, onClick: () => (setOpenFolder(null), s.open()) },
                  ...(s.openNew ? [{ label: t('desk.newWindow'), icon: WindowNew16Regular, onClick: () => (setOpenFolder(null), s.openNew!()) }] : []),
                  { separator: true, label: '' },
                  { label: t('desk.outOfFolder'), icon: ArrowUndo16Regular, onClick: () => takeOut(f.g.id, s.key) },
                  { label: t('props.title'), icon: Info16Regular, onClick: () => setProps({ title: s.title, rows: s.props }) },
                ],
              })
            }
            onClose={() => setOpenFolder(null)}
          />
        ) : null;
      })()}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {(toast || progress !== null) && (
        <div
          className="fixed bottom-[calc(var(--tb)+12px)] end-3 z-[9996] w-72 rounded-xl border border-line bg-surface/95 p-3 text-sm text-ink shadow-[0_12px_40px_rgb(15_23_42/0.2)] backdrop-blur-xl"
          style={{ '--tb': `${TASKBAR_H}px` } as React.CSSProperties}
          role="status"
        >
          {progress !== null ? (
            <>
              <p className="mb-2">{t('desk.uploading', { pct: `${progress}%` })}</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
              </div>
            </>
          ) : (
            toast
          )}
        </div>
      )}
    </>
  );
}

function RenameTile({ entry, onDone }: { entry: Entry; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    // Select the name without the extension, like a desktop OS.
    const dot = entry.type === 'file' ? entry.name.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  return (
    <div className="flex w-[92px] flex-col items-center gap-1 rounded-lg bg-primary/15 p-1.5 ring-1 ring-primary/40">
      <FileIcon entry={entry} size={52} />
      <input
        ref={ref}
        defaultValue={entry.name}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onDone(e.currentTarget.value.trim());
          if (e.key === 'Escape') onDone(null);
        }}
        onBlur={(e) => onDone(e.currentTarget.value.trim())}
        className="w-full rounded border border-primary bg-surface px-1 text-center text-xs text-ink outline-none"
        dir="auto"
      />
    </div>
  );
}
