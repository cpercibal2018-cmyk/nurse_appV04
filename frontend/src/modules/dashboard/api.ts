import { useQuery } from '@tanstack/react-query';
import { getHealth } from '../../services/http';

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: getHealth, refetchInterval: 30_000 });
}
