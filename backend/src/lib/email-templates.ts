// E-mail bodies (spec §7.2 template rules): multipart plain text + HTML, UTF-8,
// English and Arabic, no external images or scripts, one link back to the app.
// Everything interpolated into HTML is escaped.

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface BilingualMessage {
  title: string;
  message: string;
  titleAr?: string | null;
  messageAr?: string | null;
  /** Absolute URL the reader can open; omitted for people without an account. */
  link?: string;
}

export function renderEmail(m: BilingualMessage): { subject: string; text: string; html: string } {
  const hasAr = Boolean(m.titleAr || m.messageAr);
  const subject = `AIGH Workforce: ${m.title}`.replace(/[\r\n]+/g, ' ').slice(0, 200);
  const text = [
    m.title, '', m.message,
    ...(hasAr ? ['', '—', '', m.titleAr ?? '', '', m.messageAr ?? ''] : []),
    ...(m.link ? ['', `Open: ${m.link}`] : []),
    '', 'This message was sent automatically by the AIGH Nursing Workforce system. Do not reply with personal data.',
  ].join('\n');
  const section = (title: string, body: string, rtl: boolean) =>
    `<div dir="${rtl ? 'rtl' : 'ltr'}" lang="${rtl ? 'ar' : 'en'}" style="margin:0 0 20px;text-align:${rtl ? 'right' : 'left'}">`
    + `<h2 style="font-size:17px;margin:0 0 8px">${escapeHtml(title)}</h2>`
    + `<p style="margin:0;white-space:pre-line">${escapeHtml(body)}</p></div>`;
  const html = '<!doctype html><html><head><meta charset="utf-8"></head>'
    + '<body style="font-family:Arial,Tahoma,sans-serif;font-size:14px;color:#1f2933;line-height:1.5">'
    + section(m.title, m.message, false)
    + (hasAr ? section(m.titleAr ?? '', m.messageAr ?? '', true) : '')
    + (m.link ? `<p><a href="${escapeHtml(m.link)}">${escapeHtml(m.link)}</a></p>` : '')
    + '<p style="color:#6b7280;font-size:12px">This message was sent automatically by the AIGH Nursing Workforce system.</p>'
    + '</body></html>';
  return { subject, text, html };
}
