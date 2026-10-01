// The small "?" beside a page title that opens the matching Guidelines section.
// It imports none of the guide's content, so pages that use it stay small.

import { Button, Tooltip } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

export function guideLink(section: string, task?: string) {
  return `/guidelines?s=${encodeURIComponent(section)}${task ? `&t=${encodeURIComponent(task)}` : ''}`;
}

export function GuideHelp({ section, task }: { section: string; task?: string }) {
  const { t } = useTranslation();
  return (
    <Tooltip title={t('guidelinesHelp')}>
      <Link to={guideLink(section, task)} aria-label={t('guidelinesHelp')}>
        <Button size="small" type="text" shape="circle" icon={<QuestionCircleOutlined />} tabIndex={-1} />
      </Link>
    </Tooltip>
  );
}
