import React, { createContext, useContext, useState, useCallback } from 'react';

interface AdminAccessContextValue {
  isAdminUnlocked: boolean;
  unlockAdmin: () => void;
  lockAdmin: () => void;
}

const AdminAccessContext = createContext<AdminAccessContextValue | null>(null);

const ADMIN_UNLOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function AdminAccessProvider({ children }: { children: React.ReactNode }) {
  const [isAdminUnlocked, setIsAdminUnlocked] = useState(false);
  const [unlockTimeout, setUnlockTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

  const lockAdmin = useCallback(() => {
    setIsAdminUnlocked(false);
    if (unlockTimeout) {
      clearTimeout(unlockTimeout);
      setUnlockTimeout(null);
    }
  }, [unlockTimeout]);

  const unlockAdmin = useCallback(() => {
    setIsAdminUnlocked(true);
    if (unlockTimeout) {
      clearTimeout(unlockTimeout);
    }
    const timeout = setTimeout(() => {
      setIsAdminUnlocked(false);
    }, ADMIN_UNLOCK_TIMEOUT_MS);
    setUnlockTimeout(timeout);
  }, [unlockTimeout]);

  return (
    <AdminAccessContext.Provider value={{ isAdminUnlocked, unlockAdmin, lockAdmin }}>
      {children}
    </AdminAccessContext.Provider>
  );
}

export function useAdminAccess() {
  const context = useContext(AdminAccessContext);
  if (!context) {
    throw new Error('useAdminAccess must be used within an AdminAccessProvider');
  }
  return context;
}
