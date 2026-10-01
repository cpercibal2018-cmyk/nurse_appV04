// docs/USER_MANUAL.md, generated from the Guidelines content (npm run docs:manual).
// A test compares the file with this output, so the two cannot drift apart.

import { flowById, sectionById, sectionNumber, SECTIONS } from './index';
import { ROLE_LABEL, STATUS_LABEL, type GuideSection, type GuideTable, type GuideTask } from './types';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const heading = (id: string) => `${sectionNumber(id)}. ${sectionById(id)!.title}`;
/** GitHub's heading anchor (as scripts/check-docs.mjs computes it). */
const anchor = (id: string) => `#${heading(id).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-')}`;

function table(t: GuideTable): string[] {
  return [
    `**${t.title}**`, '',
    `| ${t.columns.map(cell).join(' | ')} |`,
    `| ${t.columns.map(() => ':---').join(' | ')} |`,
    ...t.rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
    '',
  ];
}

function flowBlock(id: string): string[] {
  const f = flowById(id);
  if (!f) throw new Error(`unknown flow ${id}`);
  return [`![${f.title}](generated/flows/${f.id}.svg)`, '', ...(f.caption ? [`*${f.caption}*`, ''] : [])];
}

function task(t: GuideTask, n: string): string[] {
  const out = [
    `### ${n} ${t.title}`, '',
    `**Status:** ${STATUS_LABEL[t.status]}${t.statusNote ? ` — ${t.statusNote}` : ''}  `,
    `**Roles:** ${t.roles.map((r) => ROLE_LABEL[r]).join(', ')}`, '',
    `**Purpose.** ${t.purpose}`, '',
    `**Who can perform it.** ${t.who}`, '',
  ];
  if (t.before?.length) out.push('**Before you start.**', '', ...t.before.map((b) => `- ${b}`), '');
  out.push('**Steps.**', '', ...t.steps.map((s, i) => `${i + 1}. ${s}`), '');
  out.push(`**System result.** ${t.result}`, '', `**Approval.** ${t.approval}`, '', `**Next step.** ${t.next}`, '');
  if (t.problems?.length) out.push('**Common problems.**', '', ...t.problems.map((p) => `- *${p.problem}* — ${p.fix}`), '');
  if (t.related?.length) out.push(`**Related.** ${t.related.map((id) => `[${sectionById(id)!.title}](${anchor(id)})`).join(' · ')}`, '');
  if (t.flow) out.push(...flowBlock(t.flow));
  return out;
}

function section(s: GuideSection): string[] {
  const n = sectionNumber(s.id);
  const out = [`## ${heading(s.id)}`, '', s.summary, '', `**Who:** ${s.audience}  `];
  if (s.route) out.push(`**Screen:** \`${s.route}\`  `);
  if (s.where) out.push(`**Where:** ${s.where}`);
  out.push('');
  for (const c of s.callouts ?? []) out.push(`> **${c.kind === 'warning' ? 'Important' : 'Note'}:** ${c.text}`, '');
  for (const f of s.flows ?? []) out.push(...flowBlock(f));
  for (const t of s.tables ?? []) out.push(...table(t));
  s.tasks.forEach((t, i) => out.push(...task(t, `${n}.${i + 1}`)));
  return out;
}

export function renderManualMarkdown(version: string): string {
  return [
    '<!-- Generated from frontend/src/modules/guidelines/content by `npm run docs:manual`. Edit the content there, not this file. -->',
    '',
    `# AIGH Nursing Workforce — User Manual (V04, v${version})`,
    '',
    'The same guide is in the application (side menu → Guidelines) and as a printable PDF: [generated/AIGH_Nursing_Workforce_User_Manual_V04.pdf](generated/AIGH_Nursing_Workforce_User_Manual_V04.pdf). Every task is checked against the code; [GUIDELINES_COVERAGE.md](GUIDELINES_COVERAGE.md) shows the trace from screen to rule. Status: **Implemented**, **Partially implemented** (part of it is API-only or missing — said in the task), or **Planned / not currently available**.',
    '',
    '## Contents',
    '',
    ...SECTIONS.map((s) => `${sectionNumber(s.id)}. [${s.title}](${anchor(s.id)})`),
    '',
    ...SECTIONS.flatMap(section),
  ].join('\n');
}
