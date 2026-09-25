// Audit trail (spec §9.1; D-20: System Admin only). Read-only search plus the
// hash-chain check; the chain itself is written only by the database function.

import { useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Flex, Input, InputNumber, Select, Table, Tabs, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useAudit, useRequestLog, useVerify, type AuditFilter, type AuditRow, type RequestLogFilter, type RequestLogRow } from './api';

export default function AuditPage() {
  const { t } = useTranslation();
  return (
    <Card title={t('audit')}>
      <Tabs destroyOnHidden items={[
        { key: 'trail', label: t('auditTrail'), children: <AuditTrail /> },
        { key: 'requests', label: t('requestLog'), children: <RequestLog /> },
      ]} />
    </Card>
  );
}

function AuditTrail() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [filter, setFilter] = useState<AuditFilter>({ page: 1 });
  const audit = useAudit(filter);
  const verify = useVerify();
  const set = (patch: Partial<AuditFilter>) => setFilter({ ...filter, ...patch, page: 1 });

  return (
    <>
      <Flex justify="flex-end" style={{ marginBottom: 12 }}>
        <Button onClick={() => verify.mutateAsync().catch((e) => message.error(describeApiError(e)))} loading={verify.isPending}>{t('verifyChain')}</Button>
      </Flex>
      {verify.data && (
        <Alert style={{ marginBottom: 12 }} showIcon type={verify.data.intact ? 'success' : 'error'}
          title={verify.data.intact ? t('chainIntact') : t('chainBroken', { count: verify.data.breaks.length })}
          description={verify.data.breaks.map((b) => `#${b.id} ${b.reason}`).join(', ') || undefined} />
      )}
      {audit.error && <Alert type="error" showIcon title={describeApiError(audit.error)} style={{ marginBottom: 12 }} />}
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder={t('action')} style={{ width: 220 }} onSearch={(v) => set({ action: v.trim().toUpperCase() || undefined })} />
        <Input.Search allowClear placeholder={t('resource')} style={{ width: 180 }} onSearch={(v) => set({ resource: v.trim() || undefined })} />
        <Input.Search allowClear placeholder={t('resourceId')} style={{ width: 140 }} onSearch={(v) => set({ resourceId: v.trim() || undefined })} />
        <Select allowClear placeholder={t('priority')} style={{ width: 140 }} onChange={(v) => set({ priority: v ?? undefined })} options={[{ value: 'HIGH', label: 'HIGH' }, { value: 'NORMAL', label: 'NORMAL' }]} />
        <DatePicker.RangePicker onChange={(r) => set({ from: r?.[0]?.format('YYYY-MM-DD'), to: r?.[1]?.format('YYYY-MM-DD') })} />
      </Flex>
      <Table<AuditRow>
        rowKey="id" size="small" loading={audit.isLoading} dataSource={audit.data?.items} scroll={{ x: true }}
        pagination={{ current: filter.page, pageSize: 50, total: audit.data?.total, onChange: (page) => setFilter({ ...filter, page }) }}
        expandable={{ expandedRowRender: (r) => <Typography.Paragraph code style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(r.changes, null, 2)}</Typography.Paragraph> }}
        columns={[
          { title: '#', dataIndex: 'id', width: 80 },
          { title: t('when'), render: (_, r) => new Date(r.createdAt).toLocaleString() },
          { title: t('action'), render: (_, r) => <>{r.priority === 'HIGH' && <Tag color="red">HIGH</Tag>}{r.action}</> },
          { title: t('resource'), render: (_, r) => `${r.resource}${r.resourceId ? ` #${r.resourceId}` : ''}` },
          { title: t('by'), render: (_, r) => r.actorName ?? (r.actorUserId ? `#${r.actorUserId}` : t('system')) },
        ]}
      />
    </>
  );
}

const statusColor = (s: number) => (s >= 500 ? 'red' : s >= 400 ? 'orange' : s >= 300 ? 'blue' : 'green');

/** Spec §9.2: who called which endpoint, when, from where, and what happened. */
function RequestLog() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<RequestLogFilter>({ page: 1 });
  const log = useRequestLog(filter);
  const set = (patch: Partial<RequestLogFilter>) => setFilter({ ...filter, ...patch, page: 1 });

  return (
    <>
      <Alert type="info" showIcon title={t('requestLogHint')} style={{ marginBottom: 12 }} />
      {log.error && <Alert type="error" showIcon title={describeApiError(log.error)} style={{ marginBottom: 12 }} />}
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <InputNumber placeholder={t('userId')} min={1} style={{ width: 120 }} onChange={(v) => set({ actor: typeof v === 'number' ? v : undefined })} />
        <Input.Search allowClear placeholder={t('requestPath')} style={{ width: 220 }} onSearch={(v) => set({ path: v.trim() || undefined })} />
        <Select allowClear placeholder={t('method')} style={{ width: 120 }} onChange={(v) => set({ method: v ?? undefined })}
          options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ value: m, label: m }))} />
        <Select allowClear placeholder={t('outcome')} style={{ width: 150 }} onChange={(v) => set({ status: v ?? undefined })}
          options={[{ value: '2xx', label: `2xx ${t('succeeded')}` }, { value: '4xx', label: `4xx ${t('refused')}` }, { value: '401', label: '401' }, { value: '403', label: '403' }, { value: '5xx', label: `5xx ${t('serverError')}` }]} />
        <Input.Search allowClear placeholder={t('errorCode')} style={{ width: 180 }} onSearch={(v) => set({ errorCode: v.trim().toUpperCase() || undefined })} />
        <Input.Search allowClear placeholder={t('requestIdLabel')} style={{ width: 220 }} onSearch={(v) => set({ requestId: v.trim() || undefined })} />
        <DatePicker.RangePicker onChange={(r) => set({ from: r?.[0]?.format('YYYY-MM-DD'), to: r?.[1]?.format('YYYY-MM-DD') })} />
      </Flex>
      <Table<RequestLogRow>
        rowKey="id" size="small" loading={log.isLoading} dataSource={log.data?.items} scroll={{ x: true }}
        pagination={{ current: filter.page, pageSize: 50, total: log.data?.total, showSizeChanger: false, onChange: (page) => setFilter({ ...filter, page }) }}
        expandable={{ expandedRowRender: (r) => (
          <Typography.Paragraph style={{ margin: 0, fontSize: 12 }}>
            <b>{t('requestIdLabel')}:</b> <Typography.Text code copyable>{r.requestId}</Typography.Text><br />
            <b>{t('browser')}:</b> {r.userAgent ?? '—'}<br />
            <b>{t('session')}:</b> {r.sessionFamily ?? '—'} · <b>{t('bodyHash')}:</b> {r.paramsHash ? <Typography.Text code>{r.paramsHash.slice(0, 16)}…</Typography.Text> : '—'}
          </Typography.Paragraph>
        ) }}
        columns={[
          { title: t('when'), render: (_, r) => new Date(r.at).toLocaleString() },
          { title: t('by'), render: (_, r) => r.actorUserId ? <>{r.actorName ?? `#${r.actorUserId}`} <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.actorRoles}</Typography.Text></> : <Typography.Text type="secondary">{t('notSignedIn')}</Typography.Text> },
          { title: t('request'), render: (_, r) => <span style={{ direction: 'ltr', unicodeBidi: 'embed' }}><Tag>{r.method}</Tag><Typography.Text code>{r.path}</Typography.Text></span> },
          { title: t('outcome'), render: (_, r) => <><Tag color={statusColor(r.statusCode)}>{r.statusCode}</Tag>{r.errorCode && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.errorCode}</Typography.Text>}</> },
          { title: t('duration'), render: (_, r) => `${r.durationMs} ms` },
          { title: t('address'), dataIndex: 'ipAddress' },
        ]}
      />
    </>
  );
}
