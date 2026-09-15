export function randomInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function randomFloat(min, max) {
  return min + Math.random() * (max - min);
}

export function jitter(value, ratio = 0.15) {
  return value * (1 + randomFloat(-ratio, ratio));
}

export function chance(probability) {
  return Math.random() < probability;
}

export function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

export function gaussian(mean, sd, min, max) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const n = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  const value = mean + n * sd;
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepJitter(minMs, maxMs) {
  return sleep(randomInt(minMs, maxMs));
}
