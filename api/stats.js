// League-wide stats, independent of any single fixture: the Premier League
// table and UFC divisional rankings. Cached in Upstash for 6h.
//
// Standings endpoint is verified live (2026-09-07): /apis/v2/.../standings
// returns the full 20-team table. Rankings is NOT verified the same way —
// third-party tools reference it consistently but I couldn't get a direct
// fetch of the raw response during development, so it's wired defensively:
// if it 404s or its shape doesn't match, the client gets a clean
// "unavailable" message instead of breaking.

const CACHE_PREFIX = "flow:stats:v3:"; // v3: table now returns multiple competitions, not one flat row list
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

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const kind = req.query.kind === "rankings" ? "rankings" : "table";
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
    payload = Object.assign(payload, kind === "rankings" ? await fetchRankings() : await fetchTable());
  } catch (err) {
    payload.error = String(err.message || err);
  }

  payload.fetchedAt = Date.now();
  try { await redisCmd(["SET", cacheKey, JSON.stringify(payload), "EX", TTL_SECONDS]); } catch (e) {}
  res.status(200).json({ ...payload, cached: false });
};
