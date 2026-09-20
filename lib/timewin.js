'use strict';

const { TIMEZONE } = require('./constants');
const clock = require('./clock');

/**
 * 全校统一的「允许点人」时段。服务端一律按 Asia/Shanghai 判断，与服务器本机时区无关。
 *
 *   { timezone, weekdays: [1..5], windows: [{ start:'08:45', end:'09:00', label:'课间' }] }
 *
 * 规则：开始时间包含、结束时间不包含（08:45:00 可以，09:00:00 不行）。
 */

const DEFAULT_WINDOWS = Object.freeze({
  timezone: TIMEZONE,
  weekdays: [1, 2, 3, 4, 5],
  windows: [
    { start: '08:45', end: '09:00', label: '课间' },
    { start: '09:45', end: '10:15', label: '课间' },
    { start: '11:00', end: '11:15', label: '课间' },
    { start: '11:35', end: '12:30', label: '午餐、过渡时间、午自习' },
    { start: '13:00', end: '13:10', label: '午休结束后的课间' },
    { start: '13:55', end: '14:15', label: '课间' },
    { start: '15:00', end: '15:15', label: '课间' },
    { start: '16:00', end: '16:15', label: '课间' },
  ],
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toMinutes(hhmm) {
  const m = TIME_RE.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return formatters.get(tz);
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 把某个时刻换算成目标时区的「墙上时间」 */
function zoned(ms, tz = TIMEZONE) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: WD[parts.weekday],
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    minutes: hour * 60 + Number(parts.minute),
    seconds: hour * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

/** 目标时区某天某时刻对应的绝对毫秒（迭代两次消除时区偏移） */
function zonedToMs(date, minutes, tz = TIMEZONE) {
  const m = DATE_RE.exec(date);
  if (!m) return NaN;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor(minutes / 60), minutes % 60, 0);
  let result = guess;
  for (let i = 0; i < 2; i += 1) {
    const z = zoned(result, tz);
    const wanted = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0) + minutes * 60_000;
    const actual = Date.UTC(...z.date.split('-').map(Number).map((v, i2) => (i2 === 1 ? v - 1 : v)), 0, 0, 0)
      + z.seconds * 1000;
    result += wanted - actual;
  }
  return result;
}

/** 把用户提交的作息校验成规范结构；失败抛 Error（消息可直接展示） */
function normalizeWindows(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('作息必须是对象');
  const timezone = raw.timezone === undefined ? TIMEZONE : String(raw.timezone);
  try { formatter(timezone); } catch { throw new Error(`时区无效：${timezone}`); }

  const weekdaysRaw = raw.weekdays === undefined ? [1, 2, 3, 4, 5] : raw.weekdays;
  if (!Array.isArray(weekdaysRaw)) throw new Error('weekdays 必须是数组');
  const weekdays = [...new Set(weekdaysRaw.map(Number))].sort();
  if (weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('weekdays 只能是 0–6');

  if (!Array.isArray(raw.windows)) throw new Error('windows 必须是数组');
  if (raw.windows.length > 24) throw new Error('时段不能超过 24 个');
  const windows = raw.windows.map((w, i) => {
    if (!w || typeof w !== 'object') throw new Error(`第 ${i + 1} 个时段格式有误`);
    const start = toMinutes(String(w.start ?? ''));
    const end = toMinutes(String(w.end ?? ''));
    if (start === null || end === null) throw new Error(`第 ${i + 1} 个时段的时间格式应为 HH:MM`);
    if (end <= start) throw new Error(`第 ${i + 1} 个时段的结束时间必须晚于开始时间`);
    const label = String(w.label ?? '').trim().slice(0, 30);
    return { start: fromMinutes(start), end: fromMinutes(end), label };
  }).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 1; i < windows.length; i += 1) {
    if (toMinutes(windows[i].start) < toMinutes(windows[i - 1].end)) {
      throw new Error(`时段 ${windows[i - 1].start}–${windows[i - 1].end} 与 ${windows[i].start}–${windows[i].end} 重叠`);
    }
  }
  return { timezone, weekdays, windows };
}

class CallWindows {
  constructor(config) { this.set(config); }

  set(config) { this.config = config ? normalizeWindows(config) : { ...DEFAULT_WINDOWS, windows: [...DEFAULT_WINDOWS.windows] }; }

  get() { return this.config; }

  /** 某个绝对时刻是否允许点人 */
  isOpen(ms = clock.now()) {
    return this.status(ms).open;
  }

  /** 某个「星期 + HH:MM」是否落在某个时段内（定时任务创建时用） */
  containsTime(weekday, hhmm) {
    const min = toMinutes(hhmm);
    if (min === null || !this.config.weekdays.includes(weekday)) return false;
    return this.config.windows.some((w) => min >= toMinutes(w.start) && min < toMinutes(w.end));
  }

  /**
   * 当前状态与下一次可用时段：
   *   { open, now:{date,weekday,time}, current?:{start,end,label}, next?:{date,weekday,start,end,label,startsAt} }
   */
  status(ms = clock.now()) {
    const { timezone, weekdays, windows } = this.config;
    const z = zoned(ms, timezone);
    const base = { open: false, timezone, now: { date: z.date, weekday: z.weekday, time: fromMinutes(z.minutes) } };
    if (weekdays.includes(z.weekday)) {
      const cur = windows.find((w) => z.minutes >= toMinutes(w.start) && z.minutes < toMinutes(w.end));
      if (cur) {
        return { ...base, open: true, current: { ...cur, endsAt: zonedToMs(z.date, toMinutes(cur.end), timezone) }, next: this._next(ms, z, 0) };
      }
    }
    return { ...base, next: this._next(ms, z, 0) };
  }

  /** 从 z 所在日开始，找下一个尚未开始的时段（最多找 8 天） */
  _next(ms, z, _unused) {
    const { timezone, weekdays, windows } = this.config;
    if (!windows.length || !weekdays.length) return null;
    for (let offset = 0; offset < 8; offset += 1) {
      const dayMs = ms + offset * 86_400_000;
      const zd = zoned(dayMs, timezone);
      if (!weekdays.includes(zd.weekday)) continue;
      for (const w of windows) {
        if (offset === 0 && toMinutes(w.start) <= z.minutes) continue;
        return {
          ...w, date: zd.date, weekday: zd.weekday, weekdayName: WEEKDAY_NAMES[zd.weekday],
          startsAt: zonedToMs(zd.date, toMinutes(w.start), timezone),
        };
      }
    }
    return null;
  }
}

module.exports = {
  CallWindows, DEFAULT_WINDOWS, normalizeWindows, zoned, zonedToMs, toMinutes, fromMinutes,
  TIME_RE, DATE_RE, WEEKDAY_NAMES,
};
