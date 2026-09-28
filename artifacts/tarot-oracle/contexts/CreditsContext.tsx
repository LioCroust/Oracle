import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  getBalance,
  getTransactions,
  getWallet,
  spendCredits as storageSpendCredits,
  refundCredits as storageRefundCredits,
  purchaseCredits as storagePurchaseCredits,
  restorePurchases as storageRestorePurchases,
  getAllPacks,
  getPackInfo,
  type CreditTransaction,
  type CreditWallet,
  CREDIT_COSTS,
} from '@/lib/creditsStorage';

interface CreditsContextValue {
  wallet: CreditWallet | null;
  balance: number;
  transactions: CreditTransaction[];
  loading: boolean;
  refresh: () => Promise<void>;
  hasEnough: (amount: number) => boolean;
  canReadShort: boolean;
  canReadDetail: boolean;
  canAskFollowUpQuestions: boolean;
  canAskFollowUpDetail: boolean;
  canAskFollowUpSuggestedDetail: boolean;
  shortCost: number;
  detailCost: number;
  followUpQuestionsCost: number;
  followUpDetailCost: number;
  followUpSuggestedDetailCost: number;
  spendShort: (description?: string) => Promise<boolean>;
  spendDetail: (description?: string) => Promise<boolean>;
  spendFollowUpQuestions: (description?: string) => Promise<boolean>;
  spendFollowUpDetail: (description?: string) => Promise<boolean>;
  spendFollowUpSuggestedDetail: (description?: string) => Promise<boolean>;
  refund: (amount: number, description?: string) => Promise<void>;
  purchasePack: (packId: string) => Promise<boolean>;
  restorePurchases: () => Promise<boolean>;
  packs: ReturnType<typeof getAllPacks>;
}

const CreditsContext = createContext<CreditsContextValue | null>(null);

export function CreditsProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<CreditWallet | null>(null);
  const [transactions, setTransactions] = useState<CreditTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [nextWallet, nextTransactions] = await Promise.all([
        getWallet(),
        getTransactions(),
      ]);
      setWallet(nextWallet);
      setTransactions(nextTransactions);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, 800);
    return () => clearInterval(interval);
  }, [refresh]);

  const balance = wallet?.balance ?? 0;
  const hasEnough = useCallback(
    (amount: number) => balance >= amount,
    [balance],
  );

  const canReadShort = balance >= CREDIT_COSTS.short;
  const canReadDetail = balance >= CREDIT_COSTS.detail;
  const canAskFollowUpQuestions = balance >= CREDIT_COSTS.followUpQuestions;
  const canAskFollowUpDetail = balance >= CREDIT_COSTS.followUpDetail;
  const canAskFollowUpSuggestedDetail = balance >= CREDIT_COSTS.followUpSuggestedDetail;

  const spendShort = useCallback(
    async (description = 'Réponse rapide') => {
      const ok = await storageSpendCredits(CREDIT_COSTS.short, 'usage_short', description);
      await refresh();
      return ok;
    },
    [refresh],
  );

  const spendDetail = useCallback(
    async (description = 'Réponse détaillée') => {
      const ok = await storageSpendCredits(CREDIT_COSTS.detail, 'usage_detail', description);
      await refresh();
      return ok;
    },
    [refresh],
  );

  const spendFollowUpQuestions = useCallback(
    async (description = 'Questions de suivi suggérées') => {
      const ok = await storageSpendCredits(
        CREDIT_COSTS.followUpQuestions,
        'usage_follow_up_questions',
        description,
      );
      await refresh();
      return ok;
    },
    [refresh],
  );

  const spendFollowUpDetail = useCallback(
    async (description = 'Réponse de suivi détaillée') => {
      const ok = await storageSpendCredits(
        CREDIT_COSTS.followUpDetail,
        'usage_follow_up_detail',
        description,
      );
      await refresh();
      return ok;
    },
    [refresh],
  );

  const spendFollowUpSuggestedDetail = useCallback(
    async (description = 'Réponse de suivi suggérée') => {
      const ok = await storageSpendCredits(
        CREDIT_COSTS.followUpSuggestedDetail,
        'usage_follow_up_suggested_detail',
        description,
      );
      await refresh();
      return ok;
    },
    [refresh],
  );

  const refund = useCallback(
    async (amount: number, description = 'Remboursement') => {
      await storageRefundCredits(amount, description);
      await refresh();
    },
    [refresh],
  );

  const purchasePack = useCallback(
    async (packId: string) => {
      const ok = await storagePurchaseCredits(packId);
      await refresh();
      return ok;
    },
    [refresh],
  );

  const restorePurchases = useCallback(async () => {
    const ok = await storageRestorePurchases();
    await refresh();
    return ok;
  }, [refresh]);

  const value = useMemo(
    () => ({
      wallet,
      balance,
      transactions,
      loading,
      refresh,
      hasEnough,
      canReadShort,
      canReadDetail,
      canAskFollowUpQuestions,
      canAskFollowUpDetail,
      canAskFollowUpSuggestedDetail,
      shortCost: CREDIT_COSTS.short,
      detailCost: CREDIT_COSTS.detail,
      followUpQuestionsCost: CREDIT_COSTS.followUpQuestions,
      followUpDetailCost: CREDIT_COSTS.followUpDetail,
      followUpSuggestedDetailCost: CREDIT_COSTS.followUpSuggestedDetail,
      spendShort,
      spendDetail,
      spendFollowUpQuestions,
      spendFollowUpDetail,
      spendFollowUpSuggestedDetail,
      refund,
      purchasePack,
      restorePurchases,
      packs: getAllPacks(),
    }),
    [
      wallet,
      balance,
      transactions,
      loading,
      refresh,
      hasEnough,
      canReadShort,
      canReadDetail,
      canAskFollowUpQuestions,
      canAskFollowUpDetail,
      canAskFollowUpSuggestedDetail,
      spendShort,
      spendDetail,
      spendFollowUpQuestions,
      spendFollowUpDetail,
      spendFollowUpSuggestedDetail,
      refund,
      purchasePack,
      restorePurchases,
    ],
  );

  return <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>;
}

export function useCredits(): CreditsContextValue {
  const ctx = useContext(CreditsContext);
  if (!ctx) {
    throw new Error('useCredits must be used inside a CreditsProvider');
  }
  return ctx;
}

export { getPackInfo, CREDIT_COSTS };
