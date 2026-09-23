import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function NotificationsPage() {
  return (
    <ModulePlaceholder
      titleKey="notifications"
      deliveredBy="Notifications and audit (commit 9)"
      planned={[
        "In-app notifications (expiring credentials and contracts, roster changes)",
      ]}
    />
  );
}
