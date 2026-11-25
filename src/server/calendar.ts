import type { Prisma } from "@/generated/prisma/client";
import type { TaskStatus } from "@/generated/prisma/enums";
import { dateInPublishZone, localPublishTimeToDate, normalizePublishZone, parsePublishDate, type PublishZone } from "@/lib/publish-time";
import type { Actor } from "./auth";
import { db } from "./db";
import { AppError } from "./errors";
import { copyText, publisherScope } from "./history";

export const calendarViewLabels = { day: "日", week: "周", month: "月" } as const;
export type CalendarView = keyof typeof calendarViewLabels;
const planned: TaskStatus[] = ["WAITING_APPROVAL", "SCHEDULED", "QUEUED", "UPLOADING", "PUBLISHING", "PROCESSING", "MANUAL"];

export function calendarDayKey(date: Date) { return date.toISOString().slice(0, 10); }

function offsetDays(date: Date, days: number) {
  const next = new Date(+date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function offsetMonths(date: Date, months: number) {
  const next = new Date(+date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function monday(date: Date) {
  return offsetDays(date, -((date.getUTCDay() + 6) % 7));
}

export function calendarPeriod(date: string, view: CalendarView, zone: PublishZone) {
  const anchor = parsePublishDate(date);
  if (!anchor) throw new AppError("请选择有效的日历日期。");
  const start = view === "week" ? monday(anchor) : view === "month" ? offsetDays(anchor, 1 - anchor.getUTCDate()) : anchor;
  const next = view === "month" ? offsetMonths(start, 1) : offsetDays(start, view === "week" ? 7 : 1);
  const previous = view === "month" ? offsetMonths(start, -1) : offsetDays(start, view === "week" ? -7 : -1);
  const startKey = calendarDayKey(start);
  const nextKey = calendarDayKey(next);
  const startInstant = localPublishTimeToDate(startKey + "T00:00", zone);
  const nextInstant = localPublishTimeToDate(nextKey + "T00:00", zone);
  if (!startInstant || !nextInstant) throw new AppError("所选日期无法显示。");

  const gridStart = view === "month" ? monday(start) : start;
  const gridEnd = view === "month" && next.getUTCDay() !== 1 ? offsetDays(monday(next), 7) : next;
  const days: { date: string; inside: boolean }[] = [];
  for (let current = gridStart; current < gridEnd; current = offsetDays(current, 1)) {
    days.push({ date: calendarDayKey(current), inside: current >= start && current < next });
  }
  return {
    view, zone, date, first: startKey, last: calendarDayKey(offsetDays(next, -1)),
    previous: calendarDayKey(previous), next: nextKey, startInstant, nextInstant, days,
  };
}

export function parseCalendarParams(params: Pick<URLSearchParams, "get">, now = new Date()) {
  const incomingView = params.get("view");
  const view = incomingView && Object.hasOwn(calendarViewLabels, incomingView) ? incomingView as CalendarView : "month";
  const zone = normalizePublishZone(params.get("zone"));
  const incomingDate = params.get("date");
  const today = dateInPublishZone(now, zone);
  return { view, zone, date: incomingDate || today, today };
}

export function calendarWhere(actor: Pick<Actor, "id" | "role">, period: ReturnType<typeof calendarPeriod>): Prisma.PublishTaskWhereInput {
  const range = { gte: period.startInstant, lt: period.nextInstant };
  return {
    AND: [
      publisherScope(actor),
      { OR: [
        { status: "SUCCESS", publishedAt: range },
        { status: { in: planned }, runAt: range },
      ] },
    ],
  };
}

export async function listCalendar(actor: Pick<Actor, "id" | "role">, period: ReturnType<typeof calendarPeriod>) {
  const records = await db().publishTask.findMany({
    where: calendarWhere(actor, period),
    select: {
      id: true, contentId: true, status: true, mode: true, platform: true, payload: true, runAt: true, publishedAt: true,
      account: { select: { name: true } }, publisher: { select: { name: true } },
    },
  });
  const events = records.map(({ payload, publishedAt, runAt, ...record }) => {
    const { title, body } = copyText(payload);
    const at = record.status === "SUCCESS" && publishedAt ? publishedAt : runAt;
    return {
      ...record, at, date: dateInPublishZone(at, period.zone),
      title: title.trim() || body.split("\n")[0]?.trim() || "未命名内容",
    };
  });
  events.sort((a, b) => +a.at - +b.at || a.id.localeCompare(b.id));
  return events;
}

export type CalendarEvent = Awaited<ReturnType<typeof listCalendar>>[number];
