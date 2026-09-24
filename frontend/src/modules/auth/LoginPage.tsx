import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Spin, Typography } from 'antd';
import { GlobalOutlined, LockOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { usePreferences } from '../../hooks/usePreferences';
import { ApiError, http } from '../../services/http';
import type { MfaPrompt, MfaSetup, TokenResponse } from '../../types/api';
import { AuthenticatorSetup } from './mfa/AuthenticatorSetup';
import { RecoveryCodes } from './mfa/RecoveryCodes';

type Step =
  | { kind: 'password' }
  | { kind: 'verify'; challenge: string; recovery: boolean }
  | { kind: 'enroll'; challenge: string; setup: MfaSetup | null }
  | { kind: 'codes'; tokens: TokenResponse; codes: string[]; account?: string };

// V03's login page accepted any password in demo mode, pre-filled credentials
// and listed security features that were not implemented. V04 shows a plain
// form and the server's answer — nothing else. Accounts with an authenticator
// (and every HR, supervisor and admin account) take a second step (spec §3.5).
export default function LoginPage() {
  const { t } = useTranslation();
  const login = useAuth((s) => s.login);
  const completeLogin = useAuth((s) => s.completeLogin);
  const { language, setLanguage } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  /** Runs one server call; a dead challenge sends the person back to the password. */
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'MFA_CHALLENGE_INVALID') setStep({ kind: 'password' });
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const finish = async (tokens: TokenResponse) => {
    await completeLogin(tokens);
    navigate(from, { replace: true });
  };

  function onPassword(values: { email: string; password: string }) {
    void run(async () => {
      const mfa = await login(values.email.trim(), values.password);
      if (!mfa) return navigate(from, { replace: true });
      if (mfa.step === 'VERIFY') return setStep({ kind: 'verify', challenge: mfa.challenge, recovery: false });
      setStep({ kind: 'enroll', challenge: mfa.challenge, setup: null });
      await startEnroll(mfa);
    });
  }

  async function startEnroll(mfa: MfaPrompt['mfa']) {
    const setup = await http.post<MfaSetup>('/auth/mfa/enroll/start', { challenge: mfa.challenge });
    setStep({ kind: 'enroll', challenge: mfa.challenge, setup });
  }

  const onVerify = (challenge: string) => (values: { code: string }) => void run(async () => {
    await finish(await http.post<TokenResponse>('/auth/mfa/verify', { challenge, code: values.code.trim() }));
  });

  const onEnrollConfirm = (challenge: string, account?: string) => (code: string) => void run(async () => {
    const out = await http.post<TokenResponse & { recoveryCodes: string[] }>('/auth/mfa/enroll/confirm', { challenge, code });
    setStep({ kind: 'codes', tokens: out, codes: out.recoveryCodes, account });
  });

  const back = () => { setError(null); setStep({ kind: 'password' }); };

  return (
    <div className="login-backdrop">
      <Card style={{ width: 440, maxWidth: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img src="/logo-light.jpg" alt={t('appName')} style={{ height: 88, objectFit: 'contain', maxWidth: '100%' }} />
        </div>
        {error && <Alert type="error" showIcon title={t('loginFailed')} description={error} style={{ marginBottom: 16 }} />}

        {step.kind === 'password' && (
          <Form layout="vertical" onFinish={onPassword} requiredMark={false}>
            <Form.Item name="email" label={t('email')} rules={[{ required: true, message: t('emailRequired') }]}>
              <Input prefix={<UserOutlined />} autoComplete="username" inputMode="email" />
            </Form.Item>
            <Form.Item name="password" label={t('password')} rules={[{ required: true, message: t('passwordRequired') }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={busy}>{t('login')}</Button>
            <div style={{ marginTop: 12, textAlign: 'center' }}><Link to="/reset-password">{t('forgotPassword')}</Link></div>
          </Form>
        )}

        {step.kind === 'verify' && (
          <Form key={String(step.recovery)} layout="vertical" onFinish={onVerify(step.challenge)} requiredMark={false}>
            <Typography.Title level={5}><SafetyOutlined /> {t('mfaTitle')}</Typography.Title>
            <Typography.Paragraph>{step.recovery ? t('mfaEnterRecovery') : t('mfaEnterCode')}</Typography.Paragraph>
            <Form.Item
              name="code"
              label={step.recovery ? t('mfaRecoveryCode') : t('mfaCode')}
              rules={[{ required: true, message: step.recovery ? t('mfaRecoveryCode') : t('mfaSixDigits') }, ...(step.recovery ? [] : [{ pattern: /^\s*\d{6}\s*$/, message: t('mfaSixDigits') }])]}
            >
              {step.recovery
                ? <Input autoComplete="off" autoFocus style={{ fontFamily: 'monospace' }} />
                : <Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} autoFocus />}
            </Form.Item>
            <Button type="primary" htmlType="submit" block size="large" loading={busy}>{t('mfaVerify')}</Button>
            <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
              <Button type="link" onClick={() => setStep({ ...step, recovery: !step.recovery })}>
                {step.recovery ? t('mfaUseAuthenticator') : t('mfaUseRecovery')}
              </Button>
              <Button type="link" onClick={back}>{t('back')}</Button>
            </div>
          </Form>
        )}

        {step.kind === 'enroll' && (
          <>
            <Typography.Title level={5}><SafetyOutlined /> {t('mfaSetupTitle')}</Typography.Title>
            <Alert type="info" showIcon title={t('mfaRequiredNotice')} style={{ marginBottom: 12 }} />
            {step.setup
              ? <AuthenticatorSetup setup={step.setup} busy={busy} onConfirm={onEnrollConfirm(step.challenge, step.setup.account)} onCancel={back} />
              : <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>}
          </>
        )}

        {step.kind === 'codes' && (
          <>
            <Typography.Title level={5}><SafetyOutlined /> {t('mfaEnabledTitle')}</Typography.Title>
            <RecoveryCodes codes={step.codes} account={step.account} onDone={() => void run(() => finish(step.tokens))} />
          </>
        )}

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>
            {language === 'en' ? 'العربية' : 'English'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
