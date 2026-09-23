import { Skeleton } from 'antd';

export function PageSkeleton() {
  return (
    <div style={{ padding: 24 }}>
      <Skeleton active paragraph={{ rows: 4 }} />
      <Skeleton active paragraph={{ rows: 4 }} style={{ marginTop: 24 }} />
    </div>
  );
}
