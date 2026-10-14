/**
 * Telegram formatting for the n8n assistant, done here instead of in n8n Code nodes: n8n's
 * JS task runner can hang (a 300 s timeout lost a reply on 2026-10-11), while an HTTP call to
 * this server cannot. Telegram rejects unbalanced Markdown, so model Markdown becomes HTML we
 * escape ourselves; a plain fallback rides along in case Telegram still refuses it.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const LIMIT = 4000;

/** Small models sometimes append a Latin transliteration "(Ahlan!...)" to Arabic lines: drop it. */
export function stripTransliteration(t: string): string {
  return /[؀-ۿ]/.test(t) ? t.replace(/[ \t]*\((?=[^()\n]*[A-Za-z]{3})[^()؀-ۿ\n]{6,}\)[ \t]*$/gm, '').trim() : t;
}

export function markdownToTelegramHtml(md: string): string {
  const code: string[] = [];
  let t = md.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, c: string) => {
    code.push(c);
    return `\u0000${code.length - 1}\u0000`;
  });
  t = esc(t)
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^(\s*)[*-]\s+/gm, '$1• ')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+?)__/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?:;،؟]|$)/gm, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, a: string, u: string) => `<a href="${u.replace(/"/g, '&quot;')}">${a}</a>`)
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<pre>${esc(code[Number(i)] ?? '')}</pre>`);
  return t;
}

/** Cut to Telegram's limit and close any tag left open, so the cut message is still valid HTML. */
export function clampHtml(html: string, limit = LIMIT): string {
  if (html.length <= limit) return html;
  let h = html.slice(0, limit - 20).replace(/<[^>]*$/, '').replace(/&[#\w]*$/, '');
  const open: string[] = [];
  for (const m of h.matchAll(/<(\/?)(b|i|code|pre|a)\b[^>]*>/g)) {
    if (m[1]) open.pop();
    else open.push(m[2]);
  }
  h += '…' + open.reverse().map((tag) => `</${tag}>`).join('');
  return h;
}

/** The assistant's reply → { html, fallback }. `heard` = transcript of a voice message, shown first. */
export function formatReply(output: string, heard = ''): { html: string; fallback: string } {
  const plain = stripTransliteration(String(output ?? ''));
  const head = heard ? `🎤 «${esc(heard)}»\n\n` : '';
  return {
    html: clampHtml(head + markdownToTelegramHtml(plain)),
    fallback: esc((heard ? `🎤 «${heard}»\n\n` : '') + plain).slice(0, LIMIT),
  };
}

/** Messages NovaOS posts to the assistant's inbox (downloads, alerts, reminders) → Telegram HTML. */
export function formatEvent(d: Record<string, unknown>): { text: string } {
  const s = (v: unknown) => esc(String(v ?? ''));
  if (d.type === 'alert' || d.type === 'notice') return { text: String(d.text ?? '').slice(0, LIMIT) };
  if (d.status === 'done') {
    let text = `${d.audio ? '🎵' : '🎬'} <b>خلص التنزيل</b>\n${s(d.title || d.file)}${d.sizeMB ? `\n${d.sizeMB} MB` : ''}`;
    // The direct file link first: some in-app browsers (Telegram's) show the share page blank,
    // while the direct download always works. The page stays as the second option.
    if (d.shareUrl) text += `\n\n⬇️ <a href="${s(d.shareUrl)}/f?dl=1">تنزيل مباشر</a> (من أي مكان، 7 أيام)\n👁 <a href="${s(d.shareUrl)}">صفحة العرض</a>`;
    if (d.filesUrl) text += `\n📁 <a href="${s(d.filesUrl)}">بالملفات على the server</a>`;
    return { text };
  }
  return { text: `⚠️ <b>ما زبط التنزيل</b>\n${s(d.url)}\n<code>${s(String(d.error ?? '').slice(0, 300))}</code>` };
}
