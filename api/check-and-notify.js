const webpush = require("web-push");

// ---------- fixture reminders (Liverpool + UFC) ----------
const { refreshFixtures } = require("./sports.js");

// Egypt observes DST, so the Cairo offset is not a constant +03.
// Derive it from the actual instant instead of hardcoding.
function tzOffsetMs(date, tz) {
  const asUTC = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const asTz = new Date(date.toLocaleString("en-US", { timeZone: tz }));
  return asTz.getTime() - asUTC.getTime();
}

function cairoParts(date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [y, m, d] = f.format(date).split("-").map(Number);
  return { y, m, d };
}

// Convert a Cairo wall-clock time into a real UTC epoch.
function cairoWallToUTC(y, m, d, hh, mm) {
  let guess = Date.UTC(y, m - 1, d, hh - 3, mm);
  for (let i = 0; i < 2; i++) {
    const off = tzOffsetMs(new Date(guess), "Africa/Cairo");
    guess = Date.UTC(y, m - 1, d, hh, mm) - off;
  }
  return guess;
}

function cairoTimeLabel(iso) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo",
  });
}

// Two reminders per fixture: 21:00 Cairo the night before, and one hour out.
function reminderTriggers(fx) {
  const start = new Date(fx.startUTC).getTime();
  if (isNaN(start)) return [];

  const dayOf = cairoParts(new Date(start));
  const nightBefore = cairoWallToUTC(dayOf.y, dayOf.m, dayOf.d, 21, 0) - 24 * 3600 * 1000;

  const label = fx.kind === "ufc" ? "UFC" : (fx.competition || "LIVERPOOL").toUpperCase();
  const timeStr = fx.timeKnown ? cairoTimeLabel(fx.startUTC) : "time TBC";

  return [
    { suffix: "night", at: nightBefore, title: "Tomorrow: " + fx.title, body: label + "  ·  " + timeStr },
    { suffix: "hour", at: start - 60 * 60 * 1000, title: fx.title, body: label + (fx.timeKnown ? "  ·  starts " + timeStr : "  ·  starting soon") },
  ];
}


function cairoDateKey(y, m, d) {
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

// Daily recurring reminders (feeding times, grooming, etc). Unlike fixtures,
// these repeat every day at a fixed Cairo wall-clock time rather than firing
// once relative to a single dated event.
function routineTriggers(routine, now) {
  if (routine.enabled === false) return [];
  const day = cairoParts(new Date(now));
  const dateKey = cairoDateKey(day.y, day.m, day.d);

  return (routine.times || []).map(function (t) {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(t);
    if (!m) return null;
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    return {
      suffix: t + ":" + dateKey,
      at: cairoWallToUTC(day.y, day.m, day.d, hh, mm),
      title: routine.label,
      body: (CATEGORY_LABEL[routine.categoryId] || "REMINDER") + "  ·  " + t,
    };
  }).filter(Boolean);
}

// mirrors CATEGORIES in index.html — used to label the notification
const CATEGORY_LABEL = {
  work: "WORK",
  vonarson: "VONARSON",
  home: "HOME",
  books: "BOOKS",
  movies: "MOVIES",
  series: "SERIES",
  health: "HEALTH",
  dog: "ENZO",
  notes: "NOTES",
  inbox: "INBOX",
};

function buildBody(t) {
  const label = CATEGORY_LABEL[t.categoryId] || "INBOX";
  const when = t.dueDateUTC || t.dueDate;
  if (!when) return label;
  const d = new Date(when);
  if (isNaN(d.getTime())) return label;
  // render in Cairo time so it matches what the phone shows
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Cairo",
  });
  return label + "  ·  due " + time;
}

async function redisCmd(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const data = await r.json();
  return data.result;
}

module.exports = async (req, res) => {
  const auth = req.headers["authorization"] || "";
  if (auth !== "Bearer " + process.env.CRON_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    webpush.setVapidDetails(
      "mailto:mindorg@vonarson.com",
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const subRaw = await redisCmd(["GET", "flow:subscription"]);
    const tasksRaw = await redisCmd(["GET", "flow:tasks"]);
    const notifiedRaw = await redisCmd(["GET", "flow:notified"]);

    if (!subRaw || !tasksRaw) {
      // No push subscription yet — but keep the fixture cache warm anyway so
      // the Sports tab is current the moment the app is opened.
      let refreshed = false;
      try {
        const fxRaw = await redisCmd(["GET", "flow:fixtures:v4"]);
        let fxData = null;
        try { fxData = fxRaw ? JSON.parse(fxRaw) : null; } catch (e) {}
        const sixHours = 6 * 60 * 60 * 1000;
        if (!fxData || !fxData.fetchedAt || Date.now() - fxData.fetchedAt > sixHours) {
          await refreshFixtures();
          refreshed = true;
        }
      } catch (e) {}
      res.status(200).json({ ok: true, skipped: "no subscription or tasks yet", refreshed });
      return;
    }

    const subscription = JSON.parse(subRaw);
    const tasks = JSON.parse(tasksRaw);
    const notified = notifiedRaw ? JSON.parse(notifiedRaw) : {};

    const now = Date.now();
    let sent = 0;

    for (const t of tasks) {
      if (t.done || !t.dueDate || notified[t.id]) continue;
      const dueTime = new Date(t.dueDateUTC || t.dueDate).getTime();
      if (dueTime <= now) {
        try {
          await webpush.sendNotification(
            subscription,
            JSON.stringify({ title: t.text, body: buildBody(t), tag: "task-" + t.id })
          );
          sent++;
        } catch (e) {
          // subscription may be stale/expired; ignore and keep going
        }
        notified[t.id] = true;
      }
    }

    // ---- daily routines (Feed Enzo, wipe eyes, etc) ----
    let routineSent = 0;
    try {
      const rRaw = await redisCmd(["GET", "flow:routines"]);
      const routines = rRaw ? JSON.parse(rRaw) : [];
      for (const routine of routines) {
        for (const trig of routineTriggers(routine, now)) {
          const key = "routine:" + routine.id + ":" + trig.suffix;
          if (notified[key]) continue;
          if (trig.at > now) continue;               // not due yet today
          if (now - trig.at > 30 * 60 * 1000) {       // missed by >30min: skip silently
            notified[key] = true;
            continue;
          }
          try {
            await webpush.sendNotification(
              subscription,
              JSON.stringify({ title: trig.title, body: trig.body, tag: key })
            );
            routineSent++;
          } catch (e) {}
          notified[key] = true;
        }
      }
    } catch (e) {}

    // ---- fixtures ----
    let fixtureSent = 0;
    try {
      const fxRaw = await redisCmd(["GET", "flow:fixtures:v4"]);
      let fxData = null;
      try { fxData = fxRaw ? JSON.parse(fxRaw) : null; } catch (e) {}

      // refresh at most every 6h, piggybacking on this existing cron
      const sixHours = 6 * 60 * 60 * 1000;
      if (!fxData || !fxData.fetchedAt || now - fxData.fetchedAt > sixHours) {
        try { fxData = await refreshFixtures(); } catch (e) {}
      }

      const fixtures = (fxData && fxData.fixtures) || [];

      // Explicit per-fixture choices win. Anything the user hasn't touched
      // defaults to ON for the next 3 of each kind, OFF beyond that — so a
      // full 60-match season doesn't carpet-bomb him with reminders.
      let prefs = {};
      try {
        const prefRaw = await redisCmd(["GET", "flow:fxprefs"]);
        if (prefRaw) prefs = JSON.parse(prefRaw) || {};
      } catch (e) {}

      const rank = {};
      const seen = {};
      fixtures
        .slice()
        .sort((a, b) => new Date(a.startUTC) - new Date(b.startUTC))
        .forEach((f) => {
          seen[f.kind] = (seen[f.kind] || 0) + 1;
          rank[f.id] = seen[f.kind];
        });

      for (const fx of fixtures) {
        const explicit = prefs[fx.id];
        const enabled = explicit === undefined ? (rank[fx.id] || 99) <= 3 : !!explicit;
        if (!enabled) continue;

        for (const trig of reminderTriggers(fx)) {
          const key = fx.id + ":" + trig.suffix;
          if (notified[key]) continue;
          // fire only inside a 3h window, so a first deploy or an outage
          // doesn't dump a pile of long-past reminders
          if (trig.at > now || now - trig.at > 3 * 60 * 60 * 1000) {
            if (now - trig.at > 3 * 60 * 60 * 1000) notified[key] = true;
            continue;
          }
          try {
            await webpush.sendNotification(
              subscription,
              JSON.stringify({ title: trig.title, body: trig.body, tag: key })
            );
            fixtureSent++;
          } catch (e) {}
          notified[key] = true;
        }
      }
    } catch (e) {}

    await redisCmd(["SET", "flow:notified", JSON.stringify(notified)]);
    res.status(200).json({ ok: true, sent, fixtureSent, routineSent });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
