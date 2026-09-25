// Data protection (spec §8.3.2, D-54): the processing register — the lawful
// basis, purpose and retention for each category of sensitive personal data.
// HR and System Admins read it; a System Admin changes it (with a reason,
// audited HIGH). A category without an active entry cannot be stored.

import { useState } from 'react';
import { Alert, App, Button, Form, Input, Modal, Switch, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { describeApiError } from '../../lib/errors';
import { useProcessingRegister, useUpdateRegister, type RegisterEntry } from './api';

export function DataProtectionTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { hasRole } = usePermissions();
  const canEdit = hasRole('SYSTEM_ADMIN');
  const register = useProcessingRegister();
  const update = useUpdateRegister();
  const [editing, setEditing] = useState<RegisterEntry | null>(null);
  const [form] = Form.useForm<{ purpose: string; retentionRule: string; isActive: boolean; reason: string }>();

  async function save(v: { purpose: string; retentionRule: string; isActive: boolean; reason: string }) {
    if (!editing) return;
    try {
      await update.mutateAsync({ id: editing.id, body: v });
      message.success(t('saved'));
      setEditing(null);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <>
      <Alert type="info" showIcon title={t('dataProtectionHint')} style={{ marginBottom: 12 }} />
      <Table<RegisterEntry>
        rowKey="id" size="small" loading={register.isLoading} dataSource={register.data?.items} pagination={false} scroll={{ x: true }}
        columns={[
          { title: t('dataCategory'), render: (_, r) => t(`pdpl_${r.dataCategory}`) },
          { title: t('lawfulBasis'), render: (_, r) => t(`basis_${r.lawfulBasis}`) },
          { title: t('purpose'), dataIndex: 'purpose' },
          { title: t('retentionRule'), dataIndex: 'retentionRule' },
          { title: t('status'), render: (_, r) => <Tag color={r.isActive ? 'green' : 'default'}>{r.isActive ? t('active') : t('inactive')}</Tag> },
          ...(canEdit ? [{
            title: '', render: (_: unknown, r: RegisterEntry) => (
              <Button size="small" onClick={() => { setEditing(r); form.setFieldsValue({ purpose: r.purpose, retentionRule: r.retentionRule, isActive: r.isActive, reason: '' }); }}>{t('edit')}</Button>
            ),
          }] : []),
        ]}
      />
      <Modal open={editing !== null} title={editing ? `${t(`pdpl_${editing.dataCategory}`)} — ${t(`basis_${editing.lawfulBasis}`)}` : ''}
        onCancel={() => setEditing(null)} onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={update.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={save}>
          <Form.Item name="purpose" label={t('purpose')} rules={[{ required: true, min: 10, max: 1000 }]}><Input.TextArea rows={3} /></Form.Item>
          <Form.Item name="retentionRule" label={t('retentionRule')} rules={[{ required: true, min: 5, max: 500 }]}><Input /></Form.Item>
          <Form.Item name="isActive" label={t('active')} valuePropName="checked" extra={t('registerInactiveHint')}><Switch /></Form.Item>
          <Form.Item name="reason" label={t('reason')} rules={[{ required: true, min: 10, max: 1000 }]}><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
