import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearch } from 'wouter';
import { Save20Regular } from '@fluentui/react-icons';
import { ApiError, api } from '../lib/api';
import { baseName } from '../lib/fm';
import { useI18n } from '../i18n';
import { useWindowCtx } from '../desktop/context';
import { wm } from '../desktop/wm';

/** Desktop: a plain text editor window (Ctrl+S saves). */
export function Editor() {
  const { t } = useI18n();
  const path = new URLSearchParams(useSearch()).get('path') ?? '';
  const win = useWindowCtx();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [status, setStatus] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== null && text !== saved;

  useEffect(() => {
    api<{ text: string; truncated: boolean }>(`/api/fs/text?path=${encodeURIComponent(path)}`)
      .then((r) => {
        setText(r.text);
        setSaved(r.text);
        setReadOnly(r.truncated);
        if (r.truncated) setStatus(t('editor.tooBig'));
        requestAnimationFrame(() => area.current?.focus());
      })
      .catch((e) => {
        setText('');
        setReadOnly(true);
        setStatus(e instanceof ApiError && e.code === 'binary' ? t('editor.binary') : t('fm.err.generic'));
      });
  }, [path, t]);

  useEffect(() => {
    if (win) wm.setTitle(win.id, `${dirty ? '● ' : ''}${baseName(path)}`);
  }, [dirty, path, win]);

  const save = useCallback(async () => {
    if (text === null || readOnly || !dirty) return;
    try {
      await api('/api/fs/write', { body: { path, text } });
      setSaved(text);
      setStatus(t('editor.saved'));
    } catch {
      setStatus(t('fm.err.generic'));
    }
  }, [dirty, path, readOnly, t, text]);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || readOnly}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm text-ink hover:bg-primary-soft disabled:opacity-40"
          title="Ctrl+S"
        >
          <Save20Regular aria-hidden />
          {t('editor.save')}
        </button>
        <span className="flex-1 truncate text-xs text-muted" role="status">
          {status}
        </span>
        <span className="text-xs tabular-nums text-muted" dir="ltr">
          {text?.split('\n').length ?? 0} {t('editor.lines')}
        </span>
      </div>
      <textarea
        ref={area}
        value={text ?? ''}
        readOnly={readOnly || text === null}
        onChange={(e) => {
          setText(e.target.value);
          setStatus('');
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void save();
          }
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart: a, selectionEnd: b } = el;
            const v = el.value.slice(0, a) + '  ' + el.value.slice(b);
            setText(v);
            requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
          }
        }}
        spellCheck={false}
        dir="auto"
        className="min-h-0 flex-1 resize-none bg-surface p-3 font-mono text-[13px] leading-relaxed text-ink outline-none"
        aria-label={baseName(path)}
      />
    </div>
  );
}
