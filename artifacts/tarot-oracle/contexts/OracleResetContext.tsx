import React, { createContext, useContext, useState, useCallback } from 'react';

interface OracleResetContextValue {
  resetKey: number;
  triggerReset: () => void;
}

const OracleResetContext = createContext<OracleResetContextValue | undefined>(undefined);

export function OracleResetProvider({ children }: { children: React.ReactNode }) {
  const [resetKey, setResetKey] = useState(0);
  const triggerReset = useCallback(() => setResetKey((k) => k + 1), []);
  return <OracleResetContext.Provider value={{ resetKey, triggerReset }}>{children}</OracleResetContext.Provider>;
}

export function useOracleReset() {
  const ctx = useContext(OracleResetContext);
  if (!ctx) throw new Error('useOracleReset must be used within OracleResetProvider');
  return ctx;
}
