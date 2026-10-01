// Lays a workflow out as positioned boxes, arrows and labels, then renders it
// as SVG. The same layout is drawn into the PDF by scripts/manual/build.ts, so
// the page, the image files and the manual show identical diagrams.

import { ROLE_LABEL, type Flow, type FlowNode, type FlowNodeKind } from './types';

export interface BoxShape { type: 'box'; x: number; y: number; w: number; h: number; kind: FlowNodeKind; lines: string[]; role?: string }
export interface BandShape { type: 'band'; x: number; y: number; w: number; h: number; text: string }
export interface ArrowShape { type: 'arrow'; points: Array<[number, number]>; head: boolean }
export interface LabelShape { type: 'label'; x: number; y: number; text: string }
export type Shape = BoxShape | BandShape | ArrowShape | LabelShape;

export interface FlowLayout { width: number; height: number; title: string; shapes: Shape[] }

export const FLOW_FONT = { size: 13, line: 17, roleSize: 10, labelSize: 11 };
const PAD = 18;
const GAP = 28; // arrow between two nodes
const GAP_X = 18;
const TITLE_H = 30;
const CHAR_W = 6.7; // average width of a 13px sans-serif character, for wrapping

/** Splits text into lines that fit `width` px at the flow font (an estimate; boxes are generous). */
export function wrap(text: string, width: number): string[] {
  const max = Math.max(8, Math.floor((width - 24) / CHAR_W));
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= max) line += ' ' + word;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function boxFor(node: FlowNode, x: number, y: number, w: number): BoxShape {
  const lines = wrap(node.label, w);
  const role = node.role ? ROLE_LABEL[node.role] : undefined;
  const h = 14 + (role ? 14 : 0) + lines.length * FLOW_FONT.line + 10;
  return { type: 'box', x, y, w, h, kind: node.kind, lines, role };
}

/** Places a list of nodes downwards from (cx, y); returns the shapes and the bottom edge. */
function column(nodes: FlowNode[], cx: number, y: number, w: number, shapes: Shape[]): number {
  let cursor = y;
  nodes.forEach((node, i) => {
    if (i > 0) {
      shapes.push({ type: 'arrow', points: [[cx, cursor], [cx, cursor + GAP]], head: true });
      cursor += GAP;
    }
    if (node.kind === 'group') {
      shapes.push({ type: 'band', x: cx - w / 2, y: cursor, w, h: 24, text: node.label });
      cursor += 24;
      return;
    }
    const box = boxFor(node, cx - w / 2, cursor, w);
    shapes.push(box);
    cursor += box.h;
    if (node.branches?.length) cursor = branches(node, cx, cursor, shapes);
  });
  return cursor;
}

const branchWidth = (n: number) => (n <= 2 ? 250 : n === 3 ? 210 : 180);

function branches(node: FlowNode, cx: number, top: number, shapes: Shape[]): number {
  const list = node.branches!;
  const bw = branchWidth(list.length);
  const total = list.length * bw + (list.length - 1) * GAP_X;
  const split = top + 14;
  let bottom = top;
  list.forEach((b, i) => {
    const bx = cx - total / 2 + bw / 2 + i * (bw + GAP_X);
    const start = split + 34;
    shapes.push({ type: 'arrow', points: [[cx, top], [cx, split], [bx, split], [bx, start]], head: true });
    shapes.push({ type: 'label', x: bx, y: split + 15, text: b.label });
    bottom = Math.max(bottom, column(b.nodes, bx, start, bw, shapes));
  });
  return bottom;
}

/** The widest row a flow needs (its main column or its widest decision). */
function widthOf(nodes: FlowNode[], w: number): number {
  let width = w;
  for (const n of nodes) {
    if (!n.branches?.length) continue;
    const bw = branchWidth(n.branches.length);
    const inner = n.branches.reduce((sum, b) => sum + Math.max(bw, widthOf(b.nodes, bw)), 0) + (n.branches.length - 1) * GAP_X;
    width = Math.max(width, inner);
  }
  return width;
}

export function layoutFlow(flow: Flow, mainWidth = 320): FlowLayout {
  if (flow.columns === 2) return twoColumns(flow, mainWidth);
  const inner = widthOf(flow.nodes, mainWidth);
  const width = inner + PAD * 2;
  const shapes: Shape[] = [];
  const bottom = column(flow.nodes, width / 2, PAD + TITLE_H, mainWidth, shapes);
  return { width, height: bottom + PAD, title: flow.title, shapes };
}

/** Two columns side by side, split at the group heading nearest the middle; an arrow leads from the first to the second. */
function twoColumns(flow: Flow, w: number): FlowLayout {
  const groups = flow.nodes.map((n, i) => (n.kind === 'group' ? i : -1)).filter((i) => i > 0);
  const middle = flow.nodes.length / 2;
  const at = groups.length ? groups.reduce((a, b) => (Math.abs(b - middle) < Math.abs(a - middle) ? b : a)) : Math.ceil(middle);
  const gap = 64;
  const width = PAD * 2 + w * 2 + gap;
  const top = PAD + TITLE_H;
  const left = PAD + w / 2;
  const right = PAD + w + gap + w / 2;
  const shapes: Shape[] = [];
  const bottomLeft = column(flow.nodes.slice(0, at), left, top, w, shapes);
  const bottomRight = column(flow.nodes.slice(at), right, top, w, shapes);
  const mid = PAD + w + gap / 2;
  shapes.push({ type: 'arrow', points: [[left, bottomLeft], [left, bottomLeft + 12], [mid, bottomLeft + 12], [mid, top - 10], [right, top - 10], [right, top]], head: true });
  return { width, height: Math.max(bottomLeft + 12, bottomRight) + PAD, title: flow.title, shapes };
}

export interface FlowPalette {
  background: string; title: string; text: string; muted: string; line: string; band: string;
  fill: Record<FlowNodeKind, string>; stroke: Record<FlowNodeKind, string>; ink: Record<FlowNodeKind, string>;
}

export const LIGHT: FlowPalette = {
  background: '#ffffff', title: '#0f3024', text: '#1f2933', muted: '#5b6660', line: '#7b8d85', band: '#1f6b4f',
  fill: { start: '#e6f4ea', step: '#ffffff', state: '#eef3f8', decision: '#fff4dc', end: '#1f6b4f', stop: '#fdecec', group: '#ffffff' },
  stroke: { start: '#1f6b4f', step: '#9fb3aa', state: '#7d9cc0', decision: '#d99a1e', end: '#1f6b4f', stop: '#b3261e', group: '#1f6b4f' },
  ink: { start: '#0f3024', step: '#1f2933', state: '#1f2933', decision: '#5c3d00', end: '#ffffff', stop: '#7a1712', group: '#1f6b4f' },
};

export const DARK: FlowPalette = {
  background: '#141414', title: '#cfe8dc', text: '#e6e6e6', muted: '#a3b1aa', line: '#8fa39a', band: '#7fd1a8',
  fill: { start: '#163a2c', step: '#1f1f1f', state: '#1b2633', decision: '#3a2c0c', end: '#2f8a64', stop: '#3a1614', group: '#141414' },
  stroke: { start: '#4fa37f', step: '#56645d', state: '#5b7ea8', decision: '#c99a3a', end: '#4fa37f', stop: '#d9645b', group: '#7fd1a8' },
  ink: { start: '#d6f0e3', step: '#e6e6e6', state: '#dbe6f2', decision: '#f2dca8', end: '#ffffff', stop: '#f5c6c2', group: '#7fd1a8' },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A standalone SVG image of the flow (valid on its own, e.g. as a file). */
export function flowToSvg(layout: FlowLayout, p: FlowPalette = LIGHT): string {
  const font = 'Segoe UI, Arial, Helvetica, sans-serif';
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="${esc(layout.title)}" font-family="${font}">`);
  out.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${p.line}"/></marker></defs>`);
  out.push(`<rect width="100%" height="100%" fill="${p.background}" rx="10"/>`);
  out.push(`<text x="${layout.width / 2}" y="${18 + 12}" text-anchor="middle" font-size="15" font-weight="700" fill="${p.title}">${esc(layout.title)}</text>`);
  for (const s of layout.shapes) {
    if (s.type === 'arrow') {
      out.push(`<polyline points="${s.points.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none" stroke="${p.line}" stroke-width="1.6"${s.head ? ' marker-end="url(#arrow)"' : ''}/>`);
    } else if (s.type === 'label') {
      const w = s.text.length * 6.4 + 10; // estimate; the arrow passes behind the label
      out.push(`<rect x="${s.x - w / 2}" y="${s.y - 12}" width="${w}" height="16" rx="3" fill="${p.background}"/>`);
      out.push(`<text x="${s.x}" y="${s.y}" text-anchor="middle" font-size="${FLOW_FONT.labelSize}" font-weight="600" fill="${p.muted}">${esc(s.text)}</text>`);
    } else if (s.type === 'band') {
      out.push(`<line x1="${s.x}" y1="${s.y + s.h - 4}" x2="${s.x + s.w}" y2="${s.y + s.h - 4}" stroke="${p.band}" stroke-width="1"/>`);
      out.push(`<text x="${s.x + s.w / 2}" y="${s.y + 14}" text-anchor="middle" font-size="11" font-weight="700" letter-spacing="1" fill="${p.band}">${esc(s.text)}</text>`);
    } else {
      const radius = s.kind === 'decision' ? 4 : s.kind === 'start' || s.kind === 'end' || s.kind === 'stop' ? 18 : 8;
      out.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${radius}" fill="${p.fill[s.kind]}" stroke="${p.stroke[s.kind]}" stroke-width="${s.kind === 'decision' ? 2 : 1.4}"${s.kind === 'decision' ? ' stroke-dasharray="5 3"' : ''}/>`);
      let y = s.y + 14;
      if (s.role) {
        out.push(`<text x="${s.x + s.w / 2}" y="${y + 6}" text-anchor="middle" font-size="${FLOW_FONT.roleSize}" font-weight="700" letter-spacing="0.6" fill="${s.kind === 'end' ? p.ink.end : p.muted}">${esc(s.role.toUpperCase())}</text>`);
        y += 14;
      }
      s.lines.forEach((line, i) => {
        out.push(`<text x="${s.x + s.w / 2}" y="${y + 9 + i * FLOW_FONT.line}" text-anchor="middle" font-size="${FLOW_FONT.size}"${s.kind === 'end' || s.kind === 'decision' ? ' font-weight="600"' : ''} fill="${p.ink[s.kind]}">${esc(line)}</text>`);
      });
    }
  }
  out.push('</svg>');
  return out.join('');
}

/** The flow as plain text, for screen readers and for search. */
export function flowToText(flow: Flow): string {
  const walk = (nodes: FlowNode[], depth: number): string[] => nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.kind === 'group' ? `[${n.label}]` : `- ${n.label}${n.role ? ` (${ROLE_LABEL[n.role]})` : ''}`}`,
    ...(n.branches ?? []).flatMap((b) => [`${'  '.repeat(depth + 1)}${b.label}:`, ...walk(b.nodes, depth + 2)]),
  ]);
  return [flow.title, ...walk(flow.nodes, 0)].join('\n');
}
