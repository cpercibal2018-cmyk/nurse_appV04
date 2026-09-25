// Administration: accounts, role assignments, four-eyes approvals, PAM, jobs, the
// Dev Console SMS inbox (D-59) and simulated SCFHS registry (D-64) and badge simulator (D-65), FHIR API clients (D-63) and the spec §8.1 access matrix. Tabs follow what
// /auth/me says the user holds; the server still authorizes every call.

import { Card, Table, Tabs, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { usePermissions } from '../../hooks/usePermissions';
import { AccountsTab } from './AccountsTab';
import { ApiClientsTab } from './ApiClientsTab';
import { ApprovalsTab } from './ApprovalsTab';
import { BaselineImportTab } from './BaselineImportTab';
import { DataProtectionTab } from './DataProtectionTab';
import { EligibilityLogicTab } from './EligibilityLogicTab';
import { useMatrix } from './api';
import { PamTab } from './PamTab';
import { JobsTab } from './JobsTab';
import { RoleAssignmentsTab } from './RoleAssignmentsTab';
import { SmsInboxTab } from './SmsInboxTab';
import { ScfhsRegistryTab } from './ScfhsRegistryTab';
import { BadgeSimulatorTab } from './BadgeSimulatorTab';

function MatrixTab() {
  const { t } = useTranslation();
  const m = useMatrix();
  if (!m.data) return null;
  const { columns, rows, source } = m.data.matrix;
  return (
    <>
      <Table
        rowKey="area"
        pagination={false}
        scroll={{ x: true }}
        dataSource={rows}
        columns={[{ title: '', dataIndex: 'area' }, ...columns.map((c, i) => ({ title: c, render: (_: unknown, r: { cells: string[] }) => r.cells[i] }))]}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>{t('matrixSource', { source })}</Typography.Paragraph>
    </>
  );
}

export default function AdministrationPage() {
  const { t } = useTranslation();
  const { hasRole, holdsAssignment } = usePermissions();
  const admin = hasRole('HR_ADMIN', 'SYSTEM_ADMIN');

  const items = [
    ...(admin ? [
      { key: 'accounts', label: t('accounts'), children: <AccountsTab /> },
      { key: 'roles', label: t('roleAssignments'), children: <RoleAssignmentsTab /> },
      { key: 'approvals', label: t('approvals'), children: <ApprovalsTab /> },
      { key: 'baseline', label: t('baselineImport'), children: <BaselineImportTab /> },
      { key: 'dataProtection', label: t('dataProtection'), children: <DataProtectionTab /> },
      { key: 'eligibilityLogic', label: t('logicTab'), children: <EligibilityLogicTab /> },
    ] : []),
    ...(holdsAssignment('SYSTEM_ADMIN') ? [{ key: 'pam', label: t('privilegedAccess'), children: <PamTab /> }] : []),
    ...(holdsAssignment('SYSTEM_ADMIN') ? [{ key: 'jobs', label: t('backgroundJobs'), children: <JobsTab /> }] : []),
    ...(holdsAssignment('SYSTEM_ADMIN') ? [{ key: 'smsInbox', label: t('smsInbox'), children: <SmsInboxTab /> }] : []),
    ...(holdsAssignment('SYSTEM_ADMIN') ? [{ key: 'scfhsRegistry', label: t('scfhsRegistry'), children: <ScfhsRegistryTab /> }] : []),
    ...(holdsAssignment('SYSTEM_ADMIN') ? [{ key: 'badgeSimulator', label: t('badgeSimulator'), children: <BadgeSimulatorTab /> }] : []),
    ...(holdsAssignment('SYSTEM_ADMIN') ? [{ key: 'apiClients', label: t('apiClients'), children: <ApiClientsTab /> }] : []),
    { key: 'matrix', label: t('accessMatrix'), children: <MatrixTab /> },
  ];

  return (
    <Card title={t('admin')}>
      <Tabs items={items} destroyOnHidden />
    </Card>
  );
}
