import {
  ArrowMaximize16Regular,
  ArrowMinimize16Regular,
  DesktopArrowRight16Regular,
  Dismiss16Regular,
  PanelLeft16Regular,
  PanelRight16Regular,
  SquareMultiple16Regular,
  Subtract16Regular,
} from '@fluentui/react-icons';
import type { useI18n } from '../i18n';
import type { MenuItem } from './ContextMenu';
import { wm, type Win } from './wm';
import { desks } from './desks';

type T = ReturnType<typeof useI18n>['t'];

/** Right-click on a window's title bar or its taskbar button. */
export function winMenu(w: Win, t: T): MenuItem[] {
  const placed = w.maximized || !!w.snap;
  return [
    ...(w.minimized ? [{ label: t('desk.restore'), icon: SquareMultiple16Regular, onClick: () => wm.focus(w.id) }] : [{ label: t('desk.minimize'), icon: Subtract16Regular, onClick: () => wm.minimize(w.id) }]),
    placed
      ? { label: t('desk.restore'), icon: ArrowMinimize16Regular, onClick: () => (w.maximized ? wm.toggleMax(w.id) : wm.setSnap(w.id, null)) }
      : { label: t('desk.maximize'), icon: ArrowMaximize16Regular, onClick: () => wm.toggleMax(w.id) },
    { label: t('desk.snapLeft'), icon: PanelLeft16Regular, onClick: () => wm.setSnap(w.id, 'left') },
    { label: t('desk.snapRight'), icon: PanelRight16Regular, onClick: () => wm.setSnap(w.id, 'right') },
    // Move to another virtual desktop (and go there).
    ...desks
      .get()
      .names.map((n, i) => ({ n, i }))
      .filter(({ i }) => i !== (w.desk ?? 0))
      .map(({ n, i }) => ({ label: t('vdesk.moveTo', { name: n || t('vdesk.name', { n: i + 1 }) }), icon: DesktopArrowRight16Regular, onClick: () => (wm.moveToDesk(w.id, i), desks.switchTo(i)) })),
    { separator: true, label: '' },
    { label: t('common.close'), icon: Dismiss16Regular, danger: true, onClick: () => wm.close(w.id) },
  ];
}
