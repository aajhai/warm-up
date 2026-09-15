const TIMEZONE = "Asia/Kolkata";

function partsOf(date, timeZone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: get("weekday"),
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

export function istNow(date = new Date()) {
  return partsOf(date);
}

export function fromIst(year, month, day, hour, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - 5.5 * 3600 * 1000);
}

export function addIstDays(base, days) {
  const p = typeof base === "object" && base.year ? base : partsOf(base);
  const utc = Date.UTC(p.year, p.month - 1, p.day + days, 12, 0, 0);
  return partsOf(new Date(utc));
}

export function isWeekendIst(date = new Date()) {
  const weekday = partsOf(date).weekday;
  return weekday === "Sat" || weekday === "Sun";
}

export { TIMEZONE };
