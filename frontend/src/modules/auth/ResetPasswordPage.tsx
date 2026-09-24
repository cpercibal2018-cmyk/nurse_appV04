import { useEffect, useState } from 'react';
import { Alert, Button, Card, Form, Input, Result } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { usePreferences } from '../../hooks/usePreferences';
import { describeApiError } from '../../lib/errors';
import { http } from '../../services/http';

/** The reset token arrives after "#" so it never reaches a server log (D-50). */
const tokenFromHash = () => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';

// Password reset (D-50): without a token, ask for a link; with one, set the new password.
export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const { language, setLanguage } = usePreferences();
  const [token, setToken] = useState(tokenFromHash);
  const [state, setState] = useState<'form' | 'requested' | 'done'>('form');
  // Opening the e-mailed link in a tab already on this page changes only the "#" part: no reload.
  useEffect(() => {
    const onHash = () => { setToken(tokenFromHash()); setState('form'); setError(null); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function attempt(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(describeApiError(e)); } finally { setBusy(false); }
  }

  return (
    <div className="login-backdrop">
      <Card style={{ width: 440, maxWidth: '100%' }} title={token ? t('resetChooseTitle') : t('resetRequestTitle')}>
        {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
        {state === 'requested' ? (
          <Result status="info" title={t('resetRequested')} subTitle={t('resetRequestedHint')} extra={<Link to="/login"><Button>{t('backToLogin')}</Button></Link>} />
        ) : state === 'done' ? (
          <Result status="success" title={t('resetDone')} extra={<Link to="/login"><Button type="primary">{t('login')}</Button></Link>} />
        ) : !token ? (
          <Form layout="vertical" requiredMark={false} onFinish={(v: { email: string }) => attempt(async () => {
            await http.post('/auth/password-reset/request', { email: v.email.trim() });
            setState('requested');
          })}>
            <p>{t('resetRequestIntro')}</p>
            <Form.Item name="email" label={t('email')} rules={[{ required: true, type: 'email' }]}><Input autoComplete="username" inputMode="email" /></Form.Item>
            <Button type="primary" htmlType="submit" block loading={busy}>{t('resetSendLink')}</Button>
            <div style={{ marginTop: 12 }}><Link to="/login">{t('backToLogin')}</Link></div>
          </Form>
        ) : (
          <Form layout="vertical" requiredMark={false} onFinish={(v: { password: string }) => attempt(async () => {
            await http.post('/auth/password-reset/complete', { token, password: v.password });
            setState('done');
          })}>
            <Form.Item name="password" label={t('newPassword')} rules={[{ required: true, min: 12, max: 72, message: t('passwordLength') }]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item name="confirm" label={t('confirmPassword')} dependencies={['password']} rules={[{ required: true }, ({ getFieldValue }) => ({
              validator: (_, value) => (value === getFieldValue('password') ? Promise.resolve() : Promise.reject(new Error(t('passwordsDiffer')))),
            })]}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <p style={{ color: 'var(--ant-color-text-secondary)' }}>{t('resetSignsOut')}</p>
            <Button type="primary" htmlType="submit" block loading={busy}>{t('resetSave')}</Button>
          </Form>
        )}
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>{language === 'en' ? 'العربية' : 'English'}</Button>
        </div>
      </Card>
    </div>
  );
}
