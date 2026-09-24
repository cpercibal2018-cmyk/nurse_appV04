// Recovery codes are shown once (spec §3.5): each signs in once when the phone
// is not at hand. The person copies or downloads them before continuing.

import { useState } from 'react';
import { Alert, Button, Checkbox, Flex, Typography } from 'antd';
import { CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';

export function RecoveryCodes({ codes, account, onDone, doneLabel }: { codes: string[]; account?: string; onDone: () => void; doneLabel?: string }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const text = `AIGH Nursing Workforce — ${t('mfaRecoveryCodes')}${account ? ` (${account})` : ''}\n\n${codes.join('\n')}\n`;

  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'aigh-recovery-codes.txt' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  return (
    <>
      <Alert type="warning" showIcon title={t('mfaRecoveryCodes')} description={t('mfaRecoveryCodesHint')} style={{ marginBottom: 12 }} />
      <div data-testid="recovery-codes" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, fontFamily: 'monospace', fontSize: 16, marginBottom: 12, direction: 'ltr' }}>
        {codes.map((c) => <div key={c}>{c}</div>)}
      </div>
      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard?.writeText(text)}>{t('copy')}</Button>
        <Button icon={<DownloadOutlined />} onClick={download}>{t('download')}</Button>
      </Flex>
      <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} style={{ marginBottom: 12 }}>{t('mfaCodesSaved')}</Checkbox>
      <Typography.Paragraph style={{ marginBottom: 0 }}>
        <Button type="primary" block disabled={!saved} onClick={onDone}>{doneLabel ?? t('continue')}</Button>
      </Typography.Paragraph>
    </>
  );
}
