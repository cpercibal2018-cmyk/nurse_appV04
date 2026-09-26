// Sign-in e-mail for the signed-in account (D-67). Never instant: the current
// password, then a link to the NEW address; until it is opened nothing
// changes, and a waiting change can be cancelled. The old address is warned.

import { useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Form, Input, Popconfirm, Space } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../../lib/errors';
import { ApiError, http } from '../../../services/http';
import type { EmailChangeStatus } from '../../../types/api';

interface FormValues { newEmail: string; currentPassword: string }

/** Server codes shown next to the field they concern, rather than in a banner. */
const FIELD_ERRORS: Record<string, keyof FormValues> = {
  EMAIL_IN_USE: 'newEmail',
  EMAIL_UNCHANGED: 'newEmail',
  CURRENT_PASSWORD_WRONG: 'currentPassword',
};

export function EmailCard() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<FormValues>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useQuery({ queryKey: ['me', 'email'], queryFn: () => http.get<EmailChangeStatus>('/me/email') });
  const s = status.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ['me', 'email'] });

  async function submit(v: FormValues) {
    setBusy(true);
    setError(null);
    try {
      await http.post('/me/email', { newEmail: v.newEmail.trim(), currentPassword: v.currentPassword });
      form.resetFields();
      setEditing(false);
      await refresh();
    } catch (e) {
      const field = e instanceof ApiError ? FIELD_ERRORS[e.code] : undefined;
      if (field) form.setFields([{ name: field, errors: [(e as ApiError).message] }]);
      else setError(describeApiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    try {
      await http.delete('/me/email');
      message.success(t('emailChangeCancelled'));
      await refresh();
    } catch (e) {
      message.error(describeApiError(e));
    }
  }

  if (s && !s.available) return null;
  return (
    <Card title={t('signInEmail')} loading={status.isLoading} style={{ marginTop: 16 }}>
      {s && (
        <>
          <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('currentEmail')}><span dir="ltr">{s.email}</span></Descriptions.Item>
          </Descriptions>
          {s.pending && (
            <Alert type="info" showIcon style={{ marginBottom: 16 }}
              title={t('emailChangePending', { email: s.pending.newEmail, time: new Date(s.pending.expiresAt).toLocaleTimeString() })}
              action={<Popconfirm title={t('emailChangeCancel')} onConfirm={() => void cancel()}><Button size="small">{t('emailChangeCancel')}</Button></Popconfirm>} />
          )}
          {!editing ? (
            <Button onClick={() => { setError(null); setEditing(true); }}>{t('changeEmail')}</Button>
          ) : (
            <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} style={{ maxWidth: 420 }}
              onValuesChange={() => setError(null)}>
              {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />}
              <Form.Item name="newEmail" label={t('newEmail')} rules={[{ required: true, message: t('fieldRequired') }, { type: 'email', message: t('emailInvalid') }]}
                normalize={(v: string) => v.trim()}>
                <Input dir="ltr" autoComplete="email" inputMode="email" autoFocus />
              </Form.Item>
              <Form.Item name="currentPassword" label={t('currentPassword')} rules={[{ required: true, message: t('fieldRequired') }]}>
                <Input.Password autoComplete="current-password" />
              </Form.Item>
              <Alert type="info" showIcon title={t('emailChangeHow')} style={{ marginBottom: 12 }} />
              <Space>
                <Button type="primary" htmlType="submit" loading={busy} disabled={busy}>{t('emailChangeSend')}</Button>
                <Button onClick={() => { setEditing(false); form.resetFields(); }} disabled={busy}>{t('cancel')}</Button>
              </Space>
            </Form>
          )}
        </>
      )}
    </Card>
  );
}
