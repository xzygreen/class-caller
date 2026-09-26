# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Teachers** (primary). Individual accounts. They open the teacher page on a phone in a corridor or on an office computer, about equally often, find one or more students in a class roster and send "Caller is looking for you" to that class's classroom display. The job is minutes-long at most and usually happens during the short break between lessons.
- **Administrators.** School IT or academic-affairs staff. They manage classes and rosters, the school-wide call windows (break times), teacher accounts and class authorization, scheduled reminders, the classroom displays, and the audit log.
- **Students** (display only). They read the classroom display from across the room and tap "收到" to confirm they have seen it.

## Product Purpose

A teacher taps a few names and the classroom display shows "X 老师正在找：张三、李四" within a second. The student taps "收到" on the display and the teacher sees the confirmation immediately. The same system also carries class announcements, admin emergency broadcasts, and daily scheduled reminders. One server serves every class in the school, with one display per class.

Success: the teacher finds and notifies a student in a few seconds and knows the message landed; students can read the display from the back of the room; administrators can spot and fix problems (offline displays, pending requests, paused schedules) at a glance.

## Positioning

The product's core is a tracked delivery: selected → sent → queued → on screen → acknowledged, with per-student confirmation. A generic digital-signage or messaging tool does not have this. Priority queueing (urgent > scheduled > manual call > announcement) and school-wide call windows are part of the product's rules.

## Operating Context

- Calls are only allowed during admin-defined call windows (breaks), in Asia/Shanghai time. Outside them, teachers see "上课中" and the next available time.
- Classroom displays are often Windows 7 machines on the school intranet, running either a browser or the native `display.exe`. They start automatically and run unattended all day.
- Rosters can reach about 200 names. One call can include up to 20 students (`maxNamesPerCall`).
- Production is behind Nginx and Cloudflare.

## Capabilities and Constraints

- Zero-dependency Node.js server. The front end is plain static HTML/CSS/JS in `public/`, with no build step and no third-party network resources (a test enforces this).
- No web font downloads. Chinese font files would slow display startup on the intranet. Use system CJK stacks only.
- Each class has a helper color (blue, green, orange, purple, teal, red) that is used for identification.
- The native Windows display program has its own name and UI and is not part of the web surfaces.

## Brand Commitments

- Product name in the web UI: **Caller**, paired with the Chinese role: "Caller · 教师端", "Caller · 管理端", "示例班级1 · Caller", "Caller 大屏". This replaced the old name "老师找人" in September 2026. Wording on the display such as "张老师正在找" stays as it is.
- The classroom display's deep ink background, warm gold baseline under each name, and very large name type are the most recognizable part of the product and are kept.

## Product Principles

1. The display is public infrastructure. Legibility across a classroom beats decoration.
2. Every notification has a visible lifecycle, and the sender can always see where their message is.
3. Risky actions (urgent broadcasts, clearing queues, disabling accounts, granting access) state their impact before they happen.
4. The fastest path is the default path. A teacher should never have to remember state across screens.

## Accessibility & Inclusion

- Touch targets are at least 44px. There is a clear keyboard focus. Status is never conveyed by color alone. `prefers-reduced-motion` is respected.
- The display must stay readable from the back of a classroom at 1366×768, 1080p, 4K, and on ultra-wide screens.
