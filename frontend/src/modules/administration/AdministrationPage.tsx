import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function AdministrationPage() {
  return (
    <ModulePlaceholder
      titleKey="admin"
      deliveredBy="Authentication and RBAC (commit 5)"
      planned={[
        "User accounts",
        "Scoped role assignments (system, department, unit)",
        "Four-eyes approvals",
        "Privileged access (PAM) and break-glass",
      ]}
    />
  );
}
