// Dev Console — badge simulator (D-65, System Admin). Until the badge system
// (PACS) delivers clock events, write them here to show the gap view and the
// coverage alerts: one swipe, or clock-ins for a unit's published shift with
// some nurses left out (they show as MISSING). Simulated events are marked as
// such and can be cleared. Off in production unless BADGE_SIMULATOR=on.

import { Alert, App, Button, Card, DatePicker, Flex, Form, Input, InputNumber, Popconfirm, Select, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useBadgeSimulation, useBadgeSimulator, useUnits, type SimulatedEvent } from './api';

const TYPES = ['CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END'] as const;
const SHIFTS = ['Morning', 'Evening', 'Night'] as const;

export function BadgeSimulatorTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const sim = useBadgeSimulator();
  const act = useBadgeSimulation();
  const units = useUnits();
  const [swipe] = Form.useForm<{ jobNumber: string; type: string }>();
  const [shift] = Form.useForm<{ unitId: number; date?: dayjs.Dayjs; shiftType: string; leaveOut: number }>();
  const on = sim.data?.enabled === true;

  async function run<T>(p: Promise<T>, ok: (r: T) => string) {
    try { message.success(ok(await p)); } catch (e) { message.error(describeApiError(e)); }
  }

  return (
    <>
      <Alert type={on ? 'info' : 'warning'} showIcon style={{ marginBottom: 12 }} title={on ? t('badgeSimOn') : t('badgeSimOff')} />
      <Flex gap={12} wrap style={{ marginBottom: 12 }}>
        <Card size="small" title={t('badgeSimSwipe')} style={{ flex: '1 1 320px' }}>
          <Form form={swipe} layout="vertical" disabled={!on} initialValues={{ type: 'CLOCK_IN' }}
            onFinish={(v) => run(act.mutateAsync({ kind: 'swipe', body: { jobNumber: v.jobNumber.trim(), type: v.type } }), () => t('badgeSimSwiped'))}>
            <Form.Item name="jobNumber" label={t('jobNumber')} rules={[{ required: true, whitespace: true }]}><Input maxLength={40} dir="ltr" /></Form.Item>
            <Form.Item name="type" label={t('badgeSimType')}><Select options={TYPES.map((x) => ({ value: x, label: t(`badgeType_${x}`) }))} /></Form.Item>
            <Button type="primary" htmlType="submit" loading={act.isPending}>{t('badgeSimSwipeNow')}</Button>
          </Form>
        </Card>
        <Card size="small" title={t('badgeSimShift')} style={{ flex: '1 1 420px' }}>
          <Form form={shift} layout="vertical" disabled={!on} initialValues={{ shiftType: 'Morning', leaveOut: 1, date: dayjs() }}
            onFinish={(v) => run(act.mutateAsync({ kind: 'shift', body: { unitId: v.unitId, date: v.date?.format('YYYY-MM-DD'), shiftType: v.shiftType, leaveOut: v.leaveOut ?? 0 } }),
              (r) => t('badgeSimShiftDone', { count: r.accepted ?? 0, already: r.alreadyIn ?? 0, left: r.leftOut?.join(', ') || '—' }))}>
            <Flex gap={8} wrap>
              <Form.Item name="unitId" label={t('unit')} rules={[{ required: true }]} style={{ minWidth: 200, flex: 1 }}>
                <Select showSearch optionFilterProp="label" options={units.data?.items.map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))} />
              </Form.Item>
              <Form.Item name="date" label={t('date')} rules={[{ required: true }]}><DatePicker allowClear={false} /></Form.Item>
              <Form.Item name="shiftType" label={t('shift')}><Select style={{ width: 130 }} options={SHIFTS.map((x) => ({ value: x, label: t(`shift_${x}`) }))} /></Form.Item>
              <Form.Item name="leaveOut" label={t('badgeSimLeaveOut')} tooltip={t('badgeSimLeaveOutHint')}><InputNumber min={0} max={500} precision={0} /></Form.Item>
            </Flex>
            <Button type="primary" htmlType="submit" loading={act.isPending}>{t('badgeSimClockIn')}</Button>
          </Form>
        </Card>
      </Flex>
      <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">{t('badgeSimTotal', { count: sim.data?.total ?? 0 })}</Typography.Text>
        <Popconfirm title={t('badgeSimClearConfirm')} okButtonProps={{ danger: true }} onConfirm={() => run(act.mutateAsync({ kind: 'clear' }), (r) => t('badgeSimCleared', { count: r.deleted ?? 0 }))}>
          <Button danger disabled={!sim.data?.total}>{t('badgeSimClear')}</Button>
        </Popconfirm>
      </Flex>
      <Table<SimulatedEvent>
        rowKey="id" size="small" loading={sim.isLoading} dataSource={sim.data?.recent} scroll={{ x: 640 }} pagination={{ pageSize: 25, hideOnSinglePage: true }}
        columns={[
          { title: t('badgeSimAt'), width: 190, render: (_, r) => new Date(r.eventTimestamp).toLocaleString() },
          { title: t('employee'), width: 260, render: (_, r) => `${r.employee.jobNumber} — ${r.employee.fullName}` },
          { title: t('badgeSimType'), width: 150, render: (_, r) => <Tag color={r.eventType === 'CLOCK_IN' ? 'green' : 'default'}>{t(`badgeType_${r.eventType}`)}</Tag> },
        ]}
      />
    </>
  );
}
