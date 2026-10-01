// Guidelines search: plain word matching over titles, keywords and text, with a
// few synonyms people use ("license", "roster", "approve"). No network, no index.

import { SECTIONS } from './index';
import type { GuideSection, GuideTask } from './types';

export interface SearchHit {
  section: GuideSection;
  task?: GuideTask;
  score: number;
}

const STOP = new Set(['a', 'an', 'the', 'how', 'do', 'does', 'i', 'to', 'is', 'my', 'of', 'in', 'on', 'for', 'and', 'or', 'can', 'can\'t', 'cant', 'what', 'why', 'where', 'who', 'when', 'it', 'be', 'me', 'with', 'this', 'that', 'are', 'does', 'mean', 'means', 'which']);

/** Alternative spellings and everyday words → the words the guide uses. */
const SYNONYMS: Record<string, string[]> = {
  license: ['licence'], licence: ['license'], licenses: ['licence'],
  roster: ['scheduling', 'shift'], rota: ['roster', 'scheduling'], schedule: ['roster', 'scheduling'],
  approve: ['approval', 'approvals'], approval: ['approve'], request: ['approval', 'requests'],
  login: ['sign'], signin: ['sign'], password: ['password'],
  nurse: ['nurses', 'employee'], staff: ['nurses', 'employee'], employee: ['nurses'],
  ineligible: ['eligibility', 'ineligible'], eligible: ['eligibility'], blocked: ['ineligible', 'eligibility'],
  certificate: ['credential'], certification: ['credential'], document: ['evidence'], upload: ['evidence'],
  configure: ['requirement', 'add'], requirement: ['requirements'],
  '2fa': ['two-factor'], mfa: ['two-factor'], authenticator: ['two-factor'],
  publish: ['publish', 'roster'], absent: ['missing', 'attendance'], late: ['missing', 'attendance'],
  pdpl: ['personal', 'data'], privacy: ['personal', 'data'],
};

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}_\-\s']/gu, ' ').split(/\s+/).filter(Boolean);

export function queryTerms(q: string): string[] {
  const base = words(q).filter((w) => !STOP.has(w) && w.length > 1);
  const out = new Set<string>();
  for (const w of base) {
    out.add(w);
    for (const s of SYNONYMS[w] ?? []) out.add(s);
    if (w.endsWith('s') && w.length > 4) out.add(w.slice(0, -1)); // nurses → nurse
  }
  return [...out];
}

const taskText = (t: GuideTask) => [t.purpose, t.who, ...(t.before ?? []), ...t.steps, t.result, t.approval, t.next, ...(t.problems ?? []).flatMap((p) => [p.problem, p.fix])].join(' ').toLowerCase();
const sectionText = (s: GuideSection) => [s.summary, s.audience, s.where ?? '', ...(s.callouts ?? []).map((c) => c.text), ...(s.tables ?? []).flatMap((t) => [t.title, ...t.rows.flat()])].join(' ').toLowerCase();

function score(terms: string[], phrase: string, title: string, keywords: string[], text: string): number {
  const t = title.toLowerCase();
  const k = keywords.join(' | ').toLowerCase();
  let s = 0;
  for (const w of terms) {
    if (t.includes(w)) s += 4;
    if (k.includes(w)) s += 3;
    if (text.includes(w)) s += 1;
  }
  // A typed question that matches a keyword phrase outright ("how do i publish a roster").
  if (phrase.length > 6 && (k.includes(phrase) || t.includes(phrase))) s += 8;
  return s;
}

/** Best matches first; at most `limit`. Hits under a third of the best score are dropped as noise. */
export function searchGuidelines(q: string, limit = 8): SearchHit[] {
  const terms = queryTerms(q);
  if (terms.length === 0) return [];
  const phrase = q.toLowerCase().trim().replace(/[?!.]+$/, '');
  const hits: SearchHit[] = [];
  for (const section of SECTIONS) {
    const s = score(terms, phrase, section.title, section.keywords ?? [], sectionText(section));
    if (s > 0) hits.push({ section, score: s * 0.8 }); // a task answers a question better than its section
    for (const task of section.tasks) {
      const ts = score(terms, phrase, task.title, task.keywords ?? [], taskText(task));
      if (ts > 0) hits.push({ section, task, score: ts });
    }
  }
  const best = Math.max(0, ...hits.map((h) => h.score));
  return hits.filter((h) => h.score >= Math.max(3, best * 0.35)).sort((a, b) => b.score - a.score).slice(0, limit);
}
