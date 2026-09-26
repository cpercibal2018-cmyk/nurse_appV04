// A Telegram deep link (D-66) as a QR code and a button: scanned on the phone,
// or opened on this device. Used on the Security page (own account) and by HR
// in Accounts (to show a nurse). Without a bot username (mock driver) it shows
// the /start text to send from the Dev Console simulator instead.

import { Alert, Button, Flex, QRCode, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { TelegramLinkOffer as Offer } from '../../../types/api';

export function TelegramLinkOffer({ offer }: { offer: Offer }) {
  const { t } = useTranslation();
  const expires = new Date(offer.expiresAt).toLocaleTimeString();
  if (!offer.url) {
    return (
      <Alert type="info" showIcon title={t('telegramNoBot')}
        description={<Typography.Text code copyable style={{ wordBreak: 'break-all' }}>{`/start ${offer.startParameter}`}</Typography.Text>} />
    );
  }
  return (
    <Flex vertical align="center" gap={12}>
      <Typography.Paragraph style={{ marginBottom: 0 }}>{t('telegramScan')}</Typography.Paragraph>
      <QRCode value={offer.url} size={200} bordered={false} errorLevel="M" aria-label={t('telegramQrLabel')} />
      <Button type="primary" href={offer.url} target="_blank" rel="noopener noreferrer">{t('telegramOpen')}</Button>
      <Typography.Text type="secondary">{t('telegramLinkExpires', { time: expires })}</Typography.Text>
    </Flex>
  );
}
