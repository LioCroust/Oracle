import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';

const DEVICE_ID_KEY = 'oracle_device_id';
const DEVICE_ID_BACKUP_FILE = 'oracle_device_id.json';
const DEVICE_ID_LENGTH = 32;

function generateDeviceId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'dev_';
  for (let i = 0; i < DEVICE_ID_LENGTH; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

async function readBackup(): Promise<string | null> {
  try {
    const uri = FileSystem.documentDirectory + DEVICE_ID_BACKUP_FILE;
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(raw) as { deviceId?: string };
    return parsed.deviceId ?? null;
  } catch {
    return null;
  }
}

async function writeBackup(deviceId: string): Promise<void> {
  try {
    const uri = FileSystem.documentDirectory + DEVICE_ID_BACKUP_FILE;
    await FileSystem.writeAsStringAsync(uri, JSON.stringify({ deviceId }), {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    // Backup is best-effort.
  }
}

async function deleteBackup(): Promise<void> {
  try {
    const uri = FileSystem.documentDirectory + DEVICE_ID_BACKUP_FILE;
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri);
    }
  } catch {
    // Best-effort cleanup.
  }
}

export async function getOrCreateDeviceId(): Promise<string> {
  let deviceId: string | null = null;

  try {
    deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  } catch {
    // SecureStore may fail on some platforms; fall through to backup.
  }

  if (!deviceId) {
    deviceId = await readBackup();
  }

  if (!deviceId) {
    deviceId = generateDeviceId();
  }

  try {
    await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
  } catch {
    // SecureStore may fail; backup file is the fallback.
  }

  await writeBackup(deviceId);

  return deviceId;
}

export async function resetDeviceId(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(DEVICE_ID_KEY);
  } catch {
    // Best-effort cleanup.
  }
  await deleteBackup();
}
