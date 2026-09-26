// Dev Console — Telegram inbox (D-66, System Admin). While NOTIFICATION_DRIVER=mock
// the Telegram gateway keeps every outgoing message instead of sending it; this
// lists them newest first, sends a test message to show the flow, and simulates
// a message to the bot (e.g. "/start <token>" to link an account) without Telegram.

import { useState } from 'react';
import { Alert, App, Button, Flex, Form, Input, Modal, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useSendTestTelegram, useSimulateTelegram, useTelegramInbox, type MockTelegram } from './api';

const CHAT_ID = /^-?[1-9]\d{0,19}$/;
type Dialog = null | 'test' | 'simulate';

export function TelegramInboxTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const inbox = useTelegramInbox();
  const send = useSendTestTelegram();
  const simulate = useSimulateTelegram();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form] = Form.useForm<{ chatId: string; message: string }>();
  const mock = inbox.data?.driver !== 'telegram';

  async function submit(v: { chatId: string; message: string }) {
    try {
      if (dialog === 'simulate') {
        await simulate.mutateAsync({ chatId: v.chatId, text: v.message });
        message.success(t('telegramSimulateDone'));
      } else {
        await send.mutateAsync(v);
        message.success(mock ? t('telegramTestSaved') : t('telegramTestSent'));
      }
      setDialog(null);
    } catch (e) {
      message.error(describeApiError(e));
    }
  }
  const open = (d: Dialog) => { form.resetFields(); setDialog(d); };

  return (
    <>
      <Alert type={mock ? 'info' : 'warning'} showIcon style={{ marginBottom: 12 }}
        title={mock ? t('telegramInboxMock') : t('telegramInboxLive')} />
      <Flex justify="space-between" align="center" style={{ marginBottom: 12 }} wrap gap={8}>
        <Typography.Text type="secondary">{t('telegramInboxTotal', { count: inbox.data?.total ?? 0 })}</Typography.Text>
        <Flex gap={8} wrap>
          <Button onClick={() => inbox.refetch()} loading={inbox.isFetching}>{t('telegramRefresh')}</Button>
          {mock && <Button onClick={() => open('simulate')}>{t('telegramSimulate')}</Button>}
          <Button type="primary" onClick={() => open('test')}>{t('telegramSendTest')}</Button>
        </Flex>
      </Flex>
      <Table<MockTelegram>
        rowKey="id" size="small" loading={inbox.isLoading} dataSource={inbox.data?.items} scroll={{ x: 820 }} pagination={{ pageSize: 25, hideOnSinglePage: true }}
        columns={[
          { title: t('telegramReceivedAt'), width: 190, render: (_, r) => new Date(r.createdAt).toLocaleString() },
          { title: t('telegramChatId'), width: 160, render: (_, r) => <span dir="ltr">{r.chatId}</span> },
          { title: t('telegramMessage'), width: 360, render: (_, r) => <span style={{ whiteSpace: 'pre-wrap' }} dir="auto">{r.messageText}</span> },
          { title: t('status'), width: 120, render: (_, r) => <Tag color="blue">{r.status === 'intercepted' ? t('telegramIntercepted') : r.status}</Tag> },
        ]}
      />
      <Modal open={dialog !== null} title={dialog === 'simulate' ? t('telegramSimulate') : t('telegramSendTest')} onCancel={() => setDialog(null)} onOk={() => form.submit()}
        okText={t('submit')} cancelText={t('cancel')} confirmLoading={send.isPending || simulate.isPending} destroyOnHidden>
        {dialog === 'simulate' && <Alert type="info" showIcon title={t('telegramSimulateHint')} style={{ marginBottom: 12 }} />}
        <Form form={form} layout="vertical" onFinish={submit}>
          <Form.Item name="chatId" label={t('telegramChatId')} extra={dialog === 'test' ? t('telegramChatIdHint') : undefined}
            rules={[{ required: true, message: t('fieldRequired') }, { pattern: CHAT_ID, message: t('telegramChatIdInvalid') }]}>
            <Input dir="ltr" placeholder="123456789" />
          </Form.Item>
          <Form.Item name="message" label={dialog === 'simulate' ? t('telegramSimulateText') : t('telegramMessage')} rules={[{ required: true, whitespace: true, message: t('fieldRequired') }]}>
            {dialog === 'simulate'
              ? <Input dir="ltr" placeholder="/start …" />
              : <Input.TextArea rows={4} maxLength={4096} showCount />}
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
