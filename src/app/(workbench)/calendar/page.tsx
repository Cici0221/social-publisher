import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { publishClockTime, publishZones, type PublishZone } from "@/lib/publish-time";
import { pageActor } from "@/server/auth";
import {
  calendarPeriod, calendarViewLabels, listCalendar, parseCalendarParams, type CalendarEvent, type CalendarView,
} from "@/server/calendar";
import { AppError } from "@/server/errors";
import { modeLabel, platformLabel, statusLabels } from "@/server/history";
import styles from "./calendar.module.css";

export const metadata: Metadata = { title: "发布日历" };

function calendarHref(view: CalendarView, zone: PublishZone, date: string) {
  return "/calendar?" + new URLSearchParams({ view, zone, date });
}

function periodName(period: ReturnType<typeof calendarPeriod>) {
  const [year, month, day] = period.first.split("-").map(Number);
  if (period.view === "month") return `${year} 年 ${month} 月`;
  const start = `${year} 年 ${month} 月 ${day} 日`;
  if (period.view === "day") return start;
  const [endYear, endMonth, endDay] = period.last.split("-").map(Number);
  return `${start} 至 ${endYear !== year ? endYear + " 年 " : ""}${endMonth} 月 ${endDay} 日`;
}

function eventStatus(event: CalendarEvent) {
  return (event.mode === "MOCK" ? "模拟 · " : "") + statusLabels[event.status];
}

function CompactEvent({ event, zone }: { event: CalendarEvent; zone: PublishZone }) {
  return <Link
    href={`/contents/${event.contentId}/progress`}
    className={`${styles.event} ${event.status === "SUCCESS" ? styles.eventDone : ""}`}
    title={`${event.title} · ${platformLabel(event.platform)} · ${eventStatus(event)}`}
  >
    <span className={styles.eventTop}>
      <time dateTime={event.at.toISOString()}>{publishClockTime(event.at, zone)}</time>
      <span>{eventStatus(event)}</span>
    </span>
    <strong>{event.title}</strong>
    <span className={styles.eventAccount}>{platformLabel(event.platform)} · {event.account.name}</span>
  </Link>;
}

function DayEvents({ events, zone }: { events: CalendarEvent[]; zone: PublishZone }) {
  if (!events.length) return <p className={styles.empty}>这一天没有发布或待发布任务。</p>;
  return <ul className={styles.dayEvents}>{events.map(event =>
    <li key={event.id}>
      <time dateTime={event.at.toISOString()}>{publishClockTime(event.at, zone)}</time>
      <div>
        <Link href={`/contents/${event.contentId}/progress`} className="text-link">{event.title}</Link>
        <p className="small muted">{platformLabel(event.platform)} · {event.account.name} · {event.publisher.name}</p>
      </div>
      <span className={event.status === "SUCCESS" ? "delivery-badge good" : "delivery-badge"}>{statusLabels[event.status]}</span>
      <span className="small muted">{modeLabel(event.mode)}</span>
    </li>
  )}</ul>;
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await pageActor("ADMIN", "EDITOR");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) if (typeof value === "string") query.set(key, value);
  const options = parseCalendarParams(query);
  let period;
  let warning: string | undefined;
  try {
    period = calendarPeriod(options.date, options.view, options.zone);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    warning = error.message;
    period = calendarPeriod(options.today, options.view, options.zone);
  }
  const heading = periodName(period);
  const events = await listCalendar(actor, period);
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const day = byDay.get(event.date);
    if (day) day.push(event);
    else byDay.set(event.date, [event]);
  }

  return <div className="page-container">
    <header className="page-header">
      <div><h1>发布日历</h1><p className="muted">查看待发布任务和已发布结果。</p></div>
      <nav className={styles.viewPicker} aria-label="日历视图">
        {Object.entries(calendarViewLabels).map(([key, label]) =>
          <Link
            className={styles.viewOption}
            href={calendarHref(key as CalendarView, period.zone, period.date)}
            key={key}
            aria-current={period.view === key ? "page" : undefined}
          >{label}</Link>
        )}
      </nav>
    </header>

    <section className="panel" aria-labelledby="calendar-period">
      <div className={styles.toolbar}>
        <div className={styles.navigation}>
          <Link className="icon-button" href={calendarHref(period.view, period.zone, period.previous)} aria-label={`上一${calendarViewLabels[period.view]}`}><ChevronLeft size={20} aria-hidden="true" /></Link>
          <h2 className="section-title" id="calendar-period">{heading}</h2>
          <Link className="icon-button" href={calendarHref(period.view, period.zone, period.next)} aria-label={`下一${calendarViewLabels[period.view]}`}><ChevronRight size={20} aria-hidden="true" /></Link>
          <Link className="button button-outline button-compact" href={calendarHref(period.view, period.zone, options.today)}>今天</Link>
        </div>
        <form className={styles.jump} method="get" action="/calendar" aria-label="日期和显示时区">
          <input type="hidden" name="view" value={period.view} />
          <label className="field"><span>日期</span><input name="date" type="date" defaultValue={period.date} required /></label>
          <label className="field"><span>时区</span><select name="zone" defaultValue={period.zone}>
            {Object.entries(publishZones).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
          </select></label>
          <button className="button button-outline" type="submit">跳转</button>
        </form>
      </div>

      {warning && <p role="alert" className={`feedback feedback-error ${styles.warning}`}>{warning}</p>}
      {period.view === "day" ? <DayEvents events={events} zone={period.zone} /> :
        <div className={styles.scroll} role="region" aria-label={heading + "的发布任务"} tabIndex={0}>
          <div className={styles.calendarGrid}>
            {["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(label => <div className={styles.weekday} key={label}>{label}</div>)}
            {period.days.map(({ date, inside }) => {
              const items = byDay.get(date) ?? [];
              const daily = calendarHref("day", period.zone, date);
              const limit = period.view === "week" ? 8 : 4;
              return <section
                className={`${styles.calendarCell} ${inside ? "" : styles.outside} ${date === options.today ? styles.today : ""}`}
                key={date}
                aria-label={date}
              >
                <Link className={styles.cellDate} href={daily} aria-label={`查看 ${date}`} aria-current={date === options.today ? "date" : undefined}>
                  {Number(date.slice(-2))}
                </Link>
                <div className={styles.events}>
                  {items.slice(0, limit).map(event => <CompactEvent key={event.id} event={event} zone={period.zone} />)}
                  {items.length > limit && <Link className="text-link" href={daily}>另有 {items.length - limit} 条</Link>}
                </div>
              </section>;
            })}
          </div>
        </div>}
    </section>
  </div>;
}
