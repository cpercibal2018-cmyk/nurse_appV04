// The single list of application pages. Both the router and the navigation
// menu are built from it, so a page cannot be routed without appearing in the
// menu or vice versa. Each page is a lazily loaded chunk (route-level splitting).

import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import {
  AuditOutlined, BellOutlined, CheckCircleOutlined, ClockCircleOutlined, DashboardOutlined,
  FileProtectOutlined, FundOutlined, IdcardOutlined, SafetyCertificateOutlined, ScheduleOutlined,
  SettingOutlined, TeamOutlined, ApartmentOutlined,
} from '@ant-design/icons';
import type { TranslationKey } from '../lib/i18n';

export interface AppModule {
  path: string;
  labelKey: TranslationKey;
  icon: ReactNode;
  load: () => Promise<{ default: ComponentType }>;
  Page: LazyExoticComponent<ComponentType>;
}

function page(path: string, labelKey: TranslationKey, icon: ReactNode, load: AppModule['load']): AppModule {
  return { path, labelKey, icon, load, Page: lazy(load) };
}

export const MODULES: AppModule[] = [
  page('/', 'dashboard', <DashboardOutlined />, () => import('../modules/dashboard/DashboardPage')),
  page('/nurses', 'nurses', <TeamOutlined />, () => import('../modules/nurses/NursesPage')),
  page('/contracts', 'contracts', <FileProtectOutlined />, () => import('../modules/contracts/ContractsPage')),
  page('/credentials', 'credentials', <SafetyCertificateOutlined />, () => import('../modules/credentials/CredentialsPage')),
  page('/my-credentials', 'myCredentials', <IdcardOutlined />, () => import('../modules/credentials/MyCredentialsPage')),
  page('/eligibility', 'eligibility', <CheckCircleOutlined />, () => import('../modules/eligibility/EligibilityPage')),
  page('/workforce', 'workforce', <ApartmentOutlined />, () => import('../modules/workforce/WorkforcePage')),
  page('/kpi', 'kpi', <FundOutlined />, () => import('../modules/workforce/KpiPage')),
  page('/scheduling', 'scheduling', <ScheduleOutlined />, () => import('../modules/scheduling/SchedulingPage')),
  page('/attendance', 'attendance', <ClockCircleOutlined />, () => import('../modules/attendance/AttendancePage')),
  page('/notifications', 'notifications', <BellOutlined />, () => import('../modules/notifications/NotificationsPage')),
  page('/audit', 'audit', <AuditOutlined />, () => import('../modules/audit/AuditPage')),
  page('/admin', 'admin', <SettingOutlined />, () => import('../modules/administration/AdministrationPage')),
];
