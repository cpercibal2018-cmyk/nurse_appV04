// Setting up an authenticator app (spec §3.5): scan the QR code, or type the
// key, then confirm with the first 6-digit code. Used at sign-in (required
// roles) and on the Two-factor sign-in page.

import { useState } from 'react';
import { Alert, Button, Flex, Form, Input, QRCode, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { MfaSetup } from '../../../types/api';

/** The key in groups of four, as authenticator apps show it. */
const grouped = (secret: string) => secret.replace(/(.{4})/g, '$1 ').trim();

export function AuthenticatorSetup({ setup, busy, onConfirm, onCancel }: {
  setup: MfaSetup;
  busy: boolean;
  onConfirm: (code: string) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);
  return (
    <>
      <Typography.Paragraph>{t('mfaSetupIntro')}</Typography.Paragraph>
      <Flex justify="center" style={{ marginBottom: 12 }}>
        <QRCode value={setup.otpauthUri} size={200} bordered={false} errorLevel="M" aria-label={t('mfaQrLabel')} />
      </Flex>
      {showKey ? (
        <Alert
          type="info"
          style={{ marginBottom: 12 }}
          title={t('mfaManualKey')}
          description={<Typography.Text code copyable={{ text: setup.secret }} data-testid="mfa-secret">{grouped(setup.secret)}</Typography.Text>}
        />
      ) : (
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <Button type="link" onClick={() => setShowKey(true)}>{t('mfaCantScan')}</Button>
        </div>
      )}
      <Form layout="vertical" requiredMark={false} onFinish={(v: { code: string }) => onConfirm(v.code.trim())}>
        <Form.Item name="code" label={t('mfaEnterFirstCode')} rules={[{ required: true, pattern: /^\s*\d{6}\s*$/, message: t('mfaSixDigits') }]}>
          <Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} autoFocus />
        </Form.Item>
        <Flex gap={8}>
          <Button type="primary" htmlType="submit" loading={busy} block>{t('mfaConfirm')}</Button>
          {onCancel && <Button onClick={onCancel}>{t('cancel')}</Button>}
        </Flex>
      </Form>
    </>
  );
}
