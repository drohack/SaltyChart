export const seasons = ['Winter', 'Spring', 'Summer', 'Fall'] as const;

export type Season = (typeof seasons)[number];

export function getSeason(date: Date = new Date()): Season {
  const month = date.getMonth(); // 0-indexed
  if (month < 2) return 'Winter';
  if (month < 5) return 'Spring';
  if (month < 8) return 'Summer';
  return 'Fall';
}
