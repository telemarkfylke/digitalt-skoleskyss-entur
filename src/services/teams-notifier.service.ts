import { appLogger } from './logger.service';

export const sendTeamsNotification = async (title: string, details: string): Promise<void> => {
  const webhookUrl = process.env.TEAMS_WEBHOOK_URL || '';

  if (!webhookUrl) {
    appLogger.warn('TEAMS_WEBHOOK_URL not configured. Skipping Teams notification.');
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `**${title}**\n\n${details}`
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Teams webhook failed (${response.status}): ${body}`);
    }
  } catch (error) {
    appLogger.error('Failed sending Teams notification: {ErrorMessage}', error instanceof Error ? error.message : String(error));
  }
};
