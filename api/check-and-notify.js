const webpush = require("web-push");

// mirrors CATEGORIES in index.html — used to label the notification
const CATEGORY_LABEL = {
  work: "WORK",
  vonarson: "VONARSON",
  home: "HOME",
  books: "BOOKS",
  movies: "MOVIES",
  series: "SERIES",
  health: "HEALTH",
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
      res.status(200).json({ ok: true, skipped: "no subscription or tasks yet" });
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

    await redisCmd(["SET", "flow:notified", JSON.stringify(notified)]);
    res.status(200).json({ ok: true, sent });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
