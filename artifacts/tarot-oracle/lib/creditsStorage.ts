import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { getOrCreateDeviceId } from '@/lib/deviceId';
import { claimCreditsBonus } from '@workspace/api-client-react';

let writeQueue: Promise<void> = Promise.resolve();

function runWrite<T>(fn: () => Promise<T>): Promise<T> {
  const task = writeQueue.then(() => fn());
  writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

export type CreditTransactionType =
  | 'bonus_initial'
  | 'usage_short'
  | 'usage_detail'
  | 'usage_follow_up_questions'
  | 'usage_follow_up_detail'
  | 'usage_follow_up_suggested_detail'
  | 'purchase_short'
  | 'purchase_intuition'
  | 'purchase_premium'
  | 'refund'
  | 'admin_adjustment';

export interface CreditTransaction {
  id: string;
  timestamp: number;
  type: CreditTransactionType;
  creditsDelta: number;
  balanceAfter: number;
  description: string;
  packId?: string;
  amount?: number; // montant en euros pour un achat
}

export interface CreditWallet {
  userId: string;
  balance: number;
  createdAt: number;
  initialBonusGranted: boolean;
}

interface CreditsData {
  wallet: CreditWallet;
  transactions: CreditTransaction[];
  welcomeBonusClaimSynced?: boolean;
}

const STORAGE_KEY = '@oracle/creditsData';
const BACKUP_FILE = 'oracle_credits_data.json';
const MAX_TRANSACTIONS = 500;
const INITIAL_BONUS = 150;
export const MAX_BALANCE = 2000;
const WELCOME_BONUS_SYNC_RETRY_MS = 30_000;
let lastWelcomeBonusSyncAttemptAt = 0;
let creditsDataLoadPromise: Promise<CreditsData> | null = null;
const PACKS: Record<
  string,
  { credits: number; amount: number; label: string; type: CreditTransactionType }
> = {
  discovery: {
    credits: 150,
    amount: 2.99,
    label: 'Pack Découverte',
    type: 'purchase_short',
  },
  intuition: {
    credits: 400,
    amount: 6.99,
    label: 'Pack Intuition',
    type: 'purchase_intuition',
  },
  premium: {
    credits: 1000,
    amount: 14.99,
    label: 'Pack Oracle Premium',
    type: 'purchase_premium',
  },
};

export function generateUserId(): string {
  return `usr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function writeBackupFile(data: CreditsData): Promise<void> {
  try {
    const uri = FileSystem.documentDirectory + BACKUP_FILE;
    await FileSystem.writeAsStringAsync(uri, JSON.stringify(data), {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    // Backup is best-effort; primary storage remains AsyncStorage.
  }
}

async function readBackupFile(): Promise<CreditsData | null> {
  try {
    const uri = FileSystem.documentDirectory + BACKUP_FILE;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(raw) as CreditsData;
    if (parsed && typeof parsed.wallet === 'object' && Array.isArray(parsed.transactions)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function deleteBackupFile(): Promise<void> {
  try {
    const uri = FileSystem.documentDirectory + BACKUP_FILE;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri);
    }
  } catch {
    // Best-effort cleanup.
  }
}

function createWalletData(bonusAmount: number): CreditsData {
  const now = Date.now();
  const wallet: CreditWallet = {
    userId: generateUserId(),
    balance: bonusAmount,
    createdAt: now,
    initialBonusGranted: bonusAmount > 0,
  };
  const transactions: CreditTransaction[] = [];
  if (bonusAmount > 0) {
    transactions.push({
      id: `tx_${now}_bonus`,
      timestamp: now,
      type: 'bonus_initial',
      creditsDelta: bonusAmount,
      balanceAfter: bonusAmount,
      description: 'Bonus de bienvenue de 150 crédits',
    });
  }
  return { wallet, transactions, welcomeBonusClaimSynced: false };
}

async function readStoredCreditsData(): Promise<CreditsData | null> {
  let data: CreditsData | null = null;

  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CreditsData;
      if (parsed && typeof parsed.wallet === 'object' && Array.isArray(parsed.transactions)) {
        data = parsed;
      }
    }
  } catch {
    // Fall through to backup file.
  }

  if (!data) {
    data = await readBackupFile();
  }

  if (!data) {
    return null;
  }

  return data;
}

async function loadCreditsData(): Promise<CreditsData> {
  let data = await readStoredCreditsData();

  if (!data) {
    // Create the local wallet first; the server decides whether this device is eligible.
    data = createWalletData(0);
    await saveCreditsData(data);
  }

  if (
    data.welcomeBonusClaimSynced !== true &&
    Date.now() - lastWelcomeBonusSyncAttemptAt >= WELCOME_BONUS_SYNC_RETRY_MS
  ) {
    lastWelcomeBonusSyncAttemptAt = Date.now();
    try {
      const deviceId = await getOrCreateDeviceId();
      const { newlyGranted } = await claimCreditsBonus({ deviceId });
      const alreadyHasWelcomeBonus =
        data.wallet.initialBonusGranted ||
        data.transactions.some((transaction) => transaction.type === 'bonus_initial');

      // Reconcile older wallets too, while avoiding a second local credit if the
      // welcome bonus is already present in their transaction history.
      if (newlyGranted && !alreadyHasWelcomeBonus) {
        const bonusAmount = Math.min(
          INITIAL_BONUS,
          Math.max(0, MAX_BALANCE - data.wallet.balance),
        );
        if (bonusAmount > 0) {
          const now = Date.now();
          const newBalance = data.wallet.balance + bonusAmount;
          data.wallet.balance = newBalance;
          data.wallet.initialBonusGranted = true;
          data.transactions = [
            {
              id: `tx_${now}_bonus`,
              timestamp: now,
              type: 'bonus_initial' as const,
              creditsDelta: bonusAmount,
              balanceAfter: newBalance,
              description: 'Bonus de bienvenue de 150 crédits',
            },
            ...data.transactions,
          ].slice(0, MAX_TRANSACTIONS);
        }
      }

      data.welcomeBonusClaimSynced = true;
      await saveCreditsData(data);
    } catch (err) {
      // Do not mint credits offline; retry the server's idempotent claim later.
      console.warn('Welcome bonus claim failed; will retry when the server is reachable', err);
    }
  }

  return data;
}

export async function getCreditsData(): Promise<CreditsData> {
  if (creditsDataLoadPromise) return creditsDataLoadPromise;

  const loading = loadCreditsData();
  creditsDataLoadPromise = loading;
  try {
    return await loading;
  } finally {
    if (creditsDataLoadPromise === loading) {
      creditsDataLoadPromise = null;
    }
  }
}

export async function saveCreditsData(data: CreditsData): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  await writeBackupFile(data);
}

export async function getWallet(): Promise<CreditWallet> {
  const { wallet } = await getCreditsData();
  return wallet;
}

export async function getBalance(): Promise<number> {
  const wallet = await getWallet();
  return wallet.balance;
}

export async function getTransactions(): Promise<CreditTransaction[]> {
  const { transactions } = await getCreditsData();
  return transactions;
}

export async function hasEnoughCredits(amount: number): Promise<boolean> {
  const balance = await getBalance();
  return balance >= amount;
}

export async function recordCreditTransaction(
  creditsDelta: number,
  type: CreditTransactionType,
  description: string,
  options?: { packId?: string; amount?: number },
): Promise<CreditTransaction> {
  return runWrite(async () => {
    const data = await getCreditsData();
    const newBalance = Math.max(0, Math.min(MAX_BALANCE, data.wallet.balance + creditsDelta));
    const transaction: CreditTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      type,
      creditsDelta,
      balanceAfter: newBalance,
      description,
      packId: options?.packId,
      amount: options?.amount,
    };

    data.wallet.balance = newBalance;
    data.transactions = [transaction, ...data.transactions].slice(0, MAX_TRANSACTIONS);

    await saveCreditsData(data);
    return transaction;
  });
}

export async function spendCredits(
  amount: number,
  type: 'usage_short' | 'usage_detail' | 'usage_follow_up_questions' | 'usage_follow_up_detail' | 'usage_follow_up_suggested_detail',
  description: string,
): Promise<boolean> {
  return runWrite(async () => {
    const data = await getCreditsData();
    if (data.wallet.balance < amount) {
      return false;
    }

    const newBalance = data.wallet.balance - amount;
    const transaction: CreditTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      type,
      creditsDelta: -amount,
      balanceAfter: newBalance,
      description,
    };

    data.wallet.balance = newBalance;
    data.transactions = [transaction, ...data.transactions].slice(0, MAX_TRANSACTIONS);
    await saveCreditsData(data);
    return true;
  });
}

export async function spendShortCredits(description = 'Réponse rapide'): Promise<boolean> {
  return spendCredits(CREDIT_COSTS.short, 'usage_short', description);
}

export async function spendDetailCredits(description = 'Réponse détaillée'): Promise<boolean> {
  return spendCredits(CREDIT_COSTS.detail, 'usage_detail', description);
}

export async function spendFollowUpQuestionsCredits(
  description = 'Questions de suivi suggérées',
): Promise<boolean> {
  return spendCredits(CREDIT_COSTS.followUpQuestions, 'usage_follow_up_questions', description);
}

export async function spendFollowUpDetailCredits(
  description = 'Réponse de suivi détaillée',
): Promise<boolean> {
  return spendCredits(CREDIT_COSTS.followUpDetail, 'usage_follow_up_detail', description);
}

export async function spendFollowUpSuggestedDetailCredits(
  description = 'Réponse de suivi suggérée',
): Promise<boolean> {
  return spendCredits(CREDIT_COSTS.followUpSuggestedDetail, 'usage_follow_up_suggested_detail', description);
}

export async function refundCredits(
  amount: number,
  description: string,
): Promise<void> {
  await recordCreditTransaction(amount, 'refund', description);
}

export async function purchaseCredits(packId: string): Promise<boolean> {
  const pack = PACKS[packId];
  if (!pack) return false;

  return runWrite(async () => {
    const data = await getCreditsData();
    if (data.wallet.balance + pack.credits > MAX_BALANCE) {
      // Le plafond de 2000 crédits interdit cet achat.
      return false;
    }

    // TODO: connecter Google Play Billing ici avant d'ajouter les crédits.
    // Pour l'instant l'achat est simulé et crédite immédiatement le portefeuille.
    const transaction: CreditTransaction = {
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      type: pack.type,
      creditsDelta: pack.credits,
      balanceAfter: data.wallet.balance + pack.credits,
      description: pack.label,
      packId,
      amount: pack.amount,
    };

    data.wallet.balance += pack.credits;
    data.transactions = [transaction, ...data.transactions].slice(0, MAX_TRANSACTIONS);
    await saveCreditsData(data);

    return true;
  });
}

export async function restorePurchases(): Promise<boolean> {
  // TODO: intégrer avec Google Play Billing pour restaurer les achats.
  // Pour l'instant rien n'est restauré car les achats sont simulés localement.
  return false;
}

export async function resetWallet(): Promise<void> {
  return runWrite(async () => {
    await AsyncStorage.removeItem(STORAGE_KEY);
    await deleteBackupFile();
  });
}

export function getPackInfo(packId: string) {
  return PACKS[packId] ?? null;
}

export function getAllPacks() {
  return Object.entries(PACKS).map(([id, info]) => ({ id, ...info }));
}

export const CREDIT_COSTS = {
  short: 25,
  detail: 50,
  followUpQuestions: 25,
  followUpDetail: 30,
  followUpSuggestedDetail: 25,
};
