export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay = 300
): (...args: Parameters<T>) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
