// Per-event detail, fetched on demand when a fixture is tapped.
//
// UFC      -> the full fight card for that specific event
// Football -> injuries (team news), recent form, head-to-head, venue
//
// Every ESPN shape here is undocumented, so all parsing is defensive: a
// missing branch yields an empty section rather than a failed request.

const CACHE_PREFIX = "flow:evt:v2:";
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

// ---------------- UFC ----------------
// The site-API `summary?event=` route 404s for MMA, so use the core API's
// event object. It returns every bout inline (weight class, cardSegment,
// round format) but athletes are $ref links, so those are resolved in
// parallel afterwards.
const UFC_EVENT_URL = "https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events/";

function fixRef(ref) {
  return String(ref || "").replace("sports.core.api.espn.pvt", "sports.core.api.espn.com")
                          .replace(/^http:/, "https:");
}

async function fetchUfcCard(id) {
  const ev = await getJson(UFC_EVENT_URL + id);
  const comps = Array.isArray(ev.competitions) ? ev.competitions : [];

  // gather every athlete ref once, de-duplicated
  const refs = {};
  comps.forEach(function (c) {
    (c.competitors || []).forEach(function (x) {
      const r = fixRef(pick(x, ["athlete", "$ref"], ""));
      if (r) refs[x.id] = r;
    });
  });

  const ids = Object.keys(refs).slice(0, 40);   // hard cap; a card is ~26
  const people = {};
  const settled = await Promise.allSettled(
    ids.map(function (aid) { return getJson(refs[aid]); })
  );
  settled.forEach(function (res, i) {
    if (res.status !== "fulfilled") return;
    const a = res.value || {};
    people[ids[i]] = {
      name: a.displayName || a.fullName || a.shortName || "",
      flag: pick(a, ["flag", "href"], ""),
      country: pick(a, ["flag", "alt"], ""),
      headshot: pick(a, ["headshot", "href"], ""),
      nickname: a.nickname || "",
    };
  });

  const bouts = comps.map(function (c) {
    const cs = (c.competitors || []).slice().sort(function (a, b) {
      return (a.order || 0) - (b.order || 0);
    });
    if (cs.length < 2) return null;
    const a = people[cs[0].id] || { name: "" };
    const b = people[cs[1].id] || { name: "" };
    if (!a.name || !b.name) return null;
    return {
      weight: pick(c, ["type", "text"], "") || pick(c, ["type", "abbreviation"], ""),
      segment: pick(c, ["cardSegment", "description"], ""),
      order: c.matchNumber || 0,
      isMain: pick(c, ["format", "regulation", "periods"], 3) === 5,
      rounds: pick(c, ["format", "regulation", "periods"], null),
      a: a,
      b: b,
    };
  }).filter(Boolean);

  // matchNumber 1 is the headliner, so ascending puts the main event first
  bouts.sort(function (x, y) { return (x.order || 99) - (y.order || 99); });

  const v = pick(comps, [0, "venue"], {}) || {};
  const addr = v.address || {};
  return {
    bouts: bouts,
    name: ev.name || "",
    venue: v.fullName || "",
    city: [addr.city, addr.state, addr.country].filter(Boolean).join(", "),
    note: bouts.length ? "" : "Fight card not announced yet.",
  };
}

// ---------------- Football ----------------
function parseInjuries(data, teamName) {
  const out = [];
  const groups = pick(data, ["injuries"], []) || [];
  groups.forEach(function (g) {
    (g.injuries || []).forEach(function (i) {
      const ath = i.athlete || {};
      out.push({
        team: g.displayName || teamName || "",
        name: ath.displayName || ath.fullName || "",
        position: pick(ath, ["position", "abbreviation"], ""),
        status: i.status || pick(i, ["type", "description"], ""),
        detail: pick(i, ["details", "type"], "") || i.longComment || i.shortComment || "",
      });
    });
  });
  return out.filter(function (x) { return x.name; });
}

function parseFootball(summary) {
  const form = [];
  (pick(summary, ["header", "competitions", 0, "competitors"], []) || []).forEach(function (c) {
    form.push({
      team: pick(c, ["team", "displayName"], ""),
      crest: pick(c, ["team", "logos", 0, "href"], "") || pick(c, ["team", "logo"], ""),
      record: pick(c, ["record", 0, "displayValue"], ""),
      form: c.form || "",
    });
  });

  const h2h = [];
  (pick(summary, ["headToHeadGames"], []) || []).forEach(function (g) {
    (g.events || []).slice(0, 5).forEach(function (e) {
      h2h.push({
        date: e.gameDate || e.date || "",
        note: e.notes || e.shortName || e.name || "",
        score: e.score || "",
      });
    });
  });

  return {
    form: form,
    h2h: h2h,
    venue: pick(summary, ["gameInfo", "venue", "fullName"], ""),
    attendance: pick(summary, ["gameInfo", "attendance"], null),
    odds: pick(summary, ["pickcenter", 0, "details"], ""),
    broadcast: pick(summary, ["header", "competitions", 0, "broadcasts", 0, "media", "shortName"], ""),
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const kind = req.query.kind === "ufc" ? "ufc" : "liverpool";
  const id = String(req.query.id || "").replace(/[^0-9]/g, "");
  const league = String(req.query.league || "eng.1").replace(/[^a-z0-9._]/gi, "");
  const homeId = String(req.query.home || "").replace(/[^0-9]/g, "");
  const awayId = String(req.query.away || "").replace(/[^0-9]/g, "");

  if (!id) { res.status(400).json({ error: "missing id" }); return; }

  const cacheKey = CACHE_PREFIX + kind + ":" + id;
  try {
    const cached = await redisCmd(["GET", cacheKey]);
    if (cached && req.query.force !== "1") {
      res.status(200).json({ ...JSON.parse(cached), cached: true });
      return;
    }
  } catch (e) {}

  const errors = [];
  let payload = { kind: kind, id: id, errors: errors };

  try {
    if (kind === "ufc") {
      payload = Object.assign(payload, await fetchUfcCard(id));
    } else {
      const base = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + league;
      const summary = await getJson(base + "/summary?event=" + id).catch(function (e) {
        errors.push("summary: " + e.message); return {};
      });
      payload = Object.assign(payload, parseFootball(summary));

      // team news = injury lists for both sides
      let injuries = [];
      for (const tid of [homeId, awayId].filter(Boolean)) {
        try {
          const inj = await getJson(base + "/teams/" + tid + "/injuries");
          injuries = injuries.concat(parseInjuries(inj));
        } catch (e) {
          errors.push("injuries " + tid + ": " + e.message);
        }
      }
      payload.injuries = injuries;
      if (!injuries.length) payload.injuryNote = "No injury list published for this fixture.";
    }
  } catch (err) {
    errors.push(String(err.message || err));
  }

  payload.fetchedAt = Date.now();
  try { await redisCmd(["SET", cacheKey, JSON.stringify(payload), "EX", TTL_SECONDS]); } catch (e) {}
  res.status(200).json({ ...payload, cached: false });
};
