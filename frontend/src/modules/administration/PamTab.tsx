import { Alert, App, Button, Descriptions, Form, Input, InputNumber } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { describeApiError } from '../../lib/errors';
import { usePamActions, usePamStatus } from './api';

export function PamTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const status = usePamStatus();
  const { elevate, end } = usePamActions();
  const reload = useAuth((s) => s.reload);

  async function run(p: Promise<unknown>) {
    try {
      await p;
      await reload(); // navigation and permissions follow the new state
      message.success(t('saved'));
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  if (!status.data) return null;
  if (!status.data.eligible) return <Alert type="info" showIcon title={t('notSystemAdmin')} />;

  if (status.data.active && status.data.expiresAt) {
    return (
      <>
        <Descriptions bordered size="small" column={1} style={{ maxWidth: 480, marginBottom: 16 }}>
          <Descriptions.Item label={t('status')}>{t('elevatedUntil', { time: new Date(status.data.expiresAt).toLocaleTimeString() })}</Descriptions.Item>
        </Descriptions>
        <Button danger loading={end.isPending} onClick={() => run(end.mutateAsync())}>{t('endElevation')}</Button>
      </>
    );
  }

  return (
    <>
      <Alert type="warning" showIcon title={t('dormantHint')} style={{ marginBottom: 16, maxWidth: 640 }} />
      <Form layout="vertical" style={{ maxWidth: 480 }} initialValues={{ durationHours: 2 }}
        onFinish={(v: { reason: string; durationHours: number }) => run(elevate.mutateAsync(v))}>
        <Form.Item name="reason" label={t('reason')} rules={[{ required: true, min: 10, whitespace: true }]}>
          <Input.TextArea rows={2} maxLength={1000} />
        </Form.Item>
        <Form.Item name="durationHours" label={t('durationHours')} rules={[{ required: true }]}>
          <InputNumber min={1} max={4} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={elevate.isPending}>{t('elevate')}</Button>
      </Form>
    </>
  );
}
