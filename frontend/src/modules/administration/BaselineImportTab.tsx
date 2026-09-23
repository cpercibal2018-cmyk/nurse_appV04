// Hospital baseline import (P7): load a baseline file, preview every row,
// then request the import. A second hospital-wide administrator approves it in
// the Approvals tab; only then is it applied, in one transaction. The server
// validates everything again — this screen only shows what it reports.

import { useState } from 'react';
import { Alert, App, Button, Descriptions, Flex, Input, Table, Tag, Typography, Upload } from 'antd';
import { useTranslation } from 'react-i18next';
import { describeApiError } from '../../lib/errors';
import { useBaselinePreview, useBaselineRequest, type BaselineReport, type BaselineRow } from './api';

const STATUS_COLOR: Record<BaselineRow['status'], string> = { CREATE: 'green', UNCHANGED: 'default', CONFLICT: 'orange', REJECTED: 'red' };

export function BaselineImportTab() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const preview = useBaselinePreview();
  const submit = useBaselineRequest();
  const [file, setFile] = useState<{ name: string; content: unknown } | null>(null);
  const [report, setReport] = useState<BaselineReport | null>(null);
  const [reason, setReason] = useState('');

  async function load(f: File) {
    setReport(null);
    try {
      setFile({ name: f.name, content: JSON.parse(await f.text()) });
    } catch {
      message.error(t('baselineNotJson'));
      setFile(null);
    }
    return false; // never upload directly; the file is sent with preview/request
  }

  async function runPreview() {
    if (!file) return;
    try { setReport(await preview.mutateAsync(file.content)); } catch (e) { message.error(describeApiError(e)); }
  }

  async function runRequest() {
    if (!file) return;
    try {
      const out = await submit.mutateAsync({ file: file.content, reason });
      message.success(out.status === 'PENDING_APPROVAL' ? t('baselineRequested', { id: out.requestId }) : t('baselineApplied'));
      setReport(null); setFile(null); setReason('');
    } catch (e) { message.error(describeApiError(e)); }
  }

  const issues = report?.rows.filter((r) => r.status === 'CONFLICT' || r.status === 'REJECTED') ?? [];
  return (
    <Flex vertical gap={12}>
      <Alert type="info" showIcon title={t('baselineHint')} />
      <Flex gap={8} wrap align="center">
        <Upload accept="application/json,.json" maxCount={1} showUploadList={false} beforeUpload={load}>
          <Button>{t('baselineChooseFile')}</Button>
        </Upload>
        <Typography.Text type="secondary">{file?.name ?? t('baselineNoFile')}</Typography.Text>
        <Button type="primary" disabled={!file} loading={preview.isPending} onClick={runPreview}>{t('baselinePreview')}</Button>
      </Flex>

      {report && (
        <>
          <Descriptions size="small" bordered column={{ xs: 1, sm: 3 }} items={[
            { key: 'c', label: t('baselineCreate'), children: report.totals.CREATE },
            { key: 'u', label: t('baselineUnchanged'), children: report.totals.UNCHANGED },
            { key: 'x', label: t('baselineConflict'), children: report.totals.CONFLICT },
            { key: 'r', label: t('baselineRejected'), children: report.totals.REJECTED },
            { key: 'b', label: t('beds'), children: report.totals.beds },
            { key: 'f', label: t('fields'), children: report.totals.fields },
          ]} />
          <Table
            size="small" rowKey="section" pagination={false} scroll={{ x: true }}
            dataSource={Object.entries(report.counts).map(([section, c]) => ({ section, ...c }))}
            columns={[
              { title: t('baselineSection'), dataIndex: 'section', render: (s: string) => t(`baselineSection_${s}`) },
              ...(['CREATE', 'UNCHANGED', 'CONFLICT', 'REJECTED'] as const).map((k) => ({ title: <Tag color={STATUS_COLOR[k]}>{t(`baselineStatus_${k}`)}</Tag>, dataIndex: k })),
            ]}
          />
          {issues.length > 0 && (
            <Table<BaselineRow>
              size="small" rowKey={(r) => `${r.section}:${r.code}`} pagination={{ pageSize: 20 }} scroll={{ x: true }} dataSource={issues}
              columns={[
                { title: t('baselineSection'), dataIndex: 'section', render: (s: string) => t(`baselineSection_${s}`) },
                { title: t('code'), dataIndex: 'code' },
                { title: t('status'), dataIndex: 'status', render: (s: BaselineRow['status']) => <Tag color={STATUS_COLOR[s]}>{t(`baselineStatus_${s}`)}</Tag> },
                { title: t('baselineIssues'), dataIndex: 'issues', render: (i: string[]) => i.join('; ') },
              ]}
            />
          )}
          {report.canImport ? (
            <Flex vertical gap={8} style={{ maxWidth: 640 }}>
              <Input.TextArea rows={2} maxLength={1000} placeholder={t('baselineReason')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div><Button type="primary" disabled={reason.trim().length < 10} loading={submit.isPending} onClick={runRequest}>{t('baselineRequest')}</Button></div>
            </Flex>
          ) : (
            <Alert type="warning" showIcon title={report.totals.CREATE === 0 && issues.length === 0 ? t('baselineNothing') : t('baselineBlocked')} />
          )}
        </>
      )}
    </Flex>
  );
}
