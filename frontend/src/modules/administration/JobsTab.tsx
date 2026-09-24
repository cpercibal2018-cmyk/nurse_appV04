// Background jobs (System Admin): schedule, recent runs, and "run now".

import { Alert, App, Button, Card, Descriptions, Flex, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useBusinessHealth, useJobs, useRunJob, type JobRun } from '../audit/api';

const COLOR = { RUNNING: 'blue', COMPLETED: 'green', FAILED: 'red' } as const;

export function JobsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const jobs = useJobs();
  const run = useRunJob();
  return (
    <Flex vertical gap={12}>
      <HealthCard />
      {jobs.data?.items.map((j) => (
        <Card key={j.name} size="small" title={`${j.name} — ${j.schedule}`} extra={
          <Button size="small" loading={run.isPending && run.variables === j.name} onClick={async () => {
            try { const out = await run.mutateAsync(j.name); message.info(`${j.name}: ${out.status}${out.error ? ` — ${out.error}` : ''}`); } catch (e) { message.error(describeApiError(e)); }
          }}>{t('runNow')}</Button>
        }>
          <Table<JobRun> rowKey="id" size="small" pagination={false} dataSource={j.runs} scroll={{ x: true }}
            columns={[
              { title: t('period'), dataIndex: 'runKey' },
              { title: t('status'), render: (_, r) => <Tag color={COLOR[r.status]}>{r.status}</Tag> },
              { title: t('started'), render: (_, r) => new Date(r.startedAt).toLocaleString() },
              { title: t('attempts'), dataIndex: 'attempts' },
              { title: t('result'), render: (_, r) => <span style={{ fontSize: 12 }}>{r.error ?? (r.summary ? Object.entries(r.summary).map(([k, v]) => `${k}: ${v}`).join(' · ') : '')}</span> },
            ]} />
        </Card>
      ))}
    </Flex>
  );
}

/** Spec §10.8 business health: eligibility drift, job freshness, e-mail delivery. */
function HealthCard() {
  const { t } = useTranslation();
  const health = useBusinessHealth();
  const h = health.data;
  if (!h) return null;
  const e = h.eligibility;
  return (
    <Card size="small" title={t('businessHealth')} extra={<Tag color={h.status === 'HEALTHY' ? 'green' : 'orange'}>{t(`health_${h.status}`)}</Tag>}>
      {h.issues.length > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={t('healthIssues')}
          description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>{h.issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>} />
      )}
      <Descriptions size="small" column={1} bordered items={[
        { key: 'a', label: t('lastConsistencyAudit'), children: e.lastAuditAt ? `${new Date(e.lastAuditAt).toLocaleString()} — ${t('checkedDrifted', { checked: e.lastChecked ?? 0, drifted: e.lastDrifted ?? 0 })}` : t('never') },
        { key: 'r', label: t('driftRate7d'), children: e.driftRate7d === null ? '—' : `${(e.driftRate7d * 100).toFixed(1)}% (${e.drifts7d} / ${e.checked7d})` },
        { key: 'd', label: t('recentDrifts'), children: e.recentDrifts.length === 0 ? '—' : e.recentDrifts.slice(0, 5).map((d) => (d.stored === d.expected ? `${d.jobNumber}: ${d.expected} (${t('reasonsUpdated')})` : `${d.jobNumber}: ${d.stored ?? t('noStoredState')} → ${d.expected}`)).join(' · ') },
        { key: 'm', label: t('emailDelivery'), children: t('emailHealth', { pending: h.email.pendingOver15Minutes, failed: h.email.failedLast24Hours, last: h.email.lastSentAt ? new Date(h.email.lastSentAt).toLocaleString() : '—' }) },
      ]} />
    </Card>
  );
}
