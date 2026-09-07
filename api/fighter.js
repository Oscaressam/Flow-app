// A fighter's last completed fight, with the detailed strike/takedown
// breakdown ESPN's core API tracks per bout.
//
// VERIFIED live (2026-09-07): the event -> competitions -> competitor ->
// statistics chain is real and returns genuinely detailed data (confirmed
// against Blaydes vs Pavlovich, UFC Fight Night 2023-04-22: 36/85 significant
// strikes, 1 knockdown, full strike-by-target breakdown). Competitor id
// equals athlete id in MMA (unlike team sports), confirmed on that same fight.
//
// NOT verified: the exact shape of an athlete's event-history list, which is
// needed to find "their most recent fight" starting from just an athlete id.
// I could not get a fetch through to that specific endpoint to confirm its
// shape before shipping. Parsing below tries the documented conventions and
// degrades to a clear "not available" message rather than guessing wrong —
// if it comes back empty in production, that endpoint's real shape is the
// first thing to check against the actual response.

const CACHE_PREFIX = "flow:fighter:v2:"; // v2: switched from the 400-erroring /events guess to gamelog
const TTL_SECONDS = 60 * 60 * 12;

async function redisCmd(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  return (await r.json()).result;
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(url.split("?")[0] + " -> " + r.status);
  return r.json();
}

function pick(obj, path, fallback) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[key];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

function fixRef(ref) {
  return String(ref || "").replace("sports.core.api.espn.pvt", "sports.core.api.espn.com")
                          .replace(/^http:/, "https:");
}

const STAT_MAP = [
  ["knockDowns", "Knockdowns"],
  ["sigStrikesLanded", "Sig. strikes landed"],
  ["sigStrikesAttempted", "Sig. strikes attempted"],
  ["takedownsLanded", "Takedowns landed"],
  ["takedownsAttempted", "Takedowns attempted"],
  ["submissions", "Submission attempts"],
  ["timeInControl", "Control time (s)"],
];

function extractStats(statPayload) {
  const cats = pick(statPayload, ["splits", "categories"], []) || [];
  const flat = {};
  cats.forEach(function (c) {
    (c.stats || []).forEach(function (s) { flat[s.name] = s.value; });
  });
  return STAT_MAP
    .map(function (m) { return { key: m[0], label: m[1], value: flat[m[0]] }; })
    .filter(function (x) { return x.value !== undefined; });
}

async function findLastFight(athleteId) {
  // First attempt (/v2/sports/mma/athletes/{id}/events) returned a live 400 —
  // confirmed wrong, not just unverified. Trying the common v3 "gamelog"
  // pattern instead: confirmed to exist for other sports (an NFL gamelog URL
  // in this exact shape shows up in ESPN API bug reports), but MMA's actual
  // response shape is still unconfirmed — parsed defensively across a few
  // plausible layouts rather than assumed.
  const list = await getJson(
    "https://site.web.api.espn.com/apis/common/v3/sports/mma/ufc/athletes/" + athleteId + "/gamelog"
  );

  // try several plausible shapes for where the per-fight entries live
  let rawEvents = [];
  if (Array.isArray(list.events)) {
    rawEvents = list.events;
  } else if (list.events && typeof list.events === "object") {
    rawEvents = Object.values(list.events);
  } else if (Array.isArray(list.seasonTypes)) {
    list.seasonTypes.forEach(function (st) {
      (st.categories || []).forEach(function (cat) {
        (cat.events || []).forEach(function (e) { rawEvents.push(e); });
      });
    });
  }
  if (!rawEvents.length) throw new Error("no gamelog entries found");

  // Resolve each to a real event object if it's a bare ref; otherwise use
  // whatever date-bearing fields are already embedded.
  const resolved = await Promise.allSettled(
    rawEvents.map(function (it) {
      if (it && (it.date || it.eventDate)) return Promise.resolve(it);
      const ref = it && (it.$ref || (it.event && it.event.$ref));
      return ref ? getJson(fixRef(ref)) : Promise.reject(new Error("no ref"));
    })
  );
  const events = resolved
    .filter(function (r) { return r.status === "fulfilled"; })
    .map(function (r) { return r.value; })
    .filter(function (e) {
      const d = e && (e.date || e.eventDate);
      return d && new Date(d).getTime() < Date.now();
    })
    .sort(function (a, b) {
      return new Date(b.date || b.eventDate) - new Date(a.date || a.eventDate);
    });

  if (!events.length) throw new Error("gamelog returned no past events");
  return events[0];
}

async function fetchLastFightStats(athleteId) {
  const event = await findLastFight(athleteId);

  // Gamelog rows on other sports sometimes carry the opponent/result/stats
  // directly on the row, with no need for the deeper competitions chain.
  // Try that first since it's cheaper and more likely correct for a
  // purpose-built "gamelog" resource; only fall back to walking
  // competitions -> competitors -> statistics if this looks like a bare
  // core-API event object instead.
  if (event.opponent || event.stats) {
    return {
      eventName: event.name || event.eventName || "",
      date: event.date || event.eventDate || "",
      won: event.result === "W" || event.won === true,
      opponent: (event.opponent && (event.opponent.displayName || event.opponent.name)) || event.opponent || "",
      stats: Array.isArray(event.stats)
        ? event.stats.map(function (s) { return { key: s.name || s.abbreviation, label: s.displayName || s.label || s.name, value: s.value }; })
            .filter(function (s) { return s.value !== undefined; })
        : [],
    };
  }

  if (!Array.isArray(event.competitions)) {
    throw new Error("gamelog row had neither embedded stats nor a competitions list");
  }

  const comps = event.competitions;
  let mine = null, oppRef = null, competitionId = null;
  for (const c of comps) {
    const cs = c.competitors || [];
    const self = cs.find(function (x) { return String(x.id) === String(athleteId); });
    if (self) {
      mine = self;
      competitionId = c.id;
      oppRef = cs.find(function (x) { return String(x.id) !== String(athleteId); });
      break;
    }
  }
  if (!mine) throw new Error("athlete not found in their own most recent event");

  const [statData, oppData] = await Promise.all([
    getJson(fixRef(pick(mine, ["statistics", "$ref"], ""))).catch(function () { return null; }),
    oppRef ? getJson(fixRef(pick(oppRef, ["athlete", "$ref"], ""))).catch(function () { return null; }) : null,
  ]);

  return {
    eventName: event.name || "",
    date: event.date || "",
    won: !!mine.winner,
    opponent: oppData ? (oppData.displayName || oppData.fullName || "") : "",
    stats: statData ? extractStats(statData) : [],
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const athleteId = String(req.query.id || "").replace(/[^0-9]/g, "");
  if (!athleteId) { res.status(400).json({ error: "missing id" }); return; }

  const cacheKey = CACHE_PREFIX + athleteId;
  try {
    const cached = await redisCmd(["GET", cacheKey]);
    if (cached && req.query.force !== "1") {
      res.status(200).json({ ...JSON.parse(cached), cached: true });
      return;
    }
  } catch (e) {}

  let payload = {};
  try {
    payload = await fetchLastFightStats(athleteId);
  } catch (err) {
    payload = { error: String(err.message || err) };
  }

  payload.fetchedAt = Date.now();
  try { await redisCmd(["SET", cacheKey, JSON.stringify(payload), "EX", TTL_SECONDS]); } catch (e) {}
  res.status(200).json({ ...payload, cached: false });
};
