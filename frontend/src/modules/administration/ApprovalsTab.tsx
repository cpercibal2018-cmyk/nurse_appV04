import { useState } from 'react';
import { App, Button, Empty, Flex, Input, Modal, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useApprovals, useDecide, type ApprovalRequest } from './api';

const show = (v: unknown) => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));

function describe(r: ApprovalRequest): string {
  const p = r.payload;
  if (p.kind === 'TEMPLATE_CREATE') return `New credential type ${p.template.code} — ${p.template.name} — “${p.reason}”`;
  if (p.kind === 'TEMPLATE_UPDATE') {
    const diff = Object.keys(p.change).map((k) => `${k}: ${show(p.before[k])} → ${show(p.change[k])}`).join('; ');
    return `Change credential type ${p.code}: ${diff} — “${p.reason}”`;
  }
  if (p.kind === 'CATEGORY_CREATE') return `New credential category ${p.category.code} — ${p.category.name} — “${p.reason}”`;
  if (p.kind === 'CATEGORY_UPDATE') {
    const diff = Object.keys(p.change).map((k) => `${k}: ${show(p.before[k])} → ${show(p.change[k])}`).join('; ');
    return `Change credential category ${p.code}: ${diff} — “${p.reason}”`;
  }
  if (p.kind === 'GRANT') {
    const g = p.grant;
    return `Grant ${g.role} (${g.scopeType}${g.scopeIds.length ? ` ${g.scopeIds.join(', ')}` : ''}) to account #${g.userId} — “${g.reason}”`;
  }
  return `Change assignment #${p.assignmentId} to ${p.update.scopeType ?? 'same scope'} — “${p.update.reason}”`;
}

export function ApprovalsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const approvals = useApprovals();
  const decide = useDecide();
  const [pending, setPending] = useState<{ request: ApprovalRequest; decision: 'approve' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');

  async function confirm() {
    if (!pending) return;
    try {
      await decide.mutateAsync({ id: pending.request.id, decision: pending.decision, reason });
      message.success(t('saved'));
      setPending(null);
      setReason('');
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <>
      <Table<ApprovalRequest>
        rowKey="id"
        loading={approvals.isLoading}
        dataSource={approvals.data?.items}
        locale={{ emptyText: <Empty description={t('noPending')} /> }}
        pagination={false}
        scroll={{ x: true }}
        columns={[
          { title: '#', dataIndex: 'id', width: 60 },
          { title: t('status'), render: (_, r) => <Tag color="orange">{r.status}</Tag> },
          { title: t('reason'), render: (_, r) => describe(r) },
          { title: t('initiator'), render: (_, r) => r.initiator.displayName },
          { title: t('requested'), render: (_, r) => new Date(r.createdAt).toLocaleString() },
          {
            title: '', render: (_, r) => (
              <Flex gap={8}>
                <Button size="small" type="primary" onClick={() => setPending({ request: r, decision: 'approve' })}>{t('approve')}</Button>
                <Button size="small" danger onClick={() => setPending({ request: r, decision: 'reject' })}>{t('reject')}</Button>
              </Flex>
            ),
          },
        ]}
      />
      <Modal
        title={pending ? `${t(pending.decision)} #${pending.request.id}` : ''}
        open={pending !== null}
        onCancel={() => setPending(null)}
        onOk={confirm}
        okText={pending ? t(pending.decision) : ''}
        cancelText={t('cancel')}
        okButtonProps={{ danger: pending?.decision === 'reject', disabled: reason.trim().length < 5, loading: decide.isPending }}
        destroyOnHidden
      >
        {pending && <p>{describe(pending.request)}</p>}
        <Input.TextArea rows={3} placeholder={t('decisionReasonHint')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      </Modal>
    </>
  );
}
