// Two-factor sign-in for the signed-in account (spec §3.5): status, optional
// set-up (staff), new recovery codes, and turning it off where the role does
// not require it. A lost phone on a required role: HR resets it. Below it, the
// account's Telegram connection (D-66).

import { useState } from 'react';
import { Alert, App, Button, Card, Descriptions, Form, Input, Modal, Space, Tag } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';
import type { MfaSetup, MfaStatus } from '../../types/api';
import { AuthenticatorSetup } from './mfa/AuthenticatorSetup';
import { RecoveryCodes } from './mfa/RecoveryCodes';
import { TelegramCard } from './telegram/TelegramCard';

type Dialog = null | { kind: 'setup'; setup: MfaSetup } | { kind: 'codes'; codes: string[] } | { kind: 'regenerate' } | { kind: 'disable' };

export default function SecurityPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['auth', 'mfa'], queryFn: () => http.get<MfaStatus>('/auth/mfa') });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { message.error(describeApiError(e)); } finally { setBusy(false); }
  }
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth', 'mfa'] });

  const s = status.data;
  return (
    <>
    <Card title={t('twoFactor')} loading={status.isLoading}>
      {s && !s.available && <Alert type="info" showIcon title={t('mfaBreakGlass')} />}
      {s?.available && (
        <>
          <Descriptions column={1} bordered size="small" style={{ marginBottom: 16 }}>
            <Descriptions.Item label={t('status')}>
              <Tag color={s.enabled ? 'green' : 'default'}>{s.enabled ? t('mfaOn') : t('mfaOff')}</Tag>
              {s.required && <Tag color="blue">{t('mfaRequiredByRole')}</Tag>}
            </Descriptions.Item>
            {s.enabledAt && <Descriptions.Item label={t('mfaSince')}>{new Date(s.enabledAt).toLocaleString()}</Descriptions.Item>}
            {s.enabled && (
              <Descriptions.Item label={t('mfaRecoveryCodesLeft')}>
                <Tag color={s.recoveryCodesLeft <= 3 ? 'orange' : 'default'}>{s.recoveryCodesLeft}</Tag>
              </Descriptions.Item>
            )}
          </Descriptions>
          <Space wrap>
            {!s.enabled && (
              <Button type="primary" loading={busy} onClick={() => void act(async () => setDialog({ kind: 'setup', setup: await http.post<MfaSetup>('/auth/mfa/setup') }))}>
                {t('mfaTurnOn')}
              </Button>
            )}
            {s.enabled && <Button onClick={() => setDialog({ kind: 'regenerate' })}>{t('mfaNewCodes')}</Button>}
            {s.enabled && !s.required && <Button danger onClick={() => setDialog({ kind: 'disable' })}>{t('mfaTurnOff')}</Button>}
          </Space>
          {s.required && <Alert type="info" showIcon title={t('mfaLostPhone')} style={{ marginTop: 16 }} />}
        </>
      )}

      <Modal open={dialog !== null} footer={null} onCancel={() => { setDialog(null); void refresh(); }} destroyOnHidden
        title={dialog?.kind === 'disable' ? t('mfaTurnOff') : dialog?.kind === 'regenerate' ? t('mfaNewCodes') : t('twoFactor')}>
        {dialog?.kind === 'setup' && (
          <AuthenticatorSetup setup={dialog.setup} busy={busy} onConfirm={(code) => void act(async () => {
            const out = await http.post<{ recoveryCodes: string[] }>('/auth/mfa/setup/confirm', { code });
            setDialog({ kind: 'codes', codes: out.recoveryCodes });
          })} />
        )}
        {dialog?.kind === 'codes' && <RecoveryCodes codes={dialog.codes} doneLabel={t('done')} onDone={() => { setDialog(null); void refresh(); }} />}
        {(dialog?.kind === 'regenerate' || dialog?.kind === 'disable') && (
          <Form layout="vertical" requiredMark={false} onFinish={(v: { code: string }) => void act(async () => {
            if (dialog.kind === 'regenerate') {
              const out = await http.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { code: v.code.trim() });
              setDialog({ kind: 'codes', codes: out.recoveryCodes });
            } else {
              await http.post('/auth/mfa/disable', { code: v.code.trim() });
              message.success(t('saved'));
              setDialog(null);
              void refresh();
            }
          })}>
            <Alert type="info" showIcon title={dialog.kind === 'regenerate' ? t('mfaNewCodesHint') : t('mfaTurnOffHint')} style={{ marginBottom: 12 }} />
            <Form.Item name="code" label={t('mfaCode')} rules={[{ required: true }]}>
              <Input inputMode="numeric" autoComplete="one-time-code" autoFocus />
            </Form.Item>
            <Button type="primary" danger={dialog.kind === 'disable'} htmlType="submit" loading={busy} block>
              {dialog.kind === 'regenerate' ? t('mfaNewCodes') : t('mfaTurnOff')}
            </Button>
          </Form>
        )}
      </Modal>
    </Card>
    <TelegramCard />
    </>
  );
}
