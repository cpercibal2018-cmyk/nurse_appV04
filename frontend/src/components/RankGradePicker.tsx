// Rank/Grade selection (owner decision 2026-10-03): a form control that shows the
// chosen "N03 - Specialist Nurse" and opens a "Select Rank/Grade" window with the
// active records of the master — search by code, classification or meaning; click a
// row and Select, or double-click it. Cancel keeps the current choice. The value is
// the code. Used by Onboard/Edit employee and by the SCFHS licence's classification.

import { useMemo, useState } from 'react';
import { Button, Input, Modal, Space, Table, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useRankGrades, type RankGrade } from '../modules/workforce/api';

export function rankGradeLabel(code: string | null | undefined, name: string | null | undefined) {
  return code ? (name ? `${code} - ${name}` : code) : '';
}

export function RankGradePicker({ value, onChange, id, disabled }: { value?: string | null; onChange?: (code: string) => void; id?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  // All records, so a current value that has since been deactivated still shows its name.
  const all = useRankGrades(true);
  const current = all.data?.items.find((r) => r.code === value);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (all.data?.items ?? []).filter((r) => r.isActive)
      .filter((r) => !s || [r.code, r.name, r.meaning ?? ''].some((f) => f.toLowerCase().includes(s)));
  }, [all.data, q]);

  const choose = (r: RankGrade) => { onChange?.(r.code); setOpen(false); };
  const show = () => { setQ(''); setPicked(value ?? null); setOpen(true); };

  return (
    <>
      <Space.Compact style={{ width: '100%' }}>
        <Input id={id} readOnly value={value ? rankGradeLabel(value, current?.name) : ''} placeholder={t('rankGradeSelect')} onClick={disabled ? undefined : show}
          suffix={current && !current.isActive ? <Tag>{t('inactive')}</Tag> : undefined} style={{ cursor: disabled ? 'default' : 'pointer' }} disabled={disabled} />
        <Button icon={<SearchOutlined />} onClick={show} disabled={disabled} aria-label={t('rankGradeSelectTitle')} />
      </Space.Compact>
      <Modal title={t('rankGradeSelectTitle')} open={open} onCancel={() => setOpen(false)} width={760} destroyOnHidden
        footer={[
          <Button key="cancel" onClick={() => setOpen(false)}>{t('cancel')}</Button>,
          <Button key="select" type="primary" disabled={!rows.some((r) => r.code === picked)} onClick={() => { const r = rows.find((x) => x.code === picked); if (r) choose(r); }}>{t('select')}</Button>,
        ]}>
        <Input.Search allowClear autoFocus placeholder={t('rankGradeSearch')} value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12 }} />
        <Table<RankGrade> rowKey="code" size="small" pagination={false} loading={all.isLoading} dataSource={rows} scroll={{ y: 360 }}
          rowSelection={{ type: 'radio', selectedRowKeys: picked ? [picked] : [], onChange: (keys) => setPicked(String(keys[0])) }}
          onRow={(r) => ({ onClick: () => setPicked(r.code), onDoubleClick: () => choose(r), style: { cursor: 'pointer' } })}
          columns={[
            { title: t('code'), dataIndex: 'code', width: 90 },
            { title: t('rankGradeClassification'), dataIndex: 'name' },
            { title: t('rankGradeMeaning'), dataIndex: 'meaning', render: (m: string | null) => m ?? '—' },
          ]} />
      </Modal>
    </>
  );
}
