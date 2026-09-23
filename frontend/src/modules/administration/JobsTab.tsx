// Background jobs (System Admin): schedule, recent runs, and "run now".

import { App, Button, Card, Flex, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useJobs, useRunJob, type JobRun } from '../audit/api';

const COLOR = { RUNNING: 'blue', COMPLETED: 'green', FAILED: 'red' } as const;

export function JobsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const jobs = useJobs();
  const run = useRunJob();
  return (
    <Flex vertical gap={12}>
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
