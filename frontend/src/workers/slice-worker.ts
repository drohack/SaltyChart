/// <reference lib="webworker" />

self.onmessage = (ev: MessageEvent<{ count: number }>) => {
  const { count } = ev.data;
  const sliceAngle = count ? 360 / count : 0;

  const sliceData = Array.from({ length: count }, (_, i) => {
    const start = i * sliceAngle;
    const end = start + sliceAngle;
    const hue = (i * 360) / count;
    return { start, end, color: `hsl(${hue},80%,55%)` };
  });

  postMessage({ sliceAngle, sliceData });
};
