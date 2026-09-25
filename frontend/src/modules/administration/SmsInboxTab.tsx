// Dev Console — SMS inbox (D-59, System Admin). Until the hospital has a CST-registered
// Sender ID, the mock SMS gateway keeps every outgoing text instead of sending it;
// this lists them newest first, and sends a test text to show the flow.

import { useState } from 'react';
import { Alert, App, Button, Flex, Form, Input, Modal, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { phoneRule } from '../../lib/phone';
import { useSendTestSms, useSmsInbox, type MockSms } from './api';

export function SmsInboxTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const inbox = useSmsInbox();
  const send = useSendTestSms();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ phone: string; message: string }>();
  const mock = inbox.data?.driver !== 'unifonic';

  async function submit(v: { phone: string; message: string }) {
    try {
      await send.mutateAsync(v);
      message.success(mock ? t('smsTestSaved') : t('smsTestSent'));
      setOpen(false);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  return (
    <>
      <Alert type={mock ? 'info' : 'warning'} showIcon style={{ marginBottom: 12 }}
        title={mock ? t('smsInboxMock') : t('smsInboxLive')} />
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }} wrap gap={8}>
        <Typography.Text type="secondary">{t('smsInboxTotal', { count: inbox.data?.total ?? 0 })}</Typography.Text>
        <Flex gap={8}>
          <Button onClick={() => inbox.refetch()} loading={inbox.isFetching}>{t('smsRefresh')}</Button>
          <Button type="primary" onClick={() => { form.resetFields(); setOpen(true); }}>{t('smsSendTest')}</Button>
        </Flex>
      </Flex>
      <Table<MockSms>
        rowKey="id" size="small" loading={inbox.isLoading} dataSource={inbox.data?.items} scroll={{ x: 820 }} pagination={{ pageSize: 25, hideOnSinglePage: true }}
        columns={[
          { title: t('smsReceivedAt'), width: 190, render: (_, r) => new Date(r.createdAt).toLocaleString() },
          { title: t('smsRecipient'), width: 160, render: (_, r) => <span dir="ltr">{r.recipientPhone}</span> },
          { title: t('smsMessage'), width: 360, render: (_, r) => <span style={{ whiteSpace: 'pre-wrap' }} dir="auto">{r.messageBody}</span> },
          { title: t('status'), width: 120, render: (_, r) => <Tag color="blue">{r.status === 'intercepted' ? t('smsIntercepted') : r.status}</Tag> },
        ]}
      />
      <Modal open={open} title={t('smsSendTest')} onCancel={() => setOpen(false)} onOk={() => form.submit()}
        okText={t('submit')} cancelText={t('cancel')} confirmLoading={send.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item name="phone" label={t('smsRecipient')} rules={[{ required: true, message: t('fieldRequired') }, phoneRule(t('phoneInvalid'))]}>
            <Input dir="ltr" placeholder="+966501234567" />
          </Form.Item>
          <Form.Item name="message" label={t('smsMessage')} rules={[{ required: true, whitespace: true, message: t('fieldRequired') }]}>
            <Input.TextArea rows={4} maxLength={1600} showCount />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
