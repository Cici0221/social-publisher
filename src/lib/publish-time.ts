export const publishZones = {
  "Asia/Shanghai": "北京",
  "Asia/Tokyo": "东京",
  "Asia/Ho_Chi_Minh": "河内",
} as const;

export type PublishZone = keyof typeof publishZones;
export const defaultPublishZone: PublishZone = "Asia/Shanghai";

export function normalizePublishZone(value: unknown): PublishZone {
  return typeof value === "string" && Object.hasOwn(publishZones, value) ? value as PublishZone : defaultPublishZone;
}

const localFormatters = new Map<PublishZone, Intl.DateTimeFormat>();
const displayFormatters = new Map<PublishZone, Intl.DateTimeFormat>();

function formatLocal(zone: PublishZone) {
  let formatter = localFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    localFormatters.set(zone, formatter);
  }
  return formatter;
}

function localParts(date: Date, zone: PublishZone) {
  const parts = formatLocal(zone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return { date: `${value("year").padStart(4, "0")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}:${value("second")}` };
}

export function parsePublishDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return null;
  const date = new Date(value + "T00:00:00.000Z");
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function localPublishTimeToDate(value: string, zone: PublishZone): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!match || !parsePublishDate(match[1])) return null;
  const [, date, hour, minute, second = "00", fraction = ""] = match;
  const target = Date.parse(`${date}T${hour}:${minute}:${second}Z`);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const shown = localParts(new Date(guess), zone);
    const adjustment = target - Date.parse(`${shown.date}T${shown.time}Z`);
    if (adjustment === 0) return new Date(guess + Number(fraction.padEnd(3, "0")));
    if (!Number.isFinite(adjustment)) return null;
    guess += adjustment;
  }
  // An unsupported or skipped local wall-clock time cannot be scheduled.
  return null;
}

export function dateInPublishZone(date: Date, zone: PublishZone): string {
  return localParts(date, zone).date;
}

export function publishTimeInput(date: Date, zone: PublishZone): string {
  const local = localParts(date, zone);
  return `${local.date}T${local.time.slice(0, 5)}`;
}

export function publishClockTime(date: Date, zone: PublishZone): string {
  return localParts(date, zone).time.slice(0, 5);
}

export function formatPublishTime(date: Date, zone: PublishZone = defaultPublishZone): string {
  let formatter = displayFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("zh-CN", { timeZone: zone, dateStyle: "medium", timeStyle: "short" });
    displayFormatters.set(zone, formatter);
  }
  return formatter.format(date);
}
