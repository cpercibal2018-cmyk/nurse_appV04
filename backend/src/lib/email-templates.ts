// E-mail bodies (spec §7.2 template rules): multipart plain text + HTML, UTF-8,
// English and Arabic, no external images or scripts, one link back to the app.
// Everything interpolated into HTML is escaped. A link goes in `link`, never inside
// `message`: only `link` is turned into a clickable anchor.

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
    ...(m.link ? ['', `Open: ${m.link}`] : []),
    ...(hasAr ? ['', '—', '', m.titleAr ?? '', '', m.messageAr ?? ''] : []),
    '', 'This message was sent automatically by the AIGH Nursing Workforce system. Do not reply with personal data.',
  ].join('\n');
  const section = (title: string, body: string, rtl: boolean) =>
    `<div dir="${rtl ? 'rtl' : 'ltr'}" lang="${rtl ? 'ar' : 'en'}" style="margin:0 0 20px;text-align:${rtl ? 'right' : 'left'}">`
    + `<h2 style="font-size:17px;margin:0 0 8px">${escapeHtml(title)}</h2>`
    + `<p style="margin:0;white-space:pre-line">${escapeHtml(body)}</p></div>`;
  // The link is a real anchor, once, right after the English text: a button (a table cell, because
  // Outlook for Windows ignores padding on <a>) and the address itself on its own left-to-right line,
  // so it stays whole beside Arabic text and can be copied if the button is blocked.
  const linkBlock = (url: string) => {
    const href = escapeHtml(url);
    return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 12px"><tr>'
      + `<td bgcolor="#1f6b4f" style="background:#1f6b4f;border-radius:6px;padding:10px 20px"><a href="${href}" style="color:#ffffff;font-weight:bold;text-decoration:none;display:inline-block">`
      + `Open the link${hasAr ? ' · افتح الرابط' : ''}</a></td></tr></table>`
      + '<p dir="ltr" style="margin:0 0 20px;font-size:12px;color:#6b7280;text-align:left;word-break:break-all">'
      + `If the button does not work, copy this address into your browser:<br><a href="${href}" style="color:#1f6b4f">${href}</a></p>`;
  };
  const html = '<!doctype html><html><head><meta charset="utf-8"></head>'
    + '<body style="font-family:Arial,Tahoma,sans-serif;font-size:14px;color:#1f2933;line-height:1.5">'
    + section(m.title, m.message, false)
    + (m.link ? linkBlock(m.link) : '')
    + (hasAr ? section(m.titleAr ?? '', m.messageAr ?? '', true) : '')
    + '<p style="color:#6b7280;font-size:12px">This message was sent automatically by the AIGH Nursing Workforce system.</p>'
    + '</body></html>';
  return { subject, text, html };
}
