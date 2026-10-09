// Entur interprets validity dates in Norwegian local time, so "today" must be the Oslo calendar date.
// toISOString() gives the UTC date, which is still yesterday between 00:00 and 01:00/02:00 in Oslo.
export const getOsloIsoDate = (date: Date = new Date()): string =>
  date.toLocaleDateString('sv-SE', { timeZone: 'Europe/Oslo' });
