/** Drag & drop of server files between the desktop and Files windows (and files from the computer). */

const MIME = 'application/x-minis-paths';

export function setDragPaths(e: React.DragEvent, paths: string[]) {
  e.dataTransfer.setData(MIME, JSON.stringify(paths));
  e.dataTransfer.setData('text/plain', paths.join('\n'));
  e.dataTransfer.effectAllowed = 'move';
}

export function dragPaths(e: React.DragEvent): string[] | null {
  const raw = e.dataTransfer.getData(MIME);
  if (!raw) return null;
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) && list.every((p) => typeof p === 'string') ? list : null;
  } catch {
    return null;
  }
}

/** During dragover the data can't be read yet, only its types. */
export const carriesPaths = (e: React.DragEvent) => e.dataTransfer.types.includes(MIME);
export const carriesFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
