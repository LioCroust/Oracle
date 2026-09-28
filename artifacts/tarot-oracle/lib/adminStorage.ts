import {
  recordUsageEvent as apiRecordUsageEvent,
  getStats as apiGetStats,
  clearStats as apiClearStats,
  adminLogin as apiAdminLogin,
  setAuthTokenGetter,
  type StatsResponse,
  type UsageEventResponse,
  type UsageEventRequestResponseType,
} from '@workspace/api-client-react';

export type ResponseType =
  | 'short'
  | 'detail'
  | 'full'
  | 'follow_up_questions'
  | 'follow_up_detail';

export interface OracleUsageEvent {
  id: string;
  timestamp: number;
  date: string;
  question: string;
  responseType: ResponseType;
  creditsUsed: number;
  generationTimeMs: number;
}

export interface OracleStats extends StatsResponse {}

let adminToken: string | null = null;

setAuthTokenGetter(() => adminToken);

export function isAdminAuthenticated(): boolean {
  return adminToken !== null;
}

export function setAdminToken(token: string | null): void {
  adminToken = token;
}

export async function loginAdmin(password: string): Promise<boolean> {
  try {
    const { token } = await apiAdminLogin({ password });
    adminToken = token;
    return true;
  } catch (err) {
    console.warn('Admin login failed', err);
    adminToken = null;
    return false;
  }
}

export function logoutAdmin(): void {
  adminToken = null;
}

function mapUsageEvent(event: UsageEventResponse): OracleUsageEvent {
  return {
    id: event.id,
    timestamp: new Date(event.date).getTime(),
    date: event.date,
    question: event.question,
    responseType: event.responseType as ResponseType,
    creditsUsed: event.creditsUsed,
    generationTimeMs: event.generationTimeMs,
  };
}

export async function recordUsageEvent(
  event: Omit<OracleUsageEvent, 'id' | 'timestamp' | 'date'>,
): Promise<void> {
  try {
    await apiRecordUsageEvent({
      responseType: event.responseType as UsageEventRequestResponseType,
      question: event.question,
      creditsUsed: event.creditsUsed,
      generationTimeMs: event.generationTimeMs,
    });
  } catch (err) {
    console.warn('Failed to record usage event on server', err);
    throw err;
  }
}

export async function getStatsAndHistory(): Promise<{
  stats: OracleStats;
  history: OracleUsageEvent[];
}> {
  const { stats, history } = await apiGetStats();
  return { stats, history: history.map(mapUsageEvent) };
}

export async function getUsageEvents(): Promise<OracleUsageEvent[]> {
  const { history } = await apiGetStats();
  return history.map(mapUsageEvent);
}

export async function getStats(): Promise<OracleStats> {
  const { stats } = await apiGetStats();
  return stats;
}

export async function clearHistory(): Promise<void> {
  await apiClearStats();
}
