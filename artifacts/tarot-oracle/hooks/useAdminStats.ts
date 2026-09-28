import { useEffect, useState, useCallback } from 'react';
import { getStatsAndHistory, type OracleStats, type OracleUsageEvent } from '@/lib/adminStorage';

export function useAdminStats() {
  const [stats, setStats] = useState<OracleStats | null>(null);
  const [history, setHistory] = useState<OracleUsageEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { stats: nextStats, history: nextHistory } = await getStatsAndHistory();
      setStats(nextStats);
      setHistory(nextHistory);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, history, loading, refresh };
}
