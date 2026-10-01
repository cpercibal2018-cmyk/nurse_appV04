// The Guidelines content model. One source feeds the in-app Guidelines page,
// its search, docs/USER_MANUAL.md and the printable PDF (scripts/manual/build.ts).
// It is documentation only: nothing here grants, hides or decides anything —
// the server's permissions and rules stay the authority (docs/GUIDELINES_COVERAGE.md).

/** Who a task is for, as a reader understands it. `EMPLOYEE` = any signed-in account linked to an employee. */
export type GuideRole = 'EMPLOYEE' | 'SUPERVISOR' | 'HR_ADMIN' | 'SYSTEM_ADMIN';

/** IMPLEMENTED: on a screen and enforced. PARTIAL: some of it is API-only or missing. PLANNED: not available. */
export type ImplementationStatus = 'IMPLEMENTED' | 'PARTIAL' | 'PLANNED';

export interface Problem {
  problem: string;
  fix: string;
}

/** One task, always in the same template (purpose → related). */
export interface GuideTask {
  id: string;
  title: string;
  status: ImplementationStatus;
  /** Why it is partial or planned, in plain words. */
  statusNote?: string;
  purpose: string;
  /** Roles and scope in a sentence. */
  who: string;
  roles: GuideRole[];
  before?: string[];
  steps: string[];
  result: string;
  approval: string;
  next: string;
  problems?: Problem[];
  /** Section ids. */
  related?: string[];
  /** A workflow drawn for this task (flows.ts). */
  flow?: string;
  /** Extra words people search with ("license", "roster"…). */
  keywords?: string[];
}

export interface GuideTable {
  title: string;
  columns: string[];
  rows: string[][];
}

export interface Callout {
  kind: 'info' | 'warning';
  text: string;
}

export interface GuideSection {
  /** Stable id, used in links: /guidelines?s=<id>. */
  id: string;
  title: string;
  /** The application page this section is about (a path in MODULES), for "Open …" links. */
  route?: string;
  /** "I am on this screen — what is it for?" */
  summary: string;
  /** Who sees the screen. */
  audience: string;
  roles: GuideRole[];
  /** How to get there. */
  where?: string;
  callouts?: Callout[];
  tables?: GuideTable[];
  /** Workflows shown at section level. */
  flows?: string[];
  tasks: GuideTask[];
  keywords?: string[];
}

/** A workflow, drawn as an image (flowLayout.ts) in the page, the PDF and docs/generated/flows. */
export interface Flow {
  id: string;
  title: string;
  caption?: string;
  /** Long flows read better in two columns (split at the group nearest the middle). */
  columns?: 1 | 2;
  nodes: FlowNode[];
}

export type FlowNodeKind = 'start' | 'step' | 'state' | 'decision' | 'end' | 'stop' | 'group';

export interface FlowNode {
  kind: FlowNodeKind;
  label: string;
  /** Who performs this step. */
  role?: GuideRole | 'SYSTEM';
  /** Only on a decision, which must be a flow's (or a branch's) last node: two or three outcomes. */
  branches?: FlowBranch[];
}

export interface FlowBranch {
  label: string;
  nodes: FlowNode[];
}

export const ROLE_LABEL: Record<GuideRole | 'SYSTEM', string> = {
  EMPLOYEE: 'Employee',
  SUPERVISOR: 'Supervisor',
  HR_ADMIN: 'HR Admin',
  SYSTEM_ADMIN: 'System Admin',
  SYSTEM: 'System',
};

export const STATUS_LABEL: Record<ImplementationStatus, string> = {
  IMPLEMENTED: 'Implemented',
  PARTIAL: 'Partially implemented',
  PLANNED: 'Planned / not currently available',
};
