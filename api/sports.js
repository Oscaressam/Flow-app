// Fetches the next Liverpool FC fixture (all competitions) and the next UFC
// event from TheSportsDB, normalises them, and caches the result in Upstash.
//
// Free-tier note: the "next events" endpoints return exactly ONE event on the
// free key (premium returns 10-20). So this is deliberately a "what's next"
// feed, not a full season schedule. Refreshing daily keeps it current.

const TSDB_KEY = process.env.THESPORTSDB_KEY || "123"; // 123 = shared free key
const LIVERPOOL_TEAM_ID = "133602";
const UFC_LEAGUE_ID = "4443";
const CACHE_KEY = "flow:fixtures";
const BASE = "https://www.thesportsdb.com/api/v1/json/";

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

// TheSportsDB serves UTC. Build a real ISO instant so nothing downstream has to
// guess a timezone — this codebase has been bitten by naive datetimes before.
function toUTCISO(ev) {
  if (ev.strTimestamp) {
    const t = new Date(ev.strTimestamp.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(ev.strTimestamp) ? "" : "Z"));
    if (!isNaN(t.getTime())) return t.toISOString();
  }
  if (ev.dateEvent) {
    const time = (ev.strTime && ev.strTime !== "00:00:00") ? ev.strTime : "18:00:00";
    const t = new Date(ev.dateEvent + "T" + time + "Z");
    if (!isNaN(t.getTime())) return t.toISOString();
  }
  return null;
}

function normalise(ev, kind) {
  const startUTC = toUTCISO(ev);
  if (!startUTC) return null;

  let title;
  if (kind === "liverpool") {
    const home = ev.strHomeTeam || "";
    const away = ev.strAwayTeam || "";
    title = home && away ? home + " vs " + away : (ev.strEvent || "Liverpool match");
  } else {
    title = ev.strEvent || "UFC event";
  }

  return {
    id: "fx-" + kind + "-" + (ev.idEvent || startUTC),
    kind: kind,                                  // "liverpool" | "ufc"
    title: title,
    competition: ev.strLeague || (kind === "ufc" ? "UFC" : "Football"),
    venue: ev.strVenue || "",
    startUTC: startUTC,
    // only meaningful when TheSportsDB actually had a kickoff time
    timeKnown: !!(ev.strTimestamp || (ev.strTime && ev.strTime !== "00:00:00")),
  };
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "MindORG/1.0" } });
  if (!r.ok) throw new Error("upstream " + r.status);
  return r.json();
}

// exported so check-and-notify can reuse it
async function refreshFixtures() {
  const out = [];
  const errors = [];

  try {
    const d = await fetchJson(BASE + TSDB_KEY + "/eventsnext.php?id=" + LIVERPOOL_TEAM_ID);
    (d.events || []).forEach(function (ev) {
      const n = normalise(ev, "liverpool");
      if (n) out.push(n);
    });
  } catch (e) {
    errors.push("liverpool: " + String(e.message || e));
  }

  try {
    const d = await fetchJson(BASE + TSDB_KEY + "/eventsnextleague.php?id=" + UFC_LEAGUE_ID);
    (d.events || []).forEach(function (ev) {
      const n = normalise(ev, "ufc");
      if (n) out.push(n);
    });
  } catch (e) {
    errors.push("ufc: " + String(e.message || e));
  }

  out.sort(function (a, b) { return new Date(a.startUTC) - new Date(b.startUTC); });

  const payload = { fixtures: out, fetchedAt: Date.now(), errors: errors };

  // Never overwrite good data with an empty result (upstream hiccup / rate limit)
  if (out.length === 0) {
    const prevRaw = await redisCmd(["GET", CACHE_KEY]);
    if (prevRaw) {
      try {
        const prev = JSON.parse(prevRaw);
        if (prev.fixtures && prev.fixtures.length) {
          return { fixtures: prev.fixtures, fetchedAt: prev.fetchedAt, errors: errors, stale: true };
        }
      } catch (e) {}
    }
  }

  await redisCmd(["SET", CACHE_KEY, JSON.stringify(payload)]);
  return payload;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const cachedRaw = await redisCmd(["GET", CACHE_KEY]);
    let cached = null;
    try { cached = cachedRaw ? JSON.parse(cachedRaw) : null; } catch (e) {}

    const sixHours = 6 * 60 * 60 * 1000;
    const fresh = cached && cached.fetchedAt && Date.now() - cached.fetchedAt < sixHours;

    if (fresh && req.query.force !== "1") {
      res.status(200).json({ ...cached, cached: true });
      return;
    }

    const payload = await refreshFixtures();
    res.status(200).json({ ...payload, cached: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};

module.exports.refreshFixtures = refreshFixtures;
module.exports.CACHE_KEY = CACHE_KEY;
