import { Badge, Card, Descriptions, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../hooks/useAuth';
import { useHealth } from './api';

// V03's dashboard figures came from the browser-side seed store. Real figures
// (staffing, eligibility, expiring credentials) are added with the modules that
// own them; until then the dashboard shows only facts the API can confirm.
export default function DashboardPage() {
  const { t } = useTranslation();
  const user = useAuth((s) => s.user);
  const health = useHealth();

  const apiBadge = health.isError
    ? <Badge status="error" text={t('unreachable')} />
    : <Badge status={health.data ? 'success' : 'processing'} text={health.data ? t('up') : '…'} />;
  const dbBadge = health.data
    ? <Badge status={health.data.database === 'up' ? 'success' : 'error'} text={t(health.data.database)} />
    : <Badge status="default" text="—" />;

  return (
    <Card title={t('dashboard')}>
      <Typography.Paragraph>{t('welcome')}{user ? `, ${user.displayName}` : ''}.</Typography.Paragraph>
      <Descriptions bordered size="small" column={1} style={{ maxWidth: 420 }}>
        <Descriptions.Item label={t('apiStatus')}>{apiBadge}</Descriptions.Item>
        <Descriptions.Item label={t('databaseStatus')}>{dbBadge}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
