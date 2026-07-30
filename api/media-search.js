module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const type = req.query.type === "tv" ? "tv" : "movie";
  const q = req.query.q;
  if (!q) {
    res.status(400).json({ error: "missing query" });
    return;
  }
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    res.status(200).json({ posterUrl: null, note: "TMDB_API_KEY not configured yet" });
    return;
  }
  try {
    const url =
      "https://api.themoviedb.org/3/search/" +
      type +
      "?api_key=" +
      apiKey +
      "&query=" +
      encodeURIComponent(q);
    const r = await fetch(url);
    const data = await r.json();
    const first = data.results && data.results[0];
    const posterUrl = first && first.poster_path ? "https://image.tmdb.org/t/p/w342" + first.poster_path : null;
    res.status(200).json({ posterUrl });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
