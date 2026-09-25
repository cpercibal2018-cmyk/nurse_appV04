// My data (spec §8.3.3, PDPL; decision D-55): the employee asks to see,
// take away, correct or erase their personal data, follows the answer, and
// downloads the package once an access or portability request is approved.

import { useState } from 'react';
import { Alert, App, Button, Card, Flex, Form, Input, Modal, Select, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';
import type { DataSubjectRequest, DsrType } from '../../types/api';
import { DsrStatusTag, ErasureEvidence } from './DsrParts';

const TYPES: DsrType[] = ['ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE'];

export default function MyDataPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const mine = useQuery({ queryKey: ['pdpl', 'requests', 'me'], queryFn: () => http.get<{ items: DataSubjectRequest[] }>('/pdpl/requests/me') });
  const create = useMutation({
    mutationFn: (body: { type: DsrType; details?: string }) => http.post<DataSubjectRequest>('/pdpl/requests/me', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdpl', 'requests', 'me'] }),
  });
  const [asking, setAsking] = useState(false);
  const [form] = Form.useForm<{ type: DsrType; details?: string }>();
  const type = Form.useWatch('type', form);

  async function submit(v: { type: DsrType; details?: string }) {
    try {
      await create.mutateAsync({ type: v.type, details: v.details?.trim() || undefined });
      message.success(t('dsrSent'));
      setAsking(false);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  async function download(r: DataSubjectRequest) {
    try { await http.download(`/pdpl/requests/me/${r.id}/export`, 'personal-data.json'); } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <Flex vertical gap={16}>
      <Card title={t('myData')} extra={<Button type="primary" onClick={() => { form.resetFields(); setAsking(true); }}>{t('dsrNew')}</Button>}>
        <Alert type="info" showIcon title={t('myDataHint')} style={{ marginBottom: 12 }} />
        <Table<DataSubjectRequest>
          rowKey="id" size="small" loading={mine.isLoading} dataSource={mine.data?.items} pagination={false} scroll={{ x: true }}
          locale={{ emptyText: t('dsrNone') }}
          columns={[
            { title: t('dsrType'), render: (_, r) => t(`dsr_${r.type}`) },
            { title: t('requested'), render: (_, r) => new Date(r.requestedAt).toLocaleString() },
            { title: t('status'), render: (_, r) => <DsrStatusTag r={r} /> },
            {
              title: t('dsrAnswer'), render: (_, r) => (
                <Flex vertical gap={4}>
                  {r.decisionNote && <span>{r.decisionNote}</span>}
                  {r.erasure && <ErasureEvidence e={r.erasure} />}
                  {r.exportAvailable && (
                    <span>
                      <Button size="small" type="primary" onClick={() => void download(r)}>{t('dsrDownload')}</Button>{' '}
                      <Tag>{t('dsrAvailableUntil', { date: new Date(r.exportExpiresAt!).toLocaleDateString() })}</Tag>
                    </span>
                  )}
                </Flex>
              ),
            },
          ]}
        />
      </Card>
      <Modal open={asking} title={t('dsrNew')} onCancel={() => setAsking(false)} onOk={() => form.submit()} okText={t('submit')} cancelText={t('cancel')} confirmLoading={create.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ type: 'ACCESS' }}>
          <Form.Item name="type" label={t('dsrType')} rules={[{ required: true }]} extra={type ? t(`dsrHint_${type}`) : undefined}>
            <Select options={TYPES.map((v) => ({ value: v, label: t(`dsr_${v}`) }))} />
          </Form.Item>
          <Form.Item name="details" label={t('dsrDetails')}
            rules={[{ required: type === 'RECTIFICATION', min: type === 'RECTIFICATION' ? 10 : 0, max: 2000, message: t('dsrDetailsRequired') }]}>
            <Input.TextArea rows={3} placeholder={type === 'RECTIFICATION' ? t('dsrDetailsRectification') : undefined} />
          </Form.Item>
        </Form>
      </Modal>
    </Flex>
  );
}
