import { logger } from '@vestfoldfylke/loglady';

export const appLogger = logger;

export async function flushLogs(): Promise<void> {
  await appLogger.flush();
}
