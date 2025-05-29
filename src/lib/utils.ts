export const seasons = ['winter', 'spring', 'summer', 'fall'] as const;
export type Season = (typeof seasons)[number];

export function currentSeason(): Season {
  const month = new Date().getMonth();
  if (month < 2) return 'winter';
  if (month < 5) return 'spring';
  if (month < 8) return 'summer';
  if (month < 11) return 'fall';
  return 'winter';
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
