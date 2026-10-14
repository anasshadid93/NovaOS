import { useEffect, useState, type ComponentType } from 'react';
import { Link } from 'wouter';
import {
  ArrowDownload20Regular,
  Delete20Regular,
  Desktop20Regular,
  Document20Regular,
  FolderZip20Regular,
  Folder20Regular,
  HardDrive20Regular,
  Home20Regular,
  Image20Regular,
  MusicNote220Regular,
  Note20Regular,
  UsbStick20Regular,
  Video20Regular,
} from '@fluentui/react-icons';
import { api } from '../../lib/api';
import { useI18n, type MessageKey } from '../../i18n';

interface Volume {
  id: string;
  name: string;
  removable: boolean;
  transport: string | null;
  state: string;
  path: string | null;
}

type Place = { href: string; label: string; icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; path?: string };

const LIBRARY: { folder: string; label: MessageKey; icon: Place['icon'] }[] = [
  { folder: 'Images', label: 'places.images', icon: Image20Regular },
  { folder: 'Videos', label: 'places.videos', icon: Video20Regular },
  { folder: 'Audio', label: 'places.audio', icon: MusicNote220Regular },
  { folder: 'Documents', label: 'places.documents', icon: Document20Regular },
  { folder: 'Notes', label: 'places.notes', icon: Note20Regular },
  { folder: 'Zip', label: 'places.zip', icon: FolderZip20Regular },
  { folder: 'Other', label: 'places.other', icon: Folder20Regular },
];

const at = (p: string) => `/files?path=${encodeURIComponent(p)}`;

/** Desktop Files window: places on the side, like a desktop file manager. */
export function PlacesSidebar({ current, onDrop }: { current: string; onDrop?: (ev: React.DragEvent, dest: string) => void }) {
  const { t } = useI18n();
  const [vols, setVols] = useState<Volume[]>([]);
  useEffect(() => {
    const load = () => void api<Volume[]>('/api/storage/volumes').then(setVols).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  const quick: Place[] = [
    { href: at('files/Desktop'), label: t('places.desktop'), icon: Desktop20Regular, path: 'files/Desktop' },
    { href: at('files/Downloads'), label: t('places.downloads'), icon: ArrowDownload20Regular, path: 'files/Downloads' },
    { href: at('files'), label: t('places.library'), icon: Home20Regular, path: 'files' },
  ];
  const library: Place[] = LIBRARY.map((l) => ({ href: at(`files/${l.folder}`), label: t(l.label), icon: l.icon, path: `files/${l.folder}` }));
  const drives: Place[] = [
    { href: at(''), label: t('vol.internal'), icon: HardDrive20Regular, path: '' },
    ...vols
      .filter((v) => v.id !== 'internal' && v.state === 'mounted' && v.path)
      .map((v) => ({ href: at(v.path!), label: v.name, icon: v.removable || v.transport === 'usb' ? UsbStick20Regular : HardDrive20Regular, path: v.path! })),
  ];

  const row = (p: Place) => {
    const active = p.path !== undefined && p.path === current;
    return (
      <li key={p.href}>
        <Link
          href={p.href}
          onDragOver={(ev: React.DragEvent) => p.path !== undefined && onDrop && ev.preventDefault()}
          onDrop={(ev: React.DragEvent) => p.path !== undefined && onDrop?.(ev, p.path)}
          className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm ${active ? 'bg-primary-soft font-medium text-primary-ink' : 'text-ink hover:bg-black/5 dark:hover:bg-white/10'}`}
        >
          <p.icon className="size-5 shrink-0 opacity-80" aria-hidden />
          <span className="truncate" dir="auto">
            {p.label}
          </span>
        </Link>
      </li>
    );
  };
  const group = (title: string, items: Place[]) => (
    <div>
      <p className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      <ul className="space-y-0.5">{items.map(row)}</ul>
    </div>
  );

  return (
    <nav aria-label={t('places.title')} className="space-y-4 p-2">
      {group(t('places.quick'), quick)}
      {group(t('places.libraryTitle'), library)}
      {group(t('places.drives'), drives)}
      <ul>{row({ href: '/files/bin', label: t('desk.trash'), icon: Delete20Regular })}</ul>
    </nav>
  );
}
