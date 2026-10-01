// Builds the user manual from the Guidelines content (the same source as the
// in-app Guidelines page):
//   docs/USER_MANUAL.md                                         Markdown edition
//   docs/generated/flows/<id>.svg                               every workflow as an image
//   docs/generated/AIGH_Nursing_Workforce_User_Manual_V04.pdf   the printable manual
//
//   npm run docs:manual
//
// English edition. The built-in PDF fonts cannot shape Arabic, so characters
// outside them are spelled out (→ becomes ->); the in-app Guidelines switch the
// interface to Arabic.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { FLOWS, flowById, sectionById, sectionNumber, SECTIONS } from '../../frontend/src/modules/guidelines/content/index';
import { FLOW_FONT, flowToSvg, layoutFlow, LIGHT, type FlowLayout } from '../../frontend/src/modules/guidelines/content/flowLayout';
import { renderManualMarkdown } from '../../frontend/src/modules/guidelines/content/markdown';
import { ROLE_LABEL, STATUS_LABEL, type Callout, type GuideRole, type GuideSection, type GuideTable, type GuideTask, type ImplementationStatus } from '../../frontend/src/modules/guidelines/content/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = join(ROOT, 'docs');
const OUT = join(DOCS, 'generated');
const PDF_NAME = 'AIGH_Nursing_Workforce_User_Manual_V04.pdf';
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'backend', 'package.json'), 'utf8')) as { version: string }).version;

// ---------------------------------------------------------------- Markdown and images
mkdirSync(join(OUT, 'flows'), { recursive: true });
writeFileSync(join(DOCS, 'USER_MANUAL.md'), renderManualMarkdown(VERSION) + '\n');
for (const f of FLOWS) writeFileSync(join(OUT, 'flows', `${f.id}.svg`), flowToSvg(layoutFlow(f), LIGHT) + '\n');

// ---------------------------------------------------------------- PDF
const C = {
  green: '#0f3024', green2: '#1f6b4f', tint: '#eaf3ee', grey: '#5b6660', line: '#c9d3cd', zebra: '#f5f8f6',
  amber: '#fff4dc', amberLine: '#d99a1e', red: '#b3261e', redTint: '#fdecec', text: '#1f2933',
};
const ROLE_COLOR: Record<GuideRole, string> = { EMPLOYEE: '#4b6b8a', SUPERVISOR: '#7a5c1f', HR_ADMIN: '#1f6b4f', SYSTEM_ADMIN: '#8a2f2a' };
const STATUS_COLOR: Record<ImplementationStatus, string> = { IMPLEMENTED: '#1f6b4f', PARTIAL: '#b7791f', PLANNED: '#8a2f2a' };

/** The standard PDF fonts are Windows-1252: spell out what they cannot draw. */
const pdfText = (s: string) => s
  .replace(/→/g, '->').replace(/←/g, '<-').replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/−/g, '-')
  .replace(/☰/g, 'Menu button').replace(/↑/g, 'up').replace(/↓/g, 'down')
  .replace(/[؀-ۿ]+/g, '(Arabic)');

const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 64, left: 50, right: 50 }, bufferPages: true, autoFirstPage: false,
  info: { Title: 'AIGH Nursing Workforce — User Manual V04', Author: 'AIGH Nursing Administration', Subject: `User manual, v${VERSION}`, Keywords: 'nursing workforce, user manual, guidelines' } });
const chunks: Buffer[] = [];
doc.on('data', (c: Buffer) => chunks.push(c));

const W = 595.28 - 100; // usable width
const LEFT = 50;
const BOTTOM = 841.89 - 64;
const tocEntries: Array<{ title: string; page: number; level: 0 | 1 }> = [];

const space = (h: number) => { if (doc.y + h > BOTTOM) doc.addPage(); };
const para = (text: string, opts: { size?: number; color?: string; bold?: boolean; indent?: number; gap?: number } = {}) => {
  doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 10).fillColor(opts.color ?? C.text);
  const t = pdfText(text);
  space(doc.heightOfString(t, { width: W - (opts.indent ?? 0) }) + 2);
  doc.text(t, LEFT + (opts.indent ?? 0), doc.y, { width: W - (opts.indent ?? 0), lineGap: 1.5 });
  doc.moveDown(opts.gap ?? 0.35);
};

function pill(text: string, color: string, x: number, y: number): number {
  doc.font('Helvetica-Bold').fontSize(7.5);
  const w = doc.widthOfString(text) + 10;
  doc.roundedRect(x, y, w, 12, 6).fill(color);
  doc.fillColor('#ffffff').text(text, x + 5, y + 2.6, { lineBreak: false });
  return x + w + 4;
}

function roles(list: GuideRole[], y: number) {
  let x = LEFT;
  for (const r of list) x = pill(ROLE_LABEL[r].toUpperCase(), ROLE_COLOR[r], x, y);
}

function callout(c: Callout) {
  const t = pdfText(`${c.kind === 'warning' ? 'Important: ' : 'Note: '}${c.text}`);
  doc.font('Helvetica').fontSize(9.5);
  const h = doc.heightOfString(t, { width: W - 22 }) + 14;
  space(h + 6);
  const y = doc.y;
  doc.rect(LEFT, y, W, h).fill(c.kind === 'warning' ? C.amber : C.tint);
  doc.rect(LEFT, y, 3, h).fill(c.kind === 'warning' ? C.amberLine : C.green2);
  doc.fillColor(C.text).font('Helvetica').fontSize(9.5).text(t, LEFT + 12, y + 7, { width: W - 22, lineGap: 1.2 });
  doc.y = y + h + 8;
}

function table(t: GuideTable) {
  const size = 8.5;
  const cols = t.columns.length;
  // Column widths from content length, within sensible bounds.
  const pad = 4;
  const len = t.columns.map((c, i) => Math.max(c.length, ...t.rows.map((r) => Math.min((r[i] ?? '').length, 90))));
  const sum = len.reduce((a, b) => a + b, 0);
  // Never narrower than the column's longest single word (codes like POSITION_NOT_SCHEDULABLE must not break).
  doc.font('Helvetica-Bold').fontSize(size);
  const minW = t.columns.map((c, i) => Math.min(W * 0.45, pad * 2 + 2 + Math.max(...[c, ...t.rows.map((r) => r[i] ?? '')].flatMap((s) => pdfText(s).split(/\s+/)).map((w) => doc.widthOfString(w)))));
  const cw = len.map((l, i) => Math.max(minW[i], (l / sum) * W));
  for (let guard = 0; guard < 10; guard++) {
    const over = cw.reduce((a, b) => a + b, 0) - W;
    if (over <= 0.5) break;
    const flexible = cw.map((w, i) => w - minW[i]);
    const room = flexible.reduce((a, b) => a + b, 0);
    if (room <= 0) { const k = W / cw.reduce((a, b) => a + b, 0); cw.forEach((w, i) => (cw[i] = w * k)); break; }
    cw.forEach((w, i) => (cw[i] = w - over * (flexible[i] / room)));
  }
  const rowH = (cells: string[], bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
    return Math.max(...cells.map((c, i) => doc.heightOfString(pdfText(c), { width: cw[i] - pad * 2 }))) + pad * 2;
  };
  const drawRow = (cells: string[], header: boolean, zebra: boolean) => {
    const h = rowH(cells, header);
    if (doc.y + h > BOTTOM) { doc.addPage(); if (!header) drawRow(t.columns, true, false); }
    const y = doc.y;
    let x = LEFT;
    cells.forEach((c, i) => {
      if (header) doc.rect(x, y, cw[i], h).fill(C.green);
      else if (zebra) doc.rect(x, y, cw[i], h).fill(C.zebra);
      doc.rect(x, y, cw[i], h).lineWidth(0.4).stroke(C.line);
      doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(header ? '#ffffff' : C.text)
        .text(pdfText(c), x + pad, y + pad, { width: cw[i] - pad * 2, lineGap: 0.8 });
      x += cw[i];
    });
    doc.y = y + h;
  };
  space(40);
  para(t.title, { bold: true, size: 9.5, color: C.green2, gap: 0.2 });
  drawRow(t.columns, true, false);
  t.rows.forEach((r, i) => drawRow(Array.from({ length: cols }, (_, j) => r[j] ?? ''), false, i % 2 === 1));
  doc.moveDown(0.8);
}

/** Draws a laid-out flow, scaled to the page width (and height), centred. */
function drawFlow(layout: FlowLayout, caption?: string) {
  const s = Math.min(1, (W) / (layout.width * 0.75), (BOTTOM - 64 - 30) / (layout.height * 0.75)) * 0.75; // px → pt, fit
  const w = layout.width * s;
  const h = layout.height * s;
  if (doc.y + h + 30 > BOTTOM) doc.addPage();
  pageOfLastFlow = currentPage();
  const ox = LEFT + (W - w) / 2;
  const oy = doc.y;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy + y * s;
  doc.roundedRect(ox, oy, w, h, 8).lineWidth(0.6).stroke(C.line);
  doc.font('Helvetica-Bold').fontSize(15 * s).fillColor(LIGHT.title).text(pdfText(layout.title), ox, Y(18), { width: w, align: 'center', lineBreak: false });
  for (const sh of layout.shapes) {
    if (sh.type === 'arrow') {
      const pts = sh.points;
      doc.lineWidth(1.4 * s).strokeColor(LIGHT.line).moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (const [x, y] of pts.slice(1)) doc.lineTo(X(x), Y(y));
      doc.stroke();
      if (sh.head) {
        const [x2, y2] = pts[pts.length - 1];
        const [x1, y1] = pts[pts.length - 2];
        const a = Math.atan2(Y(y2) - Y(y1), X(x2) - X(x1));
        const L = 7 * s;
        doc.polygon([X(x2), Y(y2)], [X(x2) - L * Math.cos(a - 0.45), Y(y2) - L * Math.sin(a - 0.45)], [X(x2) - L * Math.cos(a + 0.45), Y(y2) - L * Math.sin(a + 0.45)]).fill(LIGHT.line);
      }
    } else if (sh.type === 'label') {
      doc.font('Helvetica-Bold').fontSize(FLOW_FONT.labelSize * s);
      const t = pdfText(sh.text);
      const tw = doc.widthOfString(t);
      const lh = FLOW_FONT.labelSize * s;
      doc.rect(X(sh.x) - tw / 2 - 3 * s, Y(sh.y) - lh * 1.05, tw + 6 * s, lh * 1.45).fill(LIGHT.background); // the arrow passes behind the label
      doc.fillColor(LIGHT.muted).text(t, X(sh.x) - tw / 2, Y(sh.y) - lh * 0.8, { lineBreak: false });
    } else if (sh.type === 'band') {
      doc.lineWidth(0.8 * s).strokeColor(LIGHT.band).moveTo(X(sh.x), Y(sh.y + sh.h - 4)).lineTo(X(sh.x + sh.w), Y(sh.y + sh.h - 4)).stroke();
      doc.font('Helvetica-Bold').fontSize(11 * s).fillColor(LIGHT.band).text(pdfText(sh.text), X(sh.x), Y(sh.y + 4), { width: sh.w * s, align: 'center', lineBreak: false });
    } else {
      const r = (sh.kind === 'decision' ? 4 : sh.kind === 'start' || sh.kind === 'end' || sh.kind === 'stop' ? 16 : 8) * s;
      doc.roundedRect(X(sh.x), Y(sh.y), sh.w * s, sh.h * s, r).lineWidth((sh.kind === 'decision' ? 1.8 : 1.2) * s);
      if (sh.kind === 'decision') doc.dash(4 * s, { space: 2.5 * s });
      doc.fillAndStroke(LIGHT.fill[sh.kind], LIGHT.stroke[sh.kind]);
      doc.undash();
      let y = sh.y + 14;
      if (sh.role) {
        doc.font('Helvetica-Bold').fontSize(FLOW_FONT.roleSize * s).fillColor(sh.kind === 'end' ? LIGHT.ink.end : LIGHT.muted)
          .text(pdfText(sh.role.toUpperCase()), X(sh.x), Y(y - 2), { width: sh.w * s, align: 'center', lineBreak: false });
        y += 14;
      }
      sh.lines.forEach((line, i) => {
        doc.font(sh.kind === 'end' || sh.kind === 'decision' ? 'Helvetica-Bold' : 'Helvetica').fontSize(FLOW_FONT.size * s).fillColor(LIGHT.ink[sh.kind])
          .text(pdfText(line), X(sh.x), Y(y - 1 + i * FLOW_FONT.line), { width: sh.w * s, align: 'center', lineBreak: false });
      });
    }
  }
  doc.x = LEFT;
  doc.y = oy + h + 6;
  if (caption) para(caption, { size: 8.5, color: C.grey, gap: 0.6 });
  else doc.moveDown(0.6);
}

/** Each diagram is drawn once; later mentions point back to it. */
const drawnOn = new Map<string, number>();
const flow = (id: string) => {
  const f = flowById(id)!;
  const page = drawnOn.get(id);
  if (page !== undefined) { para(`Diagram: "${f.title}" — page ${page}.`, { size: 9, color: C.grey, gap: 0.5 }); return; }
  space(80);
  drawFlow(layoutFlow(f), f.caption);
  drawnOn.set(id, pageOfLastFlow);
};
let pageOfLastFlow = 0;

function labelled(label: string, text: string) {
  if (!text) { para(label, { bold: true, size: 9.5, color: C.green2, gap: 0.15 }); return; } // a heading for the list below it
  doc.font('Helvetica-Bold').fontSize(9.5);
  const t = pdfText(text);
  space(doc.heightOfString(`${label} ${t}`, { width: W }) + 4);
  doc.fillColor(C.green2).text(`${label} `, LEFT, doc.y, { continued: true }).font('Helvetica').fillColor(C.text).text(t, { width: W, lineGap: 1.2 });
  doc.moveDown(0.3);
}

function task(t: GuideTask, n: string) {
  space(70);
  doc.moveDown(0.3);
  const y0 = doc.y;
  doc.font('Helvetica-Bold').fontSize(12).fillColor(C.green).text(pdfText(`${n}  ${t.title}`), LEFT, y0, { width: W });
  tocEntries.push({ title: `${n}  ${t.title}`, page: currentPage(), level: 1 });
  const y = doc.y + 3;
  let x = pill(STATUS_LABEL[t.status].toUpperCase(), STATUS_COLOR[t.status], LEFT, y);
  for (const r of t.roles) x = pill(ROLE_LABEL[r].toUpperCase(), ROLE_COLOR[r], x, y);
  doc.x = LEFT;
  doc.y = y + 18;
  if (t.statusNote) para(t.statusNote, { size: 9, color: STATUS_COLOR[t.status] });
  labelled('Purpose.', t.purpose);
  labelled('Who can perform it.', t.who);
  if (t.before?.length) {
    labelled('Before you start.', '');
    t.before.forEach((b) => para(`•  ${b}`, { size: 9.5, indent: 12, gap: 0.15 }));
    doc.moveDown(0.2);
  }
  labelled('Steps.', '');
  t.steps.forEach((s, i) => para(`${i + 1}.  ${s}`, { size: 9.5, indent: 12, gap: 0.15 }));
  doc.moveDown(0.25);
  labelled('System result.', t.result);
  labelled('Approval.', t.approval);
  labelled('Next step.', t.next);
  if (t.problems?.length) {
    labelled('Common problems.', '');
    t.problems.forEach((p) => para(`•  ${p.problem} — ${p.fix}`, { size: 9.5, indent: 12, gap: 0.15 }));
    doc.moveDown(0.2);
  }
  if (t.related?.length) labelled('Related.', t.related.map((id) => `${sectionNumber(id)}. ${sectionById(id)!.title}`).join('  ·  '));
  if (t.flow) flow(t.flow);
  doc.moveTo(LEFT, doc.y + 2).lineTo(LEFT + W, doc.y + 2).lineWidth(0.4).stroke(C.line);
  doc.moveDown(0.6);
}

const currentPage = () => doc.bufferedPageRange().start + doc.bufferedPageRange().count;

function section(s: GuideSection) {
  doc.addPage();
  const n = sectionNumber(s.id);
  tocEntries.push({ title: `${n}. ${s.title}`, page: currentPage(), level: 0 });
  doc.outline.addItem(pdfText(`${n}. ${s.title}`));
  doc.rect(LEFT, doc.y, W, 34).fill(C.tint);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(C.green).text(pdfText(`${n}. ${s.title}`), LEFT + 10, doc.y + 8, { width: W - 20 });
  doc.y += 12;
  roles(s.roles, doc.y);
  doc.x = LEFT;
  doc.y += 20;
  para(s.summary, { size: 10.5 });
  labelled('Who:', s.audience);
  if (s.route) labelled('Screen:', `${s.route}  (side menu)`);
  if (s.where) labelled('Where:', s.where);
  doc.moveDown(0.3);
  (s.callouts ?? []).forEach(callout);
  (s.flows ?? []).forEach(flow);
  (s.tables ?? []).forEach(table);
  s.tasks.forEach((t, i) => task(t, `${n}.${i + 1}`));
}

// Cover
doc.addPage();
doc.rect(0, 0, 595.28, 300).fill(C.green);
doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('AIGH  -  NURSING ADMINISTRATION', 0, 110, { width: 595.28, align: 'center' });
doc.font('Helvetica').fontSize(11).fillColor('#cfe8dc').text('Nursing Workforce Management System', 0, 134, { width: 595.28, align: 'center' });
doc.font('Helvetica-Bold').fontSize(30).fillColor(C.green).text('User Manual', 0, 360, { width: 595.28, align: 'center' });
doc.font('Helvetica').fontSize(14).fillColor(C.grey).text(`Version V04  ·  application v${VERSION}`, 0, 404, { width: 595.28, align: 'center' });
doc.font('Helvetica').fontSize(10.5).fillColor(C.text).text(pdfText(
  'How every screen works, who can do each task, what happens after you submit it, and where to go next. ' +
  'The same guide is in the application: side menu -> Guidelines (with search).'), 90, 460, { width: 415, align: 'center' });
doc.font('Helvetica').fontSize(9).fillColor(C.grey).text(pdfText(
  'Every task is labelled Implemented, Partially implemented or Planned, and is checked against the application code (docs/GUIDELINES_COVERAGE.md). ' +
  'Screenshots are deliberately not included: the screens are described by their labels.'), 90, 700, { width: 415, align: 'center' });

// Contents (filled in after the rest is laid out). Its length is known now: one
// line per section and per task, so exactly the pages it needs are reserved.
const TOC_LINE = { 0: 17, 1: 12.5 } as const;
const tocHeight = TOC_LINE[0] * (SECTIONS.length + 1) + TOC_LINE[1] * SECTIONS.reduce((n, s) => n + s.tasks.length, 0);
const tocPages = Math.ceil((tocHeight + 40) / (BOTTOM - 64));
doc.addPage();
const tocStart = currentPage();
for (let i = 1; i < tocPages; i++) doc.addPage();

// System overview
doc.addPage();
tocEntries.push({ title: 'System overview', page: currentPage(), level: 0 });
doc.outline.addItem('System overview');
doc.font('Helvetica-Bold').fontSize(18).fillColor(C.green).text('System overview', LEFT, doc.y);
doc.moveDown(0.5);
para(SECTIONS[0].summary, { size: 10.5 });
para('Labels used in this manual:', { bold: true, size: 9.5, color: C.green2 });
let lx = LEFT;
for (const st of ['IMPLEMENTED', 'PARTIAL', 'PLANNED'] as const) lx = pill(STATUS_LABEL[st].toUpperCase(), STATUS_COLOR[st], lx, doc.y);
doc.x = LEFT; doc.y += 18;
lx = LEFT;
for (const r of Object.keys(ROLE_COLOR) as GuideRole[]) lx = pill(ROLE_LABEL[r].toUpperCase(), ROLE_COLOR[r], lx, doc.y);
doc.x = LEFT; doc.y += 22;
flow('hospital-workflow');

for (const s of SECTIONS) section(s);

// Table of contents
const toc = tocEntries;
let page = tocStart - 1;
doc.switchToPage(page);
doc.font('Helvetica-Bold').fontSize(18).fillColor(C.green).text('Contents', LEFT, 64);
let ty = doc.y + 8;
for (const e of toc) {
  const size = e.level === 0 ? 10.5 : 8.5;
  const lh = TOC_LINE[e.level];
  if (ty + lh > BOTTOM) {
    page += 1;
    if (page >= tocStart - 1 + tocPages) throw new Error('Contents need more pages: raise tocPages');
    doc.switchToPage(page);
    ty = 64;
  }
  const indent = e.level === 0 ? 0 : 16;
  doc.font(e.level === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(e.level === 0 ? C.green : C.text);
  const title = pdfText(e.title);
  doc.text(title, LEFT + indent, ty, { width: W - indent - 40, lineBreak: false, ellipsis: true });
  doc.text(String(e.page), LEFT + W - 36, ty, { width: 36, align: 'right', lineBreak: false });
  ty += lh;
}

// Header and footer on every page but the cover
const range = doc.bufferedPageRange();
for (let i = 1; i < range.count; i++) {
  doc.switchToPage(i);
  doc.page.margins.bottom = 0; // the footer sits below the text area; without this pdfkit would start a new page
  doc.rect(0, 0, 595.28, 30).fill(C.green);
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text('AIGH Nursing Workforce  |  User Manual V04', LEFT, 11, { lineBreak: false });
  doc.text(`v${VERSION}`, LEFT, 11, { width: W, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(C.grey).text('nurse.aighnursing.net  ·  Guidelines in the application: side menu -> Guidelines', LEFT, 841.89 - 40, { lineBreak: false });
  doc.text(`Page ${i + 1} of ${range.count}`, LEFT, 841.89 - 40, { width: W, align: 'right', lineBreak: false });
}

doc.end();
doc.on('end', () => {
  const pdf = Buffer.concat(chunks);
  writeFileSync(join(OUT, PDF_NAME), pdf);
  // The Guidelines page offers the same file for download (frontend/public is served as-is).
  const pub = join(ROOT, 'frontend', 'public', 'guidelines');
  mkdirSync(pub, { recursive: true });
  writeFileSync(join(pub, PDF_NAME), pdf);
  console.log(`Written: docs/USER_MANUAL.md, docs/generated/flows/*.svg (${FLOWS.length}), docs/generated/${PDF_NAME} (${range.count} pages) and its copy in frontend/public/guidelines`);
});
