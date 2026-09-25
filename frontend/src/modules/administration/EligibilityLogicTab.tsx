// Eligibility logic — shadow mode (spec §10.9, D-60). A new version of the
// eligibility rules runs beside the active one and never changes a result; each
// disagreement waits here for an HR decision. The version can be promoted after
// 7 days without a disagreement, or once every disagreement is approved. HR and
// System Admins read; a system-wide HR Admin decides, promotes or retires.

import { useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Flex, Form, Input, Modal, Segmented, Space, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import type { EligibilityStatus } from '../credentials/api';
import { EligibilityTag } from '../credentials/components';
import {
  useDecideFinding, useEligibilityLogic, useLogicLifecycle, useShadowFindings,
  type FindingFilter, type LogicVersion, type ShadowFinding,
} from './api';

const VERSION_COLOR = { ACTIVE: 'green', SHADOW: 'blue', RETIRED: 'default' } as const;

function Outcome({ status }: { status: string }) {
  const { t } = useTranslation();
  return status === 'ERROR' ? <Tag color="magenta">{t('logicError')}</Tag> : <EligibilityTag status={status as EligibilityStatus} />;
}

export function EligibilityLogicTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  const canDecide = hasRole('HR_ADMIN');
  const logic = useEligibilityLogic();
  const shadow = logic.data?.shadow ?? null;
  const [filter, setFilter] = useState<FindingFilter>('undecided');
  const [page, setPage] = useState(1);
  const findings = useShadowFindings(shadow?.version, filter, page);
  const decide = useDecideFinding();
  const lifecycle = useLogicLifecycle();
  const [deciding, setDeciding] = useState<{ finding: ShadowFinding; decision: 'APPROVED' | 'REJECTED' } | null>(null);
  const [acting, setActing] = useState<'promote' | 'retire' | null>(null);
  const [noteForm] = Form.useForm<{ note: string }>();
  const [reasonForm] = Form.useForm<{ reason: string }>();

  async function submitDecision(v: { note: string }) {
    if (!deciding) return;
    try {
      await decide.mutateAsync({ id: deciding.finding.id, decision: deciding.decision, note: v.note });
      message.success(t('saved'));
      setDeciding(null);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  async function submitLifecycle(v: { reason: string }) {
    if (!acting || !shadow) return;
    try {
      await lifecycle.mutateAsync({ version: shadow.version, action: acting, reason: v.reason });
      message.success(acting === 'promote' ? t('logicPromoted', { version: shadow.version }) : t('logicRetired', { version: shadow.version }));
      setActing(null);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  const reasonText = (rs: Array<{ code: string }>) => rs.map((r) => r.code).join(', ') || '—';

  return (
    <Flex vertical gap={12}>
      <Alert type="info" showIcon title={t('logicHint')} />
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2 }} items={[
        { key: 'a', label: t('logicActive'), children: logic.data?.active ? t('logicVersionN', { version: logic.data.active }) : '—' },
        { key: 's', label: t('logicShadow'), children: shadow ? t('logicVersionN', { version: shadow.version }) : t('logicNoShadow') },
      ]} />

      {shadow && (
        <Card size="small" title={t('logicShadowTitle', { version: shadow.version })}>
          <Alert style={{ marginBottom: 12 }} showIcon type={shadow.promotable ? 'success' : 'warning'}
            title={shadow.promotable ? t('logicPromotable') : shadow.blocker} />
          {canDecide && (
            <Flex justify="flex-end" gap={8} wrap style={{ marginBottom: 12 }}>
              <Button onClick={() => { reasonForm.resetFields(); setActing('retire'); }}>{t('logicRetire')}</Button>
              <Button type="primary" disabled={!shadow.promotable} onClick={() => { reasonForm.resetFields(); setActing('promote'); }}>{t('logicPromote')}</Button>
            </Flex>
          )}
          <Descriptions size="small" column={{ xs: 2, sm: 3, md: 6 }} items={[
            { key: 'd', label: t('logicDaysInShadow'), children: shadow.daysInShadow },
            { key: 'f', label: t('logicFindings'), children: shadow.findings },
            { key: 'u', label: t('logicUndecided'), children: shadow.undecided },
            { key: 'p', label: t('logicApproved'), children: shadow.approved },
            { key: 'r', label: t('logicRejected'), children: shadow.rejected },
            { key: 'e', label: t('logicErrors'), children: shadow.errors },
          ]} />
          <div style={{ overflowX: 'auto', margin: '12px 0' }}><Segmented value={filter} onChange={(v) => { setFilter(v as FindingFilter); setPage(1); }}
            options={(['undecided', 'approved', 'rejected', 'all'] as const).map((f) => ({ value: f, label: t(`logicFilter_${f}`) }))} /></div>
          <Table<ShadowFinding>
            rowKey="id" size="small" loading={findings.isLoading} dataSource={findings.data?.items} scroll={{ x: 900 }}
            pagination={{ current: page, pageSize: 25, total: findings.data?.total ?? 0, onChange: setPage, hideOnSinglePage: true }}
            columns={[
              { title: t('logicNurse'), width: 200, render: (_, f) => <><Typography.Text strong>{f.employee.jobNumber}</Typography.Text> — {f.employee.fullName}</> },
              { title: t('logicDate'), width: 110, dataIndex: 'evalDate' },
              { title: t('logicActiveResult'), width: 170, render: (_, f) => <><Outcome status={f.activeStatus} /><div style={{ fontSize: 12 }}>{reasonText(f.activeReasons)}</div></> },
              { title: t('logicNewResult'), width: 170, render: (_, f) => <><Outcome status={f.candidateStatus} /><div style={{ fontSize: 12 }}>{reasonText(f.candidateReasons)}</div></> },
              {
                title: t('logicDecision'), render: (_, f) => f.decision
                  ? <><Tag color={f.decision === 'APPROVED' ? 'green' : 'red'}>{t(`logicDecision_${f.decision}`)}</Tag><div style={{ fontSize: 12 }}>{f.decidedBy?.displayName}: {f.decisionNote}</div></>
                  : canDecide
                    ? <Space wrap>
                        <Button size="small" disabled={f.candidateStatus === 'ERROR'} onClick={() => { noteForm.resetFields(); setDeciding({ finding: f, decision: 'APPROVED' }); }}>{t('logicApprove')}</Button>
                        <Button size="small" danger onClick={() => { noteForm.resetFields(); setDeciding({ finding: f, decision: 'REJECTED' }); }}>{t('logicReject')}</Button>
                      </Space>
                    : <Tag>{t('logicFilter_undecided')}</Tag>,
              },
            ]}
          />
        </Card>
      )}

      <Card size="small" title={t('logicVersions')}>
        <Table<LogicVersion>
          rowKey="version" size="small" loading={logic.isLoading} dataSource={logic.data?.versions} scroll={{ x: 900 }} pagination={{ pageSize: 10, hideOnSinglePage: true }}
          columns={[
            { title: t('logicVersion'), dataIndex: 'version' },
            { title: t('status'), render: (_, v) => <Tag color={VERSION_COLOR[v.status]}>{t(`logicStatus_${v.status}`)}</Tag> },
            { title: t('logicShadowSince'), render: (_, v) => (v.shadowSince ? new Date(v.shadowSince).toLocaleString() : '—') },
            { title: t('logicPromotedAt'), render: (_, v) => (v.promotedAt ? `${new Date(v.promotedAt).toLocaleString()}${v.promotedBy ? ` — ${v.promotedBy.displayName}` : ''}` : '—') },
            { title: t('logicRetiredAt'), render: (_, v) => (v.retiredAt ? new Date(v.retiredAt).toLocaleString() : '—') },
            { title: t('logicNote'), dataIndex: 'note' },
          ]}
        />
      </Card>

      <Modal open={deciding !== null} title={deciding ? t(deciding.decision === 'APPROVED' ? 'logicApproveTitle' : 'logicRejectTitle', { job: deciding.finding.employee.jobNumber }) : ''}
        onCancel={() => setDeciding(null)} onOk={() => noteForm.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={decide.isPending} destroyOnHidden>
        <Typography.Paragraph type="secondary">{deciding?.decision === 'APPROVED' ? t('logicApproveHint') : t('logicRejectHint')}</Typography.Paragraph>
        <Form form={noteForm} layout="vertical" onFinish={submitDecision}>
          <Form.Item name="note" label={t('logicNote')} rules={[{ required: true, whitespace: true, min: 10, message: t('logicNoteRule') }]}>
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={acting !== null} title={shadow ? t(acting === 'promote' ? 'logicPromoteTitle' : 'logicRetireTitle', { version: shadow.version }) : ''}
        onCancel={() => setActing(null)} onOk={() => reasonForm.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={lifecycle.isPending}
        okButtonProps={{ danger: acting === 'retire' }} destroyOnHidden>
        <Typography.Paragraph type="secondary">{acting === 'promote' ? t('logicPromoteHint', { version: shadow?.version }) : t('logicRetireHint')}</Typography.Paragraph>
        <Form form={reasonForm} layout="vertical" onFinish={submitLifecycle}>
          <Form.Item name="reason" label={t('reason')} rules={[{ required: true, whitespace: true, min: 10, message: t('logicNoteRule') }]}>
            <Input.TextArea rows={3} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
