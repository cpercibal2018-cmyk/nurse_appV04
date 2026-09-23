import { Button, Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export default function NotFound() {
  const { t } = useTranslation();
  return <Result status="404" title={t('notFound')} extra={<Link to="/"><Button type="primary">{t('backHome')}</Button></Link>} />;
}
