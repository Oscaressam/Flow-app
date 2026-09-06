// Fetches the next Liverpool FC fixture (all competitions) and the next UFC
// event from TheSportsDB, normalises them, and caches the result in Upstash.
//
// Free-tier note: the "next events" endpoints return exactly ONE event on the
// free key (premium returns 10-20). So this is deliberately a "what's next"
// feed, not a full season schedule. Refreshing daily keeps it current.

const TSDB_KEY = process.env.THESPORTSDB_KEY || "123"; // 123 = shared free key
const LIVERPOOL_TEAM_ID = "133602";        // TheSportsDB (fallback)
const FD_KEY = process.env.FOOTBALL_DATA_KEY || "";
const FD_LIVERPOOL_ID = "64";              // football-data.org team id
// football-data.org free tier covers 12 competitions — PL and UCL included,
// FA Cup / Carabao Cup are NOT. Those fixtures simply won't appear.
const FD_URL = "https://api.football-data.org/v4/teams/" + FD_LIVERPOOL_ID +
  "/matches?status=SCHEDULED";
// ESPN's `soccer/all` scope covers every competition Liverpool play — league,
// Europe, domestic cups and friendlies — with club badges, and needs no key.
// Undocumented, so football-data and TheSportsDB stay wired as fallbacks.
const ESPN_LFC_URL =
  "https://site.web.api.espn.com/apis/site/v2/sports/soccer/all/teams/364/schedule?fixture=true";
const UFC_LEAGUE_ID = "4443";              // TheSportsDB (fallback)
// ESPN's public MMA endpoint. Undocumented but keyless, and its `calendar`
// array carries the whole season. Not a supported contract — if ESPN changes
// or blocks it, the TheSportsDB fallback below still returns the next event.
const ESPN_UFC_URL = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard";
// Contender Series are prospect tryout shows, not main UFC cards.
const UFC_EXCLUDE = /contender series/i;
const UFC_MARK = "https://a.espncdn.com/i/teamlogos/leagues/500/ufc.png";
const CACHE_KEY = "flow:fixtures:v3";
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




// The scoreboard's `events` array carries the full fight card for whichever
// event is currently nearest: fighters, country flags, records, weight classes,
// venue and broadcaster. Future events only ever get a label + start time
// (the ?dates= param is ignored by this endpoint), so this enriches one event.
function buildFightCard(evt) {
  const comps = (evt && evt.competitions) || [];
  const fights = comps.map(function (c) {
    const cs = (c.competitors || []).slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });
    const side = function (x) {
      const a = (x && x.athlete) || {};
      const rec = ((x && x.records) || [])[0];
      return {
        name: a.displayName || a.fullName || "",
        shortName: a.shortName || "",
        flag: (a.flag && a.flag.href) || "",
        country: (a.flag && a.flag.alt) || "",
        record: (rec && rec.summary) || "",
      };
    };
    return {
      weight: (c.type && c.type.abbreviation) || "",
      // championship and main-event bouts are scheduled for 5 rounds
      isMain: !!(c.format && c.format.regulation && c.format.regulation.periods === 5),
      startUTC: c.startDate ? new Date(c.startDate).toISOString() : null,
      a: cs[0] ? side(cs[0]) : null,
      b: cs[1] ? side(cs[1]) : null,
    };
  }).filter(function (f) { return f.a && f.b && f.a.name && f.b.name; });

  if (fights.length === 0) return null;

  // ESPN lists prelims first; the headliner is the 5-rounder, else the last bout
  let mainIdx = fights.map(function (f) { return f.isMain; }).lastIndexOf(true);
  if (mainIdx === -1) mainIdx = fights.length - 1;
  const main = fights[mainIdx];

  const venueObj = (comps[0] && comps[0].venue) || {};
  const addr = venueObj.address || {};

  return {
    main: main,
    fights: fights.slice().reverse(),   // headliner first
    fightCount: fights.length,
    venue: venueObj.fullName || "",
    city: [addr.city, addr.country].filter(Boolean).join(", "),
    broadcast: (evt.competitions && evt.competitions[0] && evt.competitions[0].broadcast) || "",
  };
}

// Full UFC season from ESPN's calendar array.
async function fetchUfcFull() {
  const r = await fetch(ESPN_UFC_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("espn " + r.status);
  const data = await r.json();
  const league = (data.leagues || [])[0];
  const calendar = (league && league.calendar) || [];
  const now = Date.now();

  // map detailed events by id so we can attach a card to the right fixture
  const detailById = {};
  (data.events || []).forEach(function (evt) {
    if (!evt || !evt.id) return;
    const card = buildFightCard(evt);
    if (card) detailById[String(evt.id)] = card;
  });

  return calendar
    .filter(function (c) {
      if (!c || !c.startDate || !c.label) return false;
      if (UFC_EXCLUDE.test(c.label)) return false;
      const t = new Date(c.startDate).getTime();
      // keep anything not yet finished (4h grace for a card in progress)
      return !isNaN(t) && t > now - 4 * 60 * 60 * 1000;
    })
    .map(function (c) {
      // the calendar's startDate tracks the main card, not the prelims
      const iso = new Date(c.startDate).toISOString();
      let id = "fx-ufc-espn-" + iso;
      let espnId = null;
      const ref = c.event && c.event.$ref;
      const m = ref && ref.match(/events\/(\d+)/);
      if (m) { espnId = m[1]; id = "fx-ufc-espn-" + m[1]; }
      const card = espnId ? detailById[espnId] : null;
      return {
        id: id,
        espnId: espnId || "",
        kind: "ufc",
        title: c.label,
        competition: "UFC",
        venue: (card && card.venue) || "",
        city: (card && card.city) || "",
        broadcast: (card && card.broadcast) || "",
        startUTC: iso,
        timeKnown: true,
        mark: UFC_MARK,
        card: card || null,
      };
    });
}


async function fetchLiverpoolESPN() {
  const r = await fetch(ESPN_LFC_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("espn soccer " + r.status);
  const data = await r.json();
  const now = Date.now();

  return (data.events || []).map(function (ev) {
    const comp = (ev.competitions || [])[0];
    if (!comp || !ev.date) return null;
    const t = new Date(ev.date).getTime();
    if (isNaN(t) || t < now - 4 * 60 * 60 * 1000) return null;

    const cs = comp.competitors || [];
    const home = cs.filter(function (c) { return c.homeAway === "home"; })[0];
    const away = cs.filter(function (c) { return c.homeAway === "away"; })[0];
    if (!home || !away) return null;

    const nameOf = function (c) {
      return (c.team && (c.team.shortDisplayName || c.team.displayName)) || "";
    };
    const crestOf = function (c) {
      const logos = (c.team && c.team.logos) || [];
      const def = logos.filter(function (l) {
        return (l.rel || []).indexOf("default") !== -1;
      })[0];
      return (def && def.href) || (logos[0] && logos[0].href) || "";
    };

    const venue = comp.venue || {};
    const addr = venue.address || {};

    return {
      id: "fx-liverpool-espn-" + ev.id,
      espnId: String(ev.id),
      leagueSlug: (ev.league && ev.league.slug) || "eng.1",
      homeId: (home.team && String(home.team.id)) || "",
      awayId: (away.team && String(away.team.id)) || "",
      homeName: nameOf(home),
      awayName: nameOf(away),
      kind: "liverpool",
      title: nameOf(home) + " vs " + nameOf(away),
      competition: (ev.league && ev.league.name) || (ev.season && ev.season.displayName) || "Football",
      venue: venue.fullName || "",
      city: [addr.city, addr.country].filter(Boolean).join(", "),
      broadcast: (comp.broadcasts && comp.broadcasts[0] && comp.broadcasts[0].media &&
                  comp.broadcasts[0].media.shortName) || "",
      homeCrest: crestOf(home),
      awayCrest: crestOf(away),
      startUTC: new Date(ev.date).toISOString(),
      // ESPN flags a confirmed kickoff with timeValid
      timeKnown: comp.timeValid !== false,
    };
  }).filter(Boolean);
}

// Full Liverpool schedule (Premier League + Champions League) from
// football-data.org. Returns [] if no key is configured so the caller
// can fall back to TheSportsDB's single next fixture.
async function fetchLiverpoolFull() {
  if (!FD_KEY) return [];
  const r = await fetch(FD_URL, { headers: { "X-Auth-Token": FD_KEY } });
  if (!r.ok) throw new Error("football-data " + r.status);
  const data = await r.json();
  const matches = data.matches || [];
  return matches.map(function (m) {
    const home = (m.homeTeam && (m.homeTeam.shortName || m.homeTeam.name)) || "";
    const away = (m.awayTeam && (m.awayTeam.shortName || m.awayTeam.name)) || "";
    return {
      id: "fx-liverpool-fd-" + m.id,
      kind: "liverpool",
      title: home && away ? home + " vs " + away : "Liverpool match",
      competition: (m.competition && m.competition.name) || "Football",
      venue: "",
      // real club crests, served by football-data
      homeCrest: (m.homeTeam && m.homeTeam.crest) || "",
      awayCrest: (m.awayTeam && m.awayTeam.crest) || "",
      compEmblem: (m.competition && m.competition.emblem) || "",
      startUTC: new Date(m.utcDate).toISOString(),
      // football-data marks unconfirmed kickoffs with a midnight UTC time
      timeKnown: !!m.utcDate && !/T00:00:00/.test(m.utcDate),
    };
  }).filter(function (f) { return !isNaN(new Date(f.startUTC).getTime()); });
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

  let gotFull = false;

  // 1st choice: ESPN — all competitions, no key required
  try {
    const espn = await fetchLiverpoolESPN();
    if (espn.length) {
      espn.forEach(function (f) { out.push(f); });
      gotFull = true;
    }
  } catch (e) {
    errors.push("espn soccer: " + String(e.message || e));
  }

  // 2nd choice: football-data (needs a key, no domestic cups)
  if (!gotFull) {
    try {
      const full = await fetchLiverpoolFull();
      if (full.length) {
        full.forEach(function (f) { out.push(f); });
        gotFull = true;
      }
    } catch (e) {
      errors.push("football-data: " + String(e.message || e));
    }
  }

  // fallback: TheSportsDB gives one next fixture, better than nothing
  if (!gotFull) {
    try {
      const d = await fetchJson(BASE + TSDB_KEY + "/eventsnext.php?id=" + LIVERPOOL_TEAM_ID);
      (d.events || []).forEach(function (ev) {
        const n = normalise(ev, "liverpool");
        if (n) out.push(n);
      });
    } catch (e) {
      errors.push("liverpool fallback: " + String(e.message || e));
    }
  }

  let gotUfcFull = false;
  try {
    const ufc = await fetchUfcFull();
    if (ufc.length) {
      ufc.forEach(function (f) { out.push(f); });
      gotUfcFull = true;
    }
  } catch (e) {
    errors.push("espn: " + String(e.message || e));
  }

  if (!gotUfcFull) {
    try {
      const d = await fetchJson(BASE + TSDB_KEY + "/eventsnextleague.php?id=" + UFC_LEAGUE_ID);
      (d.events || []).forEach(function (ev) {
        const n = normalise(ev, "ufc");
        if (n) out.push(n);
      });
    } catch (e) {
      errors.push("ufc fallback: " + String(e.message || e));
    }
  }

  out.sort(function (a, b) { return new Date(a.startUTC) - new Date(b.startUTC); });

  const payload = { fixtures: out, fetchedAt: Date.now(), errors: errors, fullSchedule: gotFull, fullUfc: gotUfcFull };

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
