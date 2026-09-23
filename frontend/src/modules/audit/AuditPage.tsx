// Audit trail (spec §9.1; D-20: System Admin only). Read-only search plus the
// hash-chain check; the chain itself is written only by the database function.

import { useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Flex, Input, Select, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useAudit, useVerify, type AuditFilter, type AuditRow } from './api';

export default function AuditPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [filter, setFilter] = useState<AuditFilter>({ page: 1 });
  const audit = useAudit(filter);
  const verify = useVerify();
  const set = (patch: Partial<AuditFilter>) => setFilter({ ...filter, ...patch, page: 1 });

  return (
    <Card title={t('audit')} extra={
      <Button onClick={() => verify.mutateAsync().catch((e) => message.error(describeApiError(e)))} loading={verify.isPending}>{t('verifyChain')}</Button>
    }>
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
    </Card>
  );
}
