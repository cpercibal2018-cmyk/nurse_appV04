// Data-subject requests (spec §8.3.3, D-55), worked by HR within scope:
// take into review, approve (access / portability: the package is ready;
// correction: then complete with a note), or decline with a reason. An
// erasure is approved only by a System Admin other than whoever logged it,
// who types the employee's job number to confirm. HR also logs requests
// received on paper or by e-mail.

import { useState } from 'react';
import { Alert, App, Button, Card, Checkbox, Flex, Form, Input, Modal, Select, Space, Table, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';
import type { DataSubjectRequest, DsrType } from '../../types/api';
import { useEmployees } from '../nurses/api';
import { DsrStatusTag, ErasureEvidence } from '../privacy/DsrParts';
import { useDataSubjectRequests, useDsrAction, type DsrAction } from './api';

const TYPES: DsrType[] = ['ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE'];
type Dialog = null | { kind: 'log' } | { kind: 'reject' | 'complete' | 'erase'; r: DataSubjectRequest };

export function DataSubjectRequests() {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const { user } = useAuth();
  const { hasRole } = usePermissions();
  const canErase = hasRole('SYSTEM_ADMIN');
  const [openOnly, setOpenOnly] = useState(true);
  const [type, setType] = useState<DsrType | undefined>();
  const list = useDataSubjectRequests({ open: openOnly, type });
  const action = useDsrAction();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form] = Form.useForm();
  const [search, setSearch] = useState('');
  const picker = useEmployees({ q: search || undefined, page: 1 });

  async function run(a: DsrAction, done: string) {
    try {
      await action.mutateAsync(a);
      message.success(done);
      setDialog(null);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  async function download(r: DataSubjectRequest) {
    try { await http.download(`/pdpl/requests/${r.id}/export`, 'personal-data.json'); } catch (e) { message.error(describeApiError(e)); }
  }

  const own = (r: DataSubjectRequest) => user?.employeeId === r.employee.id;
  const actions = (r: DataSubjectRequest) => {
    if (own(r)) return <Typography.Text type="secondary">{t('dsrOwnRequest')}</Typography.Text>;
    const openish = r.status === 'RECEIVED' || r.status === 'IN_REVIEW';
    return (
      <Space wrap size={4}>
        {r.status === 'RECEIVED' && <Button size="small" onClick={() => void run({ kind: 'review', id: r.id }, t('saved'))}>{t('dsrStartReview')}</Button>}
        {openish && r.type !== 'ERASURE' && (
          <Button size="small" type="primary" onClick={() => modal.confirm({
            title: t(`dsrApproveConfirm_${r.type === 'RECTIFICATION' ? 'RECTIFICATION' : 'EXPORT'}`), okText: t('approve'), cancelText: t('cancel'),
            onOk: () => run({ kind: 'approve', id: r.id }, t('saved')),
          })}>{t('approve')}</Button>
        )}
        {openish && r.type === 'ERASURE' && canErase && r.requestedBy.id !== user?.id && (
          <Button size="small" danger type="primary" onClick={() => { form.resetFields(); setDialog({ kind: 'erase', r }); }}>{t('dsrErase')}</Button>
        )}
        {r.status === 'APPROVED' && r.type === 'RECTIFICATION' && <Button size="small" type="primary" onClick={() => { form.resetFields(); setDialog({ kind: 'complete', r }); }}>{t('dsrComplete')}</Button>}
        {openish && <Button size="small" danger onClick={() => { form.resetFields(); setDialog({ kind: 'reject', r }); }}>{t('dsrDecline')}</Button>}
        {r.exportAvailable && <Button size="small" onClick={() => void download(r)}>{t('dsrDownload')}</Button>}
      </Space>
    );
  };

  async function submit(v: { employeeId?: number; type?: DsrType; details?: string; note?: string; confirmJobNumber?: string }) {
    if (!dialog) return;
    if (dialog.kind === 'log') await run({ kind: 'log', body: { employeeId: v.employeeId!, type: v.type!, details: v.details?.trim() || undefined } }, t('saved'));
    else if (dialog.kind === 'erase') await run({ kind: 'erase', id: dialog.r.id, note: v.note!, confirmJobNumber: v.confirmJobNumber! }, t('dsrErased'));
    else await run({ kind: dialog.kind, id: dialog.r.id, note: v.note! }, t('saved'));
  }

  return (
    <Card size="small" title={t('dsrQueue')} style={{ marginBottom: 16 }}
      extra={<Button onClick={() => { form.resetFields(); setDialog({ kind: 'log' }); }}>{t('dsrLog')}</Button>}>
      <Flex gap={12} wrap style={{ marginBottom: 12 }}>
        <Checkbox checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)}>{t('dsrOpenOnly')}</Checkbox>
        <Select allowClear placeholder={t('dsrType')} style={{ width: 220 }} value={type} onChange={setType} options={TYPES.map((v) => ({ value: v, label: t(`dsr_${v}`) }))} />
      </Flex>
      <Table<DataSubjectRequest>
        rowKey="id" size="small" loading={list.isLoading} dataSource={list.data?.items} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: true }}
        locale={{ emptyText: t('dsrNone') }}
        columns={[
          { title: t('employee'), render: (_, r) => `${r.employee.jobNumber} — ${r.employee.fullName}` },
          { title: t('dsrType'), render: (_, r) => t(`dsr_${r.type}`) },
          { title: t('requested'), render: (_, r) => <>{new Date(r.requestedAt).toLocaleDateString()}<br /><Typography.Text type="secondary">{r.requestedBy.displayName}</Typography.Text></> },
          { title: t('dsrDue'), render: (_, r) => new Date(r.dueAt).toLocaleDateString() },
          { title: t('status'), render: (_, r) => <DsrStatusTag r={r} /> },
          {
            title: t('details'), render: (_, r) => (
              <Flex vertical gap={2}>
                {r.details && <span>{r.details}</span>}
                {r.decisionNote && <Typography.Text type="secondary">{r.decidedBy?.displayName}: {r.decisionNote}</Typography.Text>}
                {r.erasure && <ErasureEvidence e={r.erasure} />}
              </Flex>
            ),
          },
          { title: '', render: (_, r) => actions(r) },
        ]}
      />
      <Modal open={dialog !== null} onCancel={() => setDialog(null)} onOk={() => form.submit()} okText={dialog?.kind === 'erase' ? t('dsrErase') : t('submit')}
        okButtonProps={{ danger: dialog?.kind === 'erase' || dialog?.kind === 'reject' }} cancelText={t('cancel')} confirmLoading={action.isPending} destroyOnHidden
        title={dialog ? (dialog.kind === 'log' ? t('dsrLog') : `${t(`dsr_${dialog.r.type}`)} — ${dialog.r.employee.fullName}`) : ''}>
        <Form form={form} layout="vertical" onFinish={submit}>
          {dialog?.kind === 'log' && (
            <>
              <Form.Item name="employeeId" label={t('employee')} rules={[{ required: true }]}>
                <Select showSearch={{ filterOption: false, onSearch: setSearch }} loading={picker.isFetching} placeholder={t('searchJobOrName')}
                  options={picker.data?.items.map((e) => ({ value: e.id, label: `${e.jobNumber} — ${e.fullName}` }))} />
              </Form.Item>
              <Form.Item name="type" label={t('dsrType')} rules={[{ required: true }]}>
                <Select options={TYPES.map((v) => ({ value: v, label: t(`dsr_${v}`) }))} />
              </Form.Item>
              <Form.Item name="details" label={t('dsrDetails')} extra={t('dsrLogHint')} rules={[{ max: 2000 }]}><Input.TextArea rows={3} /></Form.Item>
            </>
          )}
          {dialog?.kind === 'erase' && (
            <Alert type="error" showIcon style={{ marginBottom: 12 }} title={t('dsrEraseWarning')} description={t('dsrEraseScope')} />
          )}
          {dialog && dialog.kind !== 'log' && (
            <Form.Item name="note" label={dialog.kind === 'complete' ? t('dsrWhatChanged') : t('reason')} rules={[{ required: true, min: 10, max: 2000 }]}>
              <Input.TextArea rows={3} />
            </Form.Item>
          )}
          {dialog?.kind === 'erase' && (
            <Form.Item name="confirmJobNumber" label={t('dsrConfirmJobNumber', { jobNumber: dialog.r.employee.jobNumber })}
              rules={[{ required: true }, { validator: (_, v) => (v === dialog.r.employee.jobNumber ? Promise.resolve() : Promise.reject(new Error(t('dsrConfirmMismatch')))) }]}>
              <Input autoComplete="off" />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}
