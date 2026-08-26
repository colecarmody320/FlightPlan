import React, { useMemo, useState, useEffect } from "react";
import {
  buildCalendarEvents,
  eventsForDay,
  layoutDay,
  timeBounds,
  weekDays,
  weekStartISO,
  addDaysISO,
  todayISO,
  formatTime,
  formatRange,
  formatDayLabel,
  dayCodeOf,
  upcomingDeadlines,
  minutesOf,
  DAY_LABELS,
  EVENT_TYPES,
  CALENDAR_SOURCES,
} from "./calendar.js";
import { useGoogleCalendar } from "./googleCalendar.js";

/* ============================================================
   CALENDAR UI
   The Calendar tab and the Home THIS WEEK strip. Both consume
   buildCalendarEvents() — there is one normalized source and no
   per-source view. Read-only: nothing here writes.
   ============================================================ */

const SOURCE_LABEL = {
  [CALENDAR_SOURCES.FLIGHTPLAN]: "FlightPlan",
  [CALENDAR_SOURCES.BRIGHTSPACE]: "Brightspace",
  [CALENDAR_SOURCES.GOOGLE]: "Google Calendar",
  [CALENDAR_SOURCES.MANUAL]: "Manual",
};

const TYPE_LABEL = {
  [EVENT_TYPES.CLASS]: "Class",
  [EVENT_TYPES.ASSIGNMENT]: "Assignment",
  [EVENT_TYPES.QUIZ]: "Quiz",
  [EVENT_TYPES.EXAM]: "Exam",
  [EVENT_TYPES.EVENT]: "Event",
  [EVENT_TYPES.STUDY]: "Study",
  [EVENT_TYPES.FLIGHT]: "Flight",
  [EVENT_TYPES.OTHER]: "Objective",
};

/** Minute-of-day now, refreshed each minute for the time indicator. */
function useNowMinutes() {
  const calc = () => new Date().getHours() * 60 + new Date().getMinutes();
  const [m, setM] = useState(calc);
  useEffect(() => {
    const t = setInterval(() => setM(calc()), 60000);
    return () => clearInterval(t);
  }, []);
  return m;
}

/* ---------- event detail ---------- */
function EventDetail({ event, onClose }) {
  if (!event) return null;
  return (
    <>
      <div className="cal-scrim" onClick={onClose} />
      <div className="cal-detail" role="dialog" aria-label="Event details">
        <div className="cal-detail-head">
          <span className="cal-dot" style={{ background: event.color || "var(--edge)" }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="cal-detail-title">{event.title}</p>
            {event.subtitle && <p className="cal-detail-sub">{event.subtitle}</p>}
          </div>
          <button type="button" className="cal-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <dl className="cal-detail-rows">
          <div><dt>Type</dt><dd>{TYPE_LABEL[event.eventType] || event.eventType}</dd></div>
          <div><dt>Date</dt><dd>{formatDayLabel(event.date)}</dd></div>
          {!event.allDay && event.start && (
            <div>
              <dt>Time</dt>
              <dd>{formatTime(event.start)}{event.end ? ` – ${formatTime(event.end)}` : ""}</dd>
            </div>
          )}
          {event.allDay && <div><dt>Time</dt><dd>All day</dd></div>}
          {event.location && <div><dt>Location</dt><dd>{event.location}</dd></div>}
          {typeof event.minutes === "number" && event.minutes > 0 && (
            <div><dt>Logged</dt><dd>{event.minutes} min</dd></div>
          )}
          {typeof event.hours === "number" && event.hours > 0 && (
            <div><dt>Hours</dt><dd>{event.hours}</dd></div>
          )}
          <div><dt>Source</dt><dd>{SOURCE_LABEL[event.source] || event.source}</dd></div>
          {event.sourceCalendarName && (
            <div><dt>Calendar</dt><dd>{event.sourceCalendarName}</dd></div>
          )}
          {event.description && <div><dt>Details</dt><dd>{event.description}</dd></div>}
        </dl>
        {event.sourceUrl && (
          <a className="cal-open" href={event.sourceUrl} target="_blank" rel="noreferrer">
            Open original ↗
          </a>
        )}
      </div>
    </>
  );
}

/* ---------- one timed block ---------- */
function TimedBlock({ item, bounds, onOpen }) {
  const { event, start, end, column, columns } = item;
  const span = bounds.to - bounds.from;
  const top = ((start - bounds.from) / span) * 100;
  const height = Math.max(((end - start) / span) * 100, 2.2);
  const width = 100 / columns;

  return (
    <button
      type="button"
      className={`cal-block type-${event.eventType}`}
      style={{
        top: `${top}%`,
        height: `${height}%`,
        left: `${column * width}%`,
        width: `calc(${width}% - 2px)`,
        borderLeftColor: event.color || "var(--edge)",
      }}
      onClick={() => onOpen(event)}
      title={`${event.title} ${formatTime(event.start)}`}
    >
      <span className="cal-block-title">{event.title}</span>
      <span className="cal-block-time">
        {formatTime(event.start)}{event.end ? `–${formatTime(event.end)}` : ""}
      </span>
      {event.location && <span className="cal-block-loc">{event.location}</span>}
    </button>
  );
}

/* ---------- Google source panel ----------
   Connection state and calendar picker. Read-only: selecting calendars
   only records a display preference; nothing in Google is modified. */
function GoogleSource({ g }) {
  const [open, setOpen] = useState(false);

  const openPicker = async () => {
    setOpen(true);
    if (!g.calendars.length) await g.loadCalendars();
  };

  const toggle = (id) => {
    const next = g.selected.includes(id)
      ? g.selected.filter((x) => x !== id)
      : [...g.selected, id];
    g.selectCalendars(next);
  };

  return (
    <div className="cal-src">
      <span className="cal-dot" style={{ background: g.connected ? "#7FB2D4" : "var(--edge)" }} />
      <span className="cal-src-name">Google Calendar</span>
      <span className="cal-src-state">
        {g.connected ? (g.busy ? "syncing…" : "connected") : "not connected"}
      </span>

      {g.connected ? (
        <>
          <button type="button" className="cal-src-btn" onClick={openPicker}>Calendars</button>
          <button type="button" className="cal-src-btn" onClick={g.refresh} disabled={g.busy}>
            Refresh
          </button>
          <button type="button" className="cal-src-btn" onClick={g.disconnect}>Disconnect</button>
        </>
      ) : (
        <button type="button" className="cal-src-btn primary" onClick={g.connect}>Connect</button>
      )}

      {g.error && <span className="cal-src-err">{g.error.message}</span>}

      {open && g.connected && (
        <div className="cal-src-picker">
          <p className="cal-src-picker-h">
            Show these calendars
            <button type="button" className="cal-icon-btn" onClick={() => setOpen(false)}>✕</button>
          </p>
          {g.calendars.length === 0 ? (
            <p className="cal-note">Loading your calendars…</p>
          ) : (
            g.calendars.map((c) => {
              // Empty selection means "primary only" on the server.
              const on = g.selected.length ? g.selected.includes(c.id) : c.primary;
              return (
                <label key={c.id} className="cal-src-row">
                  <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
                  <span>{c.name}</span>
                  {c.primary && <span className="cal-src-tag">primary</span>}
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   CALENDAR TAB
   ============================================================ */
export function CalendarTab({ data, user = null, externalEvents = [], focusDate = null }) {
  const [anchor, setAnchor] = useState(focusDate || todayISO());
  const [selected, setSelected] = useState(null);
  const nowMin = useNowMinutes();
  const today = todayISO();

  const days = useMemo(() => weekDays(anchor), [anchor]);

  // Google events for exactly the visible week, merged with anything
  // the caller already passed in.
  const g = useGoogleCalendar({ user, from: days[0], to: days[6] });
  const merged = useMemo(
    () => [...externalEvents, ...(g.events || [])],
    [externalEvents, g.events]
  );

  // Memoized on the week and the data identity, so panning weeks or
  // unrelated re-renders do not rebuild the whole schedule.
  const events = useMemo(
    () => buildCalendarEvents(data, { from: days[0], to: days[6], externalEvents: merged }),
    [data, days, merged]
  );

  const bounds = useMemo(() => timeBounds(events), [events]);
  const hours = useMemo(() => {
    const out = [];
    for (let m = Math.ceil(bounds.from / 60) * 60; m <= bounds.to; m += 60) out.push(m);
    return out;
  }, [bounds]);

  const todayIndex = days.indexOf(today);

  return (
    <div className="cal">
      <div className="cal-bar">
        <button type="button" className="btn cal-nav" onClick={() => setAnchor(addDaysISO(anchor, -7))}>
          ‹ Prev
        </button>
        <button type="button" className="btn cal-nav" onClick={() => setAnchor(today)}>
          Today
        </button>
        <button type="button" className="btn cal-nav" onClick={() => setAnchor(addDaysISO(anchor, 7))}>
          Next ›
        </button>
        <span className="cal-range">{formatRange(days)}</span>
      </div>

      <GoogleSource g={g} />

      <div className="cal-scroll">
        <div className="cal-grid">
          <div className="cal-gutter-head" />
          {days.map((iso) => (
            <div key={iso} className={`cal-day-head ${iso === today ? "is-today" : ""}`}>
              <span className="cal-day-name">{DAY_LABELS[dayCodeOf(iso)]}</span>
              <span className="cal-day-num">{formatDayLabel(iso).split(" ")[1]}</span>
            </div>
          ))}

          {/* all-day row */}
          <div className="cal-gutter-allday">all day</div>
          {days.map((iso) => {
            const { allDay } = eventsForDay(events, iso);
            return (
              <div key={`ad-${iso}`} className={`cal-allday ${iso === today ? "is-today" : ""}`}>
                {allDay.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    className={`cal-chip type-${e.eventType} ${e.done ? "is-done" : ""}`}
                    style={{ borderLeftColor: e.color || "var(--edge)" }}
                    onClick={() => setSelected(e)}
                  >
                    {e.title}
                  </button>
                ))}
              </div>
            );
          })}

          {/* timed grid */}
          <div className="cal-gutter">
            {hours.map((m) => (
              <div key={m} className="cal-hour-label" style={{ top: `${((m - bounds.from) / (bounds.to - bounds.from)) * 100}%` }}>
                {formatTime(`${String(Math.floor(m / 60)).padStart(2, "0")}:00`)}
              </div>
            ))}
          </div>
          {days.map((iso) => {
            const { timed } = eventsForDay(events, iso);
            const laid = layoutDay(timed);
            return (
              <div key={`t-${iso}`} className={`cal-col ${iso === today ? "is-today" : ""}`}>
                {hours.map((m) => (
                  <div
                    key={m}
                    className="cal-hline"
                    style={{ top: `${((m - bounds.from) / (bounds.to - bounds.from)) * 100}%` }}
                  />
                ))}
                {laid.map((item) => (
                  <TimedBlock key={item.event.id} item={item} bounds={bounds} onOpen={setSelected} />
                ))}
                {iso === today && nowMin >= bounds.from && nowMin <= bounds.to && (
                  <div
                    className="cal-now"
                    style={{ top: `${((nowMin - bounds.from) / (bounds.to - bounds.from)) * 100}%` }}
                    aria-hidden="true"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {events.length === 0 && (
        <p className="cal-empty">
          Nothing scheduled this week. Class meeting times can be added per course under Courses.
        </p>
      )}

      <EventDetail event={selected} onClose={() => setSelected(null)} />
      {todayIndex === -1 && <p className="cal-note">Showing a week other than the current one.</p>}
    </div>
  );
}

/* ============================================================
   HOME — THIS WEEK
   A compact seven-day strip. Same normalized source as the tab.
   ============================================================ */
export function ThisWeekPanel({ data, user = null, externalEvents = [], go }) {
  const [selected, setSelected] = useState(null);
  const nowMin = useNowMinutes();
  const today = todayISO();
  const days = useMemo(() => weekDays(today), [today]);

  // Same hook and same week as the Calendar tab, so Home and Calendar
  // always show identical data.
  const g = useGoogleCalendar({ user, from: days[0], to: days[6] });
  const merged = useMemo(() => [...externalEvents, ...(g.events || [])], [externalEvents, g.events]);

  const events = useMemo(
    () => buildCalendarEvents(data, { from: days[0], to: days[6], externalEvents: merged }),
    [data, days, merged]
  );

  const bounds = useMemo(
    () => timeBounds(events, { from: 8 * 60, to: 21 * 60 }),
    [events]
  );
  const deadlines = useMemo(() => upcomingDeadlines(events, today, 3), [events, today]);
  const hasTimed = events.some((e) => !e.allDay && minutesOf(e.start) !== null);

  return (
    <div className="tw">
      <div className="tw-days">
        {days.map((iso) => {
          const { timed, allDay } = eventsForDay(events, iso);
          const laid = layoutDay(timed);
          const isToday = iso === today;
          return (
            <button
              key={iso}
              type="button"
              className={`tw-day ${isToday ? "is-today" : ""}`}
              onClick={() => go && go("calendar")}
              title={`${DAY_LABELS[dayCodeOf(iso)]} — open Calendar`}
            >
              <span className="tw-day-name">{DAY_LABELS[dayCodeOf(iso)]}</span>
              <span className="tw-day-num">{formatDayLabel(iso).split(" ")[1]}</span>
              <span className="tw-track">
                {laid.map((item) => {
                  const span = bounds.to - bounds.from;
                  const top = ((item.start - bounds.from) / span) * 100;
                  const h = Math.max(((item.end - item.start) / span) * 100, 4);
                  return (
                    <span
                      key={item.event.id}
                      className="tw-block"
                      style={{
                        top: `${Math.max(0, Math.min(96, top))}%`,
                        height: `${h}%`,
                        left: `${item.column * (100 / item.columns)}%`,
                        width: `calc(${100 / item.columns}% - 1px)`,
                        background: item.event.color || "var(--edge)",
                      }}
                    />
                  );
                })}
                {isToday && nowMin >= bounds.from && nowMin <= bounds.to && (
                  <span
                    className="tw-now"
                    style={{ top: `${((nowMin - bounds.from) / (bounds.to - bounds.from)) * 100}%` }}
                  />
                )}
              </span>
              <span className="tw-count">
                {allDay.length ? `${allDay.length} ·` : ""}{timed.length || (allDay.length ? "" : "—")}
              </span>
            </button>
          );
        })}
      </div>

      {!hasTimed && (
        <p className="tw-hint">
          No class times yet — add meeting times to a course under Courses and they'll appear here.
        </p>
      )}

      {deadlines.length > 0 && (
        <div className="tw-upcoming">
          <p className="tw-upcoming-h">Upcoming</p>
          {deadlines.map((e) => (
            <button key={e.id} type="button" className="tw-up-row" onClick={() => setSelected(e)}>
              <span className="cal-dot" style={{ background: e.color || "var(--edge)" }} />
              <span className="tw-up-title">{e.title}</span>
              <span className="tw-up-when">
                {e.date === today ? "Today" : e.date === addDaysISO(today, 1) ? "Tomorrow" : formatDayLabel(e.date)}
              </span>
            </button>
          ))}
        </div>
      )}

      <button type="button" className="btn tw-open" onClick={() => go && go("calendar")}>
        View Calendar
      </button>

      <EventDetail event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export const CALENDAR_CSS = `
  /* ---------- shared ---------- */
  .cal-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; }
  .cal-icon-btn {
    flex: none; width: 26px; height: 26px; border: none; background: none; color: var(--muted);
    border-radius: 7px; cursor: pointer; font-size: 12px;
  }
  .cal-icon-btn:hover { color: var(--bone); background: rgba(255,255,255,.06); }

  /* ---------- calendar tab ---------- */
  .cal-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .cal-nav { padding: 6px 12px; font-size: 13px; }
  .cal-range {
    margin-left: auto; font-family: 'JetBrains Mono', monospace; font-size: 11px;
    letter-spacing: .12em; color: var(--muted);
  }

  .cal-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .cal-grid {
    display: grid;
    grid-template-columns: 52px repeat(7, minmax(96px, 1fr));
    grid-template-rows: auto auto 1fr;
    min-width: 720px;
  }

  .cal-gutter-head, .cal-day-head {
    padding: 6px 4px; border-bottom: 1px solid var(--line); text-align: center;
  }
  .cal-day-head { display: flex; flex-direction: column; gap: 1px; }
  .cal-day-name { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
  .cal-day-num { font-size: 15px; font-weight: 600; color: var(--bone); }
  .cal-day-head.is-today .cal-day-num { color: var(--green-bright); }
  .cal-day-head.is-today .cal-day-name { color: var(--green-bright); }

  .cal-gutter-allday {
    font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint);
    padding: 6px 4px; text-align: right; border-bottom: 1px solid var(--line);
  }
  .cal-allday {
    min-height: 26px; padding: 4px 3px; display: flex; flex-direction: column; gap: 3px;
    border-left: 1px solid var(--line); border-bottom: 1px solid var(--line);
  }
  .cal-allday.is-today { background: rgba(62,142,99,.05); }

  .cal-chip {
    text-align: left; font-size: 10.5px; line-height: 1.3; color: var(--bone);
    background: var(--raised); border: 1px solid var(--line); border-left-width: 3px;
    border-radius: 5px; padding: 3px 5px; cursor: pointer;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cal-chip:hover { border-color: var(--edge); }
  .cal-chip.is-done { opacity: .5; text-decoration: line-through; }

  .cal-gutter { position: relative; height: 620px; }
  .cal-hour-label {
    position: absolute; right: 6px; transform: translateY(-50%);
    font-family: 'JetBrains Mono', monospace; font-size: 9px; color: var(--faint); white-space: nowrap;
  }
  .cal-col { position: relative; height: 620px; border-left: 1px solid var(--line); }
  .cal-col.is-today { background: rgba(62,142,99,.05); }
  .cal-hline { position: absolute; left: 0; right: 0; height: 1px; background: var(--line); opacity: .5; }

  .cal-block {
    position: absolute; overflow: hidden; text-align: left;
    background: var(--raised); border: 1px solid var(--line); border-left-width: 3px;
    border-radius: 5px; padding: 3px 5px; cursor: pointer;
    display: flex; flex-direction: column; gap: 1px;
  }
  .cal-block:hover { border-color: var(--edge); z-index: 3; }
  .cal-block-title {
    font-size: 11px; font-weight: 600; color: var(--bone);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    flex: none; /* never squeezed out of a short block */
  }
  .cal-block-time { font-family: 'JetBrains Mono', monospace; font-size: 9px; color: var(--muted); }
  .cal-block-loc { font-size: 9.5px; color: var(--faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .cal-now { position: absolute; left: 0; right: 0; height: 1px; background: var(--alert); z-index: 4; }
  .cal-now::before {
    content: ""; position: absolute; left: -3px; top: -2.5px;
    width: 6px; height: 6px; border-radius: 50%; background: var(--alert);
  }

  .cal-empty, .cal-note { font-size: 12px; color: var(--faint); margin-top: 14px; }

  /* ---------- event detail ---------- */
  .cal-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 50; }
  .cal-detail {
    position: fixed; z-index: 51; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(420px, 92vw); max-height: 80vh; overflow-y: auto;
    background: var(--raised); border: 1px solid var(--line); border-radius: 14px;
    padding: 16px; box-shadow: 0 18px 44px rgba(0,0,0,.45);
  }
  .cal-detail-head { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
  .cal-detail-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--bone); }
  .cal-detail-sub { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
  .cal-detail-rows { margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .cal-detail-rows > div { display: flex; gap: 10px; font-size: 12.5px; }
  .cal-detail-rows dt { flex: none; width: 74px; color: var(--faint); }
  .cal-detail-rows dd { margin: 0; color: var(--bone); min-width: 0; word-break: break-word; }
  .cal-open { display: inline-block; margin-top: 14px; font-size: 12px; color: var(--green-bright); }

  /* ---------- source panel ---------- */
  .cal-src {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 8px 12px; margin-bottom: 12px;
    border: 1px solid var(--line); border-radius: 10px;
    background: rgba(127,178,212,.05); position: relative;
  }
  .cal-src-name { font-size: 12.5px; color: var(--bone); font-weight: 500; }
  .cal-src-state { font-size: 11px; color: var(--faint); }
  .cal-src-btn {
    border: 1px solid var(--edge); background: none; color: var(--muted);
    font-size: 11.5px; padding: 4px 10px; border-radius: 999px; cursor: pointer;
  }
  .cal-src-btn:hover:not([disabled]) { color: var(--bone); border-color: var(--lamp); }
  .cal-src-btn[disabled] { opacity: .4; cursor: default; }
  .cal-src-btn.primary { color: var(--green-bright); border-color: var(--green); }
  .cal-src-err { font-size: 11px; color: var(--alert); flex-basis: 100%; }

  .cal-src-picker {
    position: absolute; top: calc(100% + 6px); left: 0; z-index: 20;
    width: min(320px, 92vw); background: var(--raised);
    border: 1px solid var(--line); border-radius: 12px; padding: 12px;
    box-shadow: 0 12px 32px rgba(0,0,0,.4);
  }
  .cal-src-picker-h {
    display: flex; align-items: center; justify-content: space-between;
    margin: 0 0 8px; font-size: 11px; letter-spacing: .1em;
    text-transform: uppercase; color: var(--faint);
  }
  .cal-src-row {
    display: flex; align-items: center; gap: 8px; padding: 5px 0;
    font-size: 12.5px; color: var(--bone); cursor: pointer;
  }
  .cal-src-tag {
    font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--faint); margin-left: auto;
  }

  /* ---------- home: this week ---------- */
  .tw { margin-bottom: 4px; }
  .tw-days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
  .tw-day {
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 7px 2px 6px; border: 1px solid var(--line); border-radius: 10px;
    background: none; cursor: pointer; min-width: 0;
    transition: border-color .15s ease, background .15s ease;
  }
  .tw-day:hover { border-color: var(--edge); background: rgba(62,142,99,.06); }
  .tw-day.is-today { border-color: var(--green); background: rgba(62,142,99,.10); }
  .tw-day-name { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
  .tw-day.is-today .tw-day-name { color: var(--green-bright); }
  .tw-day-num { font-size: 13px; font-weight: 600; color: var(--bone); }
  .tw-track {
    position: relative; width: 100%; height: 62px; margin-top: 2px;
    background: var(--surface); border-radius: 5px; overflow: hidden;
  }
  .tw-block { position: absolute; border-radius: 2px; opacity: .85; }
  .tw-now { position: absolute; left: 0; right: 0; height: 1px; background: var(--alert); }
  .tw-count { font-family: 'JetBrains Mono', monospace; font-size: 9px; color: var(--faint); }

  .tw-hint { font-size: 11.5px; color: var(--faint); margin: 10px 0 0; }

  .tw-upcoming { margin-top: 12px; }
  .tw-upcoming-h {
    font-family: 'JetBrains Mono', monospace; font-size: 9.5px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--faint); margin: 0 0 6px;
  }
  .tw-up-row {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    background: none; border: none; padding: 5px 0; cursor: pointer; color: var(--bone); font-size: 12.5px;
  }
  .tw-up-row:hover .tw-up-title { color: var(--green-bright); }
  .tw-up-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tw-up-when { flex: none; font-size: 11px; color: var(--muted); }
  .tw-open { margin-top: 12px; padding: 7px 14px; font-size: 12.5px; }

  @media (max-width: 720px) {
    .cal-grid { min-width: 680px; }
    /* Short blocks can't fit three lines; keep title + time, drop location. */
    .cal-block-loc { display: none; }
    .cal-block { padding: 2px 4px; }
    .cal-block-title { font-size: 10.5px; }
    .cal-gutter, .cal-col { height: 520px; }
    .tw-days { gap: 3px; }
    .tw-track { height: 48px; }
    .tw-day { padding: 6px 1px 5px; }
    .tw-day-num { font-size: 12px; }
    .cal-detail { width: 94vw; }
  }

  @media (prefers-reduced-motion: reduce) {
    .tw-day, .cal-chip, .cal-block { transition: none; }
  }
`;
