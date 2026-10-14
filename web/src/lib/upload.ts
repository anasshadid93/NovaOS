/** Multipart upload with progress (fetch has no upload progress, so XHR). */
export function uploadFiles(kind: 'file' | 'photo' | 'video', files: FileList | File[], onProgress: (pct: number) => void): Promise<{ saved: string[] }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of Array.from(files)) form.append('file', f, f.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?kind=${kind}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(String(xhr.status))));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(form);
  });
}
