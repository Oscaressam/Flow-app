// League-wide stats, independent of any single fixture: the Premier League
// table and UFC divisional rankings. Cached in Upstash for 6h.
//
// Standings endpoint is verified live (2026-09-07): /apis/v2/.../standings
// returns the full 20-team table. Rankings is NOT verified the same way —
// third-party tools reference it consistently but I couldn't get a direct
// fetch of the raw response during development, so it's wired defensively:
// if it 404s or its shape doesn't match, the client gets a clean
// "unavailable" message instead of breaking.

const CACHE_PREFIX = "flow:stats:v6:"; // v3: table now returns multiple competitions, not one flat row list
const TTL_SECONDS = 60 * 60 * 6;

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

function statVal(stats, name) {
  const s = (stats || []).find(function (x) { return x.name === name; });
  return s ? s.displayValue : "";
}

// ---------------- League tables ----------------
// Liverpool play two competitions with an actual standings table: the
// Premier League (eng.1) and the Champions League's 36-team league phase
// (uefa.champions, since the 2024-25 format change). Both fetched the same
// way and shown as two sections in one Table view.
const TABLE_COMPETITIONS = [
  { slug: "eng.1", label: "Premier League" },
  { slug: "uefa.champions", label: "Champions League" },
];

async function fetchOneTable(slug) {
  const data = await getJson("https://site.api.espn.com/apis/v2/sports/soccer/" + slug + "/standings");
  const entries = pick(data, ["children", 0, "standings", "entries"], []) || [];

  return entries.map(function (e) {
    const team = e.team || {};
    return {
      teamId: String(team.id || ""),
      name: team.shortDisplayName || team.displayName || "",
      crest: pick(team, ["logos", 0, "href"], ""),
      rank: parseInt(statVal(e.stats, "rank"), 10) || 0,
      played: statVal(e.stats, "gamesPlayed"),
      won: statVal(e.stats, "wins"),
      drawn: statVal(e.stats, "ties"),
      lost: statVal(e.stats, "losses"),
      gd: statVal(e.stats, "pointDifferential"),
      points: statVal(e.stats, "points"),
      note: pick(e, ["note", "description"], ""),
      noteColor: pick(e, ["note", "color"], ""),
    };
  }).sort(function (a, b) { return a.rank - b.rank; });
}

async function fetchTable() {
  const results = await Promise.allSettled(
    TABLE_COMPETITIONS.map(function (c) { return fetchOneTable(c.slug); })
  );
  const competitions = TABLE_COMPETITIONS
    .map(function (c, i) {
      const r = results[i];
      return r.status === "fulfilled" && r.value.length
        ? { name: c.label, rows: r.value }
        : null;
    })
    .filter(Boolean);

  if (!competitions.length) throw new Error("no tables available");
  return { competitions: competitions };
}

// ---------------- UFC rankings ----------------
const WEIGHT_CLASSES = [
  "Men's Pound-for-Pound", "Heavyweight", "Light Heavyweight", "Middleweight",
  "Welterweight", "Lightweight", "Featherweight", "Bantamweight", "Flyweight",
  "Women's Pound-for-Pound", "Women's Bantamweight", "Women's Flyweight", "Women's Strawweight",
];

function parseRankings(data) {
  // Shape is unconfirmed, so try a few plausible layouts rather than
  // assuming one. Each division may live under `rankings`, `divisions`,
  // or directly as a top-level array.
  const groups = data.rankings || data.divisions || (Array.isArray(data) ? data : []);
  if (!Array.isArray(groups) || groups.length === 0) return null;

  const divisions = groups.map(function (g) {
    const name = g.name || g.displayName || g.weightClass || "";
    const list = g.ranks || g.athletes || g.rankings || [];
    const fighters = list.slice(0, 16).map(function (r) {
      const a = r.athlete || r;
      var rec = pick(a, ["record", "summary"], "") || r.record || "";
      if (rec && typeof rec === "object") rec = rec.summary || "";
      return {
        rank: r.rank || r.current || 0,
        name: a.displayName || a.fullName || a.name || "",
        record: rec,
        country: pick(a, ["flag", "alt"], ""),
      };
    }).filter(function (f) { return f.name; });
    return { name: name, fighters: fighters };
  }).filter(function (d) { return d.name && d.fighters.length; });

  return divisions.length ? divisions : null;
}

// DISABLED (verified live 2026-09-07): the endpoint responds 200 with valid
// JSON, but the content is years stale — it still listed Kamaru Usman,
// Israel Adesanya, and Francis Ngannou as reigning champions, all of whom
// lost their belts (or left the UFC) back in 2022/2023. Every fighter's
// record/country also came back empty. This isn't a shape mismatch to fix;
// ESPN appears to have stopped maintaining MMA rankings after losing UFC
// broadcast rights. Showing it would be actively misleading, so it's kept
// off rather than parsed. fetchRankingsRaw() is left intact in case ESPN
// ever refreshes this data — check it again before re-enabling.
async function fetchRankings() {
  throw new Error(
    "UFC rankings are disabled: ESPN's data here is several years out of date " +
    "(still lists Usman/Adesanya/Ngannou as champions) rather than merely broken."
  );
}

async function fetchRankingsRaw() {
  const data = await getJson("https://site.api.espn.com/apis/site/v2/sports/mma/ufc/rankings");
  const divisions = parseRankings(data);
  if (!divisions) throw new Error("unrecognized rankings shape");
  return { divisions: divisions };
}

// ---------------- Liverpool squad ----------------
// Real season stats come inline in the roster payload — no per-player
// follow-up call needed. Verified live 2026-09-07 against the actual
// 2026-27 response: appearances, goals, assists, cards, shots, and
// goalkeeper saves/goals-conceded are all present.
//
// One quirk: a player with 0 appearances sometimes has NO `statistics` key
// at all (not even zeros) — e.g. a keeper who hasn't played this season.
// Every stat lookup below defaults to 0 rather than assuming the block exists.
function findStat(categories, name) {
  for (const cat of categories || []) {
    const s = (cat.stats || []).find(function (x) { return x.name === name; });
    if (s) return s.value;
  }
  return 0;
}

async function fetchSquad() {
  const data = await getJson("https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/364/roster");
  const athletes = data.athletes || [];

  const players = athletes.map(function (a) {
    const cats = pick(a, ["statistics", "splits", "categories"], []);
    return {
      id: a.id,
      name: a.displayName || a.fullName || "",
      shortName: a.shortName || "",
      jersey: a.jersey || "",
      position: pick(a, ["position", "abbreviation"], ""),
      positionName: pick(a, ["position", "displayName"], ""),
      age: a.age || null,
      country: pick(a, ["flag", "alt"], ""),
      flag: pick(a, ["flag", "href"], ""),
      appearances: findStat(cats, "appearances"),
      goals: findStat(cats, "totalGoals"),
      assists: findStat(cats, "goalAssists"),
      shots: findStat(cats, "totalShots"),
      yellowCards: findStat(cats, "yellowCards"),
      redCards: findStat(cats, "redCards"),
      saves: findStat(cats, "saves"),
      goalsConceded: findStat(cats, "goalsConceded"),
    };
  });

  const order = { Goalkeeper: 0, Defender: 1, Midfielder: 2, Forward: 3 };
  players.sort(function (x, y) {
    const oa = order[x.positionName] !== undefined ? order[x.positionName] : 9;
    const ob = order[y.positionName] !== undefined ? order[y.positionName] : 9;
    if (oa !== ob) return oa - ob;
    return (y.appearances || 0) - (x.appearances || 0);
  });

  if (!players.length) throw new Error("empty roster");
  return { players: players, seasonName: pick(data, ["season", "displayName"], "") };
}

// ---------------- UFC news ----------------
// Verified live (2026-09-07): simple flat structure, no multi-hop chains
// needed. Real current articles confirmed.
async function fetchNews() {
  const data = await getJson("https://site.api.espn.com/apis/site/v2/sports/mma/ufc/news");
  const articles = (data.articles || []).map(function (a) {
    const img = (a.images || [])[0];
    return {
      id: a.id,
      headline: a.headline || "",
      description: a.description || "",
      published: a.published || a.lastModified || "",
      image: (img && img.url) || "",
      link: pick(a, ["links", "web", "href"], ""),
      byline: a.byline || "",
    };
  }).filter(function (a) { return a.headline && a.link; });

  if (!articles.length) throw new Error("no articles returned");
  return { articles: articles.slice(0, 20) };
}

// ---------------- UFC recent results ----------------
// Reuses the exact calendar + core-API resolution pattern already verified
// live for the upcoming schedule and fight card — just pointed at the past
// instead of the future. Confirmed elements: the calendar's event $ref
// yields a numeric id; that id's core event object has competitions with a
// `winner` boolean and athlete $ref links; matchNumber 1 is the headliner.
const UFC_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard";
const UFC_EXCLUDE_RE = /contender series/i;

function fixRefUfc(ref) {
  return String(ref || "").replace("sports.core.api.espn.pvt", "sports.core.api.espn.com")
                          .replace(/^http:/, "https:");
}

async function fetchPastUfcEventIds(limit) {
  const data = await getJson(UFC_SCOREBOARD_URL);
  const calendar = pick(data, ["leagues", 0, "calendar"], []) || [];
  const now = Date.now();

  return calendar
    .filter(function (c) {
      if (!c || !c.startDate || !c.label || UFC_EXCLUDE_RE.test(c.label)) return false;
      const t = new Date(c.startDate).getTime();
      return !isNaN(t) && t < now - 4 * 60 * 60 * 1000; // finished a while ago
    })
    .map(function (c) {
      const ref = pick(c, ["event", "$ref"], "");
      const m = ref.match(/events\/(\d+)/);
      return m ? { id: m[1], label: c.label, date: c.startDate } : null;
    })
    .filter(Boolean)
    .sort(function (a, b) { return new Date(b.date) - new Date(a.date); })
    .slice(0, limit || 5);
}

async function fetchMainEventResult(eventStub) {
  const ev = await getJson("https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/" + eventStub.id);
  const comps = Array.isArray(ev.competitions) ? ev.competitions : [];
  const main = comps.find(function (c) { return c.matchNumber === 1; }) || comps[comps.length - 1];
  if (!main) return null;

  const cs = (main.competitors || []).slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  if (cs.length < 2) return null;

  const names = await Promise.allSettled(
    cs.map(function (c) { return getJson(fixRefUfc(pick(c, ["athlete", "$ref"], ""))); })
  );

  const side = function (i) {
    const n = names[i];
    return n.status === "fulfilled" ? (n.value.displayName || n.value.fullName || "") : "";
  };
  const winnerIdx = cs.findIndex(function (c) { return c.winner === true; });

  return {
    label: eventStub.label,
    date: eventStub.date,
    weight: pick(main, ["type", "text"], ""),
    winner: winnerIdx !== -1 ? side(winnerIdx) : "",
    loser: winnerIdx !== -1 ? side(winnerIdx === 0 ? 1 : 0) : "",
    fighterA: side(0),
    fighterB: side(1),
  };
}

// Caps how many requests fire at once. A tap on "Results" used to fan out
// to up to 15 concurrent, unthrottled requests against an unofficial,
// unauthenticated ESPN endpoint (5 events in parallel, each spawning 2
// parallel fighter lookups the moment its own event fetch resolved) — the
// kind of burst that gets an IP soft-blocked with no warning. Processing in
// small batches trades a bit of latency for being a much better citizen of
// an API that owes us nothing.
async function mapBatched(items, batchSize, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fn));
    out.push.apply(out, settled);
  }
  return out;
}

async function fetchResults() {
  const stubs = await fetchPastUfcEventIds(3); // was 5 — fewer events, smaller burst
  if (!stubs.length) throw new Error("no past events found in calendar");

  const settled = await mapBatched(stubs, 2, fetchMainEventResult); // 2 events at a time
  const results = settled
    .filter(function (r) { return r.status === "fulfilled" && r.value; })
    .map(function (r) { return r.value; })
    .filter(function (r) { return r.fighterA && r.fighterB; });

  if (!results.length) throw new Error("resolved zero results from past events");
  return { results: results };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const kind = ["rankings", "squad", "news", "results"].indexOf(req.query.kind) !== -1 ? req.query.kind : "table";
  const cacheKey = CACHE_PREFIX + kind;

  try {
    const cached = await redisCmd(["GET", cacheKey]);
    if (cached && req.query.force !== "1") {
      res.status(200).json({ ...JSON.parse(cached), cached: true });
      return;
    }
  } catch (e) {}

  let payload = { kind: kind };
  try {
    if (kind === "rankings") payload = Object.assign(payload, await fetchRankings());
    else if (kind === "squad") payload = Object.assign(payload, await fetchSquad());
    else if (kind === "news") payload = Object.assign(payload, await fetchNews());
    else if (kind === "results") payload = Object.assign(payload, await fetchResults());
    else payload = Object.assign(payload, await fetchTable());
  } catch (err) {
    payload.error = String(err.message || err);
  }

  payload.fetchedAt = Date.now();
  try { await redisCmd(["SET", cacheKey, JSON.stringify(payload), "EX", TTL_SECONDS]); } catch (e) {}
  res.status(200).json({ ...payload, cached: false });
};
