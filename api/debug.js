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
  if (req.query.secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const subRaw = await redisCmd(["GET", "flow:subscription"]);
    const tasksRaw = await redisCmd(["GET", "flow:tasks"]);
    const notifiedRaw = await redisCmd(["GET", "flow:notified"]);

    let tasks = [];
    let parseError = null;
    try { tasks = tasksRaw ? JSON.parse(tasksRaw) : []; } catch (e) { parseError = String(e); }

    const now = Date.now();
    const dueNow = tasks.filter((t) => !t.done && (t.dueDateUTC || t.dueDate) && new Date(t.dueDateUTC || t.dueDate).getTime() <= now);

    let subEndpointHost = null;
    if (subRaw) {
      try { subEndpointHost = new URL(JSON.parse(subRaw).endpoint).host; } catch (e) {}
    }

    res.status(200).json({
      hasSubscription: !!subRaw,
      subscriptionEndpointHost: subEndpointHost,
      taskCount: tasks.length,
      dueNowCount: dueNow.length,
      allTasks: tasks.map((t) => ({ text: t.text, dueDate: t.dueDate, done: t.done })),
      serverNowISO: new Date(now).toISOString(),
      notifiedCount: notifiedRaw ? Object.keys(JSON.parse(notifiedRaw)).length : 0,
      parseError: parseError,
      vapidPublicKeySet: !!process.env.VAPID_PUBLIC_KEY,
      vapidPrivateKeySet: !!process.env.VAPID_PRIVATE_KEY,
      upstashConfigured: !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
};
