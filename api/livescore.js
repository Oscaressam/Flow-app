// Liverpool-only live score. Cached briefly (60s) since, unlike everything
// else in this app, this is meant to actually be live.
//
// NOT verified with a direct fetch — my tool couldn't get through to this
// specific URL — but the shape (events[].competitions[0].status.type.state
// + competitors[].score) is confirmed by multiple independent sources for
// this exact ESPN API family, including one showing the identical structure
// for a different sport. Built defensively: any mismatch degrades to
// { live: false } rather than breaking, so the client just keeps showing
// its existing countdown/"LIVE NOW" text — zero regression either way.

const CACHE_KEY = "flow:livescore:v1";
const TTL_SECONDS = 60;
const LIVERPOOL_ID = "364";

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

function pick(obj, path, fallback) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[key];
  }
  return cur === undefined || cur === null ? fallback : cur;
}

async function fetchLiveScore() {
  const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard", {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error("espn " + r.status);
  const data = await r.json();
  const events = data.events || [];

  for (const ev of events) {
    const comp = pick(ev, ["competitions", 0], null);
    if (!comp) continue;
    const competitors = comp.competitors || [];
    const mine = competitors.find(function (c) { return String(pick(c, ["team", "id"], "")) === LIVERPOOL_ID; });
    if (!mine) continue;

    const opp = competitors.find(function (c) { return c !== mine; });
    const state = pick(comp, ["status", "type", "state"], ""); // "pre" | "in" | "post"

    return {
      live: state === "in",
      final: state === "post",
      statusText: pick(comp, ["status", "type", "shortDetail"], "") || pick(comp, ["status", "type", "description"], ""),
      myScore: mine.score || "0",
      oppScore: (opp && opp.score) || "0",
      oppName: pick(opp, ["team", "shortDisplayName"], "") || pick(opp, ["team", "displayName"], ""),
      isHome: mine.homeAway === "home",
    };
  }
  return { live: false, notFound: true };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const cached = await redisCmd(["GET", CACHE_KEY]);
    if (cached && req.query.force !== "1") {
      const parsed = JSON.parse(cached);
      if (Date.now() - parsed.fetchedAt < TTL_SECONDS * 1000) {
        res.status(200).json({ ...parsed, cached: true });
        return;
      }
    }
  } catch (e) {}

  let payload;
  try {
    payload = await fetchLiveScore();
  } catch (err) {
    payload = { live: false, error: String(err.message || err) };
  }
  payload.fetchedAt = Date.now();

  try { await redisCmd(["SET", CACHE_KEY, JSON.stringify(payload), "EX", TTL_SECONDS]); } catch (e) {}
  res.status(200).json({ ...payload, cached: false });
};
