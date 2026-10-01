// A workflow as an image (SVG), in the page's light or dark colours, with its
// text version for screen readers and a download of the image itself.

import { useMemo } from 'react';
import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { usePreferences } from '../../hooks/usePreferences';
import { flowById } from './content';
import { DARK, flowToSvg, flowToText, layoutFlow, LIGHT } from './content/flowLayout';

export function FlowImage({ id }: { id: string }) {
  const { t } = useTranslation();
  const dark = usePreferences().theme === 'dark';
  const flow = flowById(id);
  const { src, text, width } = useMemo(() => {
    if (!flow) return { src: '', text: '', width: 0 };
    const layout = layoutFlow(flow);
    return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(flowToSvg(layout, dark ? DARK : LIGHT))}`, text: flowToText(flow), width: layout.width };
  }, [flow, dark]);
  if (!flow) return null;
  return (
    <figure style={{ margin: '12px 0 20px' }}>
      <img src={src} alt={text} title={flow.title} width={width} style={{ maxWidth: '100%', height: 'auto', display: 'block', marginInline: 'auto' }} />
      <figcaption style={{ marginTop: 6 }}>
        {flow.caption && <Typography.Paragraph type="secondary" style={{ marginBottom: 4, fontSize: 13 }}>{flow.caption}</Typography.Paragraph>}
        <Typography.Text style={{ fontSize: 12 }}>
          <a href={src} download={`${flow.id}.svg`}>{t('guidelinesDownloadImage')}</a>
        </Typography.Text>
        <details style={{ fontSize: 12, marginTop: 4 }}>
          <summary style={{ cursor: 'pointer' }}>{t('guidelinesTextVersion')}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0', fontFamily: 'inherit' }}>{text}</pre>
        </details>
      </figcaption>
    </figure>
  );
}
