// Application shell (ported from V03 app/src/components/AppLayout.tsx).
// Dropped from V03: the footer claiming "PDPL · KSA me-central-1" (me-central-1
// is the UAE, and the browser cannot know the server region), the unread badge
// fed by the browser store (returns with notifications, commit 9), and the
// DEVELOPER role display (decision D-5).

import { useState, type ReactNode } from 'react';
import { Avatar, Button, Dropdown, Flex, Layout, Menu, Tooltip } from 'antd';
import {
  BulbOutlined, GlobalOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MoonOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { MODULES } from '../app/modules';
import { useAuth } from '../hooks/useAuth';
import { usePreferences } from '../hooks/usePreferences';

// Plain spans instead of antd Typography in the shell: Typography bundles its
// editable/copyable features (Input, TextArea, clipboard) into the first load.
const { Header, Sider, Content } = Layout;

/** The menu key for a path is the module whose path is its longest prefix. */
function selectedKey(pathname: string): string {
  const match = MODULES.filter((m) => m.path === '/' ? pathname === '/' : pathname === m.path || pathname.startsWith(`${m.path}/`));
  return match[0]?.path ?? '';
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuth((s) => s.user);
  const roles = useAuth((s) => s.roles);
  const logout = useAuth((s) => s.logout);
  const { language, setLanguage, theme, setTheme } = usePreferences();
  const isRtl = language === 'ar';
  const sidebarWidth = collapsed ? 64 : 244;

  async function signOut() {
    await logout();
    queryClient.clear(); // no cached data survives into the next session
    navigate('/login', { replace: true });
  }

  const menuItems = MODULES.map((m) => ({
    key: m.path,
    icon: m.icon,
    // Preload the page's chunk on hover/focus so navigation feels instant.
    label: <Link to={m.path} onMouseEnter={() => void m.load()} onFocus={() => void m.load()}>{t(m.labelKey)}</Link>,
  }));

  const userMenu = {
    items: [
      { key: 'email', label: user?.email, disabled: true },
      ...roles.map((r, i) => ({ key: `role-${i}`, label: `${r.role} · ${r.scopeType}`, disabled: true })),
      { type: 'divider' as const },
      { key: 'logout', icon: <LogoutOutlined />, label: t('logout'), onClick: () => void signOut() },
    ],
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={244}
        collapsedWidth={64}
        breakpoint="lg"
        onBreakpoint={setCollapsed}
        className="app-sider"
        style={{ insetInlineStart: 0 }}
      >
        <div className="app-logo">
          <img
            src="/logo-dark.jpg"
            alt={t('appName')}
            style={collapsed ? { height: 36, width: 36, objectFit: 'cover', objectPosition: isRtl ? 'right' : 'left' } : { height: 44, maxWidth: '100%', objectFit: 'contain' }}
          />
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey(location.pathname)]} items={menuItems} className="app-menu" />
      </Sider>

      <Layout style={{ marginInlineStart: sidebarWidth, transition: 'margin 0.2s' }}>
        <Header className="app-header">
          <Flex align="center" gap={8}>
            <Button type="text" aria-label="Toggle menu" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
            <span className="app-title">{t('appName')}</span>
          </Flex>
          <Flex align="center" gap={4}>
            <Tooltip title={theme === 'dark' ? t('lightMode') : t('darkMode')}>
              <Button type="text" aria-label={theme === 'dark' ? t('lightMode') : t('darkMode')} icon={theme === 'dark' ? <BulbOutlined /> : <MoonOutlined />} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
            </Tooltip>
            <Button type="text" icon={<GlobalOutlined />} onClick={() => setLanguage(language === 'en' ? 'ar' : 'en')}>
              {language === 'en' ? 'ع' : 'EN'}
            </Button>
            <Dropdown menu={userMenu} placement={isRtl ? 'bottomLeft' : 'bottomRight'}>
              <Flex align="center" gap={8} style={{ cursor: 'pointer', marginInlineStart: 4 }}>
                <Avatar className="app-avatar">{user?.displayName[0]?.toUpperCase()}</Avatar>
                {!collapsed && <span className="app-user">{user?.displayName}</span>}
              </Flex>
            </Dropdown>
          </Flex>
        </Header>
        <Content style={{ margin: 20 }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
