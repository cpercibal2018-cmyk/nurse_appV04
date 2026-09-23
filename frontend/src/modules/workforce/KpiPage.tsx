// Nurse-to-bed KPIs (decision D-11). The bands come from the server with the
// statement that their source (the MoH Ada'a card) is not in the repository.

import { useState } from 'react';
import { Alert, Card, Col, DatePicker, Empty, Flex, Row, Segmented, Statistic, Tag } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { SHIFTS, useKpi, type Band, type ShiftType } from './api';

const BAND_COLOR: Record<Band, string> = { Standard: 'green', Distress: 'gold', Failing: 'orange', Failed: 'red' };

export default function KpiPage() {
  const { t } = useTranslation();
  const [date, setDate] = useState(dayjs().format('YYYY-MM-DD'));
  const [shift, setShift] = useState<ShiftType>('Morning');
  const kpi = useKpi(date, shift);
  const band = (b: Band) => <Tag color={BAND_COLOR[b]}>{t(`band_${b}`)}</Tag>;

  return (
    <Card title={t('kpi')}>
      <Flex gap={12} wrap style={{ marginBottom: 16 }}>
        <DatePicker value={dayjs(date)} allowClear={false} onChange={(d) => d && setDate(d.format('YYYY-MM-DD'))} />
        <Segmented value={shift} onChange={(v) => setShift(v as ShiftType)} options={SHIFTS.map((s) => ({ value: s, label: t(`shift_${s}`) }))} />
      </Flex>
      <Alert type="warning" showIcon title={t('kpiSourceWarning')} description={kpi.data?.thresholdSource} style={{ marginBottom: 16 }} />
      <Alert type="info" showIcon title={t('kpiDefinition')} style={{ marginBottom: 16 }} />
      {!kpi.data ? <Card loading={kpi.isLoading}><Empty /></Card> : (
        <>
          <Card size="small" title={<>{t('kpiA')} {band(kpi.data.kpiA.band)}</>} extra={`${t('averageCode')}: ${kpi.data.kpiA.averageCode}`} style={{ marginBottom: 16 }}>
            <Row gutter={16}>
              {kpi.data.kpiA.areas.map((a) => (
                <Col key={a.area} xs={24} md={8}>
                  <Card size="small" title={<>{a.area} {band(a.band)}</>}>
                    <Statistic title={t('ratio')} value={a.ratioLabel} />
                    <div>{t('nursesOnDuty')}: {a.nurses} · {t('beds')}: {a.beds} · {t('code')}: {a.code}</div>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>
          <Card size="small" title={<>{t('kpiB')} {band(kpi.data.kpiB.band)}</>}>
            <Statistic title={t('ratio')} value={kpi.data.kpiB.ratioLabel} />
            <div>{t('nursesOnDuty')}: {kpi.data.kpiB.nurses} · {t('beds')}: {kpi.data.kpiB.beds}</div>
          </Card>
        </>
      )}
    </Card>
  );
}
