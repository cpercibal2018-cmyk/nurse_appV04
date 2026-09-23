import { useState } from 'react';
import { App, Button, Drawer, Form, Input, InputNumber, Popconfirm, Table, Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useAuth } from '../../hooks/useAuth';
import { useAccounts, useCreateAccount, useUpdateAccount, type Account } from './api';

interface NewAccount { email: string; displayName: string; password: string; employeeId?: number }

export function AccountsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const me = useAuth((s) => s.user);
  const accounts = useAccounts();
  const create = useCreateAccount();
  const update = useUpdateAccount();
  const [open, setOpen] = useState(false);
  // One key per form opening: a retried submit is applied once by the server.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [form] = Form.useForm<NewAccount>();

  async function submit(values: NewAccount) {
    try {
      await create.mutateAsync({ body: { ...values, employeeId: values.employeeId ?? null }, key });
      message.success(t('saved'));
      setOpen(false);
      form.resetFields();
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  async function toggle(a: Account) {
    try {
      await update.mutateAsync({ id: a.id, body: { isActive: !a.isActive } });
      message.success(t('saved'));
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => { setKey(crypto.randomUUID()); setOpen(true); }}>{t('newAccount')}</Button>
      </div>
      <Table<Account>
        rowKey="id"
        loading={accounts.isLoading}
        dataSource={accounts.data?.items}
        pagination={{ pageSize: 20 }}
        scroll={{ x: true }}
        columns={[
          { title: t('email'), dataIndex: 'email' },
          { title: t('displayName'), dataIndex: 'displayName' },
          { title: t('linkedEmployee'), render: (_, a) => a.employee ? `${a.employee.jobNumber} — ${a.employee.fullName}` : '—' },
          { title: t('roleAssignments'), render: (_, a) => a.isBreakGlass ? <Tag color="red">BREAK-GLASS</Tag> : a.roleAssignments.map((r) => <Tag key={`${r.role}${r.scopeType}`}>{r.role} · {r.scopeType}</Tag>) },
          { title: t('status'), render: (_, a) => <Tag color={a.isActive ? 'green' : 'default'}>{a.isActive ? t('active') : t('inactive')}</Tag> },
          { title: t('lastLogin'), render: (_, a) => a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : t('never') },
          {
            title: '', render: (_, a) => a.isBreakGlass || a.id === me?.id ? null : (
              <Popconfirm title={a.isActive ? t('deactivate') : t('activate')} onConfirm={() => toggle(a)}>
                <Button size="small" danger={a.isActive}>{a.isActive ? t('deactivate') : t('activate')}</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <Drawer title={t('newAccount')} open={open} onClose={() => setOpen(false)} size={480} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item name="email" label={t('email')} rules={[{ required: true, type: 'email' }]}><Input autoComplete="off" /></Form.Item>
          <Form.Item name="displayName" label={t('displayName')} rules={[{ required: true, max: 120 }]}><Input /></Form.Item>
          <Form.Item name="password" label={t('initialPassword')} extra={t('passwordRule')} rules={[{ required: true, min: 12, max: 72 }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="employeeId" label={t('employeeIdOptional')}><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Button type="primary" htmlType="submit" loading={create.isPending}>{t('create')}</Button>
        </Form>
      </Drawer>
    </>
  );
}
