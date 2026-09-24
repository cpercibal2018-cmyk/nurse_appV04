import { useState } from 'react';
import { Alert, Button, Card, Form, Input } from 'antd';
import { GlobalOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { usePreferences } from '../../hooks/usePreferences';
import { ApiError } from '../../services/http';

// V03's login page accepted any password in demo mode, pre-filled credentials
// and listed security features that were not implemented. V04 shows a plain
// form and the server's answer — nothing else.
export default function LoginPage() {
  const { t } = useTranslation();
  const login = useAuth((s) => s.login);
  const { language, setLanguage } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/';

  async function onFinish(values: { email: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      await login(values.email.trim(), values.password);
      navigate(from, { replace: true });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-backdrop">
      <Card style={{ width: 420, maxWidth: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <img src="/logo-light.jpg" alt={t('appName')} style={{ height: 88, objectFit: 'contain', maxWidth: '100%' }} />
        </div>
        {error && <Alert type="error" showIcon title={t('loginFailed')} description={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="email" label={t('email')} rules={[{ required: true, message: t('emailRequired') }]}>
            <Input prefix={<UserOutlined />} autoComplete="username" inputMode="email" />
          </Form.Item>
          <Form.Item name="password" label={t('password')} rules={[{ required: true, message: t('passwordRequired') }]}>
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block size="large" loading={busy}>{t('login')}</Button>
          <div style={{ marginTop: 12, textAlign: 'center' }}><Link to="/reset-password">{t('forgotPassword')}</Link></div>
        </Form>
        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>
            {language === 'en' ? 'العربية' : 'English'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
