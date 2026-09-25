// FHIR API clients (D-63, System Admin): the systems (HIS, payroll) that may call
// the FHIR API without a person signed in. Register one, replace its secret or
// revoke it; the secret is shown once, in a dialog, and never again.

import { useState } from 'react';
import { Alert, App, Button, Checkbox, Flex, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { API_PREFIX } from '../../services/http';
import { useApiClients, useCreateApiClient, useReplaceApiClientSecret, useRevokeApiClient, type ApiClient, type FhirScope } from './api';

const SCOPES: FhirScope[] = ['system/Practitioner.read', 'system/PractitionerRole.read', 'attendance.ingest'];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function ApiClientsTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const clients = useApiClients();
  const create = useCreateApiClient();
  const replace = useReplaceApiClientSecret();
  const revoke = useRevokeApiClient();
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<{ client: ApiClient; secret: string } | null>(null);
  const [form] = Form.useForm<{ name: string; scopes: FhirScope[] }>();
  const tokenUrl = `${window.location.origin}${API_PREFIX}/fhir/token`;

  async function run(p: Promise<{ client: ApiClient; clientSecret?: string }>, done: string) {
    try {
      const out = await p;
      if (out.clientSecret) setIssued({ client: out.client, secret: out.clientSecret });
      else message.success(done);
      return true;
    } catch (e) {
      message.error(describeApiError(e));
      return false;
    }
  }

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} title={t('apiClientsIntro')}
        description={<Typography.Text>{t('apiClientsTokenUrl')} <Typography.Text code copyable dir="ltr">{tokenUrl}</Typography.Text></Typography.Text>} />
      <Flex justify="end" style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => { form.resetFields(); setAdding(true); }}>{t('apiClientAdd')}</Button>
      </Flex>
      <Table<ApiClient>
        rowKey="id" size="small" loading={clients.isLoading} dataSource={clients.data?.items} scroll={{ x: 960 }} pagination={{ pageSize: 25, hideOnSinglePage: true }}
        columns={[
          { title: t('name'), width: 180, render: (_, r) => r.name },
          { title: t('apiClientId'), width: 240, render: (_, r) => <Typography.Text code copyable dir="ltr" style={{ whiteSpace: 'nowrap' }}>{r.clientId}</Typography.Text> },
          { title: t('apiClientScopes'), width: 230, render: (_, r) => <Space size={4} wrap>{r.scopes.map((s) => <Tag key={s}>{s.replace('system/', '').replace('.read', '')}</Tag>)}</Space> },
          { title: t('apiClientLastToken'), width: 170, render: (_, r) => when(r.lastTokenAt) },
          { title: t('status'), width: 150, render: (_, r) => (r.revokedAt
            ? <Tag color="red" title={`${when(r.revokedAt)} · ${r.revokedBy?.displayName ?? ''}`}>{t('apiClientRevoked')}</Tag>
            : <Tag color="green">{t('apiClientLive')}</Tag>) },
          {
            title: '', width: 230, render: (_, r) => (r.revokedAt ? null : (
              <Space size={4} wrap>
                <Popconfirm title={t('apiClientReplaceConfirm')} onConfirm={() => run(replace.mutateAsync(r.id), '')}>
                  <Button size="small">{t('apiClientReplaceSecret')}</Button>
                </Popconfirm>
                <Popconfirm title={t('apiClientRevokeConfirm')} okButtonProps={{ danger: true }} onConfirm={() => run(revoke.mutateAsync(r.id), t('apiClientRevokedDone'))}>
                  <Button size="small" danger>{t('apiClientRevoke')}</Button>
                </Popconfirm>
              </Space>
            )),
          },
        ]}
      />

      <Modal open={adding} title={t('apiClientAdd')} onCancel={() => setAdding(false)} onOk={() => form.submit()}
        okText={t('submit')} cancelText={t('cancel')} confirmLoading={create.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" initialValues={{ scopes: SCOPES.filter((s) => s !== 'attendance.ingest') }}
          onFinish={async (v) => { if (await run(create.mutateAsync(v), '')) setAdding(false); }}>
          <Form.Item name="name" label={t('name')} extra={t('apiClientNameHint')} rules={[{ required: true, whitespace: true, min: 2, max: 100, message: t('fieldRequired') }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item name="scopes" label={t('apiClientScopes')} rules={[{ required: true, type: 'array', min: 1, message: t('fieldRequired') }]}>
            <Checkbox.Group options={SCOPES.map((s) => ({ value: s, label: <span dir="ltr">{s}</span> }))} style={{ display: 'flex', flexDirection: 'column', gap: 4 }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal open={issued !== null} title={t('apiClientSecretTitle')} closable={false} maskClosable={false}
        footer={<Button type="primary" onClick={() => setIssued(null)}>{t('apiClientSecretSaved')}</Button>}>
        {issued && (
          <>
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={t('apiClientSecretOnce')} />
            <Typography.Paragraph>{t('apiClientId')}: <Typography.Text code copyable dir="ltr">{issued.client.clientId}</Typography.Text></Typography.Paragraph>
            <Typography.Paragraph>{t('apiClientSecret')}: <Typography.Text code copyable dir="ltr" style={{ wordBreak: 'break-all' }}>{issued.secret}</Typography.Text></Typography.Paragraph>
          </>
        )}
      </Modal>
    </>
  );
}
