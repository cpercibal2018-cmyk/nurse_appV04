// English/Arabic UI strings with RTL (carried over from V03 app/src/lib/i18n.tsx;
// Observability keys dropped with that page, new-page keys added).

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { usePreferences, type Language } from '../hooks/usePreferences';

const en = {
  appName: 'AIGH Nursing Workforce',
  dashboard: 'Dashboard',
  nurses: 'Nurses',
  contracts: 'Contracts',
  credentials: 'Credentials',
  myCredentials: 'My Credentials',
  eligibility: 'Eligibility',
  workforce: 'Workforce',
  kpi: 'Nursing KPIs',
  scheduling: 'Roster & Scheduling',
  attendance: 'Attendance',
  notifications: 'Notifications',
  audit: 'Audit & Compliance',
  admin: 'Administration',
  login: 'Sign in',
  logout: 'Sign out',
  email: 'Email',
  password: 'Password',
  emailRequired: 'Enter your email',
  passwordRequired: 'Enter your password',
  loginFailed: 'Sign-in failed',
  lightMode: 'Light mode',
  darkMode: 'Dark mode',
  notFound: 'Page not found',
  backHome: 'Back to dashboard',
  notYetAvailable: 'Not yet available in V04',
  planned: 'Planned for this page',
  apiStatus: 'API status',
  databaseStatus: 'Database',
  up: 'Up',
  down: 'Down',
  unreachable: 'Unreachable',
  welcome: 'Welcome to the AIGH Nursing Workforce Management System',
};

const ar: Record<keyof typeof en, string> = {
  appName: 'نظام إدارة القوى العاملة التمريضية',
  dashboard: 'لوحة التحكم',
  nurses: 'الممرضون',
  contracts: 'العقود',
  credentials: 'الشهادات',
  myCredentials: 'شهاداتي',
  eligibility: 'الأهلية',
  workforce: 'القوى العاملة',
  kpi: 'مؤشرات أداء التمريض',
  scheduling: 'الجداول والمناوبات',
  attendance: 'الحضور',
  notifications: 'الإشعارات',
  audit: 'التدقيق والامتثال',
  admin: 'الإدارة',
  login: 'تسجيل الدخول',
  logout: 'تسجيل الخروج',
  email: 'البريد الإلكتروني',
  password: 'كلمة المرور',
  emailRequired: 'أدخل بريدك الإلكتروني',
  passwordRequired: 'أدخل كلمة المرور',
  loginFailed: 'تعذر تسجيل الدخول',
  lightMode: 'الوضع الفاتح',
  darkMode: 'الوضع الداكن',
  notFound: 'الصفحة غير موجودة',
  backHome: 'العودة إلى لوحة التحكم',
  notYetAvailable: 'غير متاح بعد في الإصدار الرابع',
  planned: 'المخطط لهذه الصفحة',
  apiStatus: 'حالة الخادم',
  databaseStatus: 'قاعدة البيانات',
  up: 'يعمل',
  down: 'متوقف',
  unreachable: 'تعذر الاتصال',
  welcome: 'مرحباً بكم في نظام إدارة القوى العاملة التمريضية AIGH',
};

export type TranslationKey = keyof typeof en;

function applyDirection(lang: Language) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ar: { translation: ar } },
  lng: usePreferences.getState().language,
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes
});
applyDirection(usePreferences.getState().language);

// Language is owned by the preferences store; i18n and <html dir> follow it.
usePreferences.subscribe((s, prev) => {
  if (s.language === prev.language) return;
  void i18n.changeLanguage(s.language);
  applyDirection(s.language);
});

export default i18n;
