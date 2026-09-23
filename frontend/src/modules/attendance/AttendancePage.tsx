import { ModulePlaceholder } from '../../components/ModulePlaceholder';

export default function AttendancePage() {
  return (
    <ModulePlaceholder
      titleKey="attendance"
      deliveredBy="Scheduling and attendance (commit 8)"
      planned={[
        "Attendance events",
        "Gaps between the published roster and attendance",
      ]}
    />
  );
}
