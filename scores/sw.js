// Network-first for the app's own files so updates show up right away, with a
// cached copy as the fallback when offline. Score requests go straight to ESPN.
const CACHE = "scoreline-v51";
importScripts("config.js");
const LOGOS = "scoreline-logos";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "demo.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/badge-96.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "no-cache" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== LOGOS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    // "no-cache" asks GitHub whether the file changed instead of trusting the
    // browser's copy for 10 minutes, so new versions show up on the next open.
    fetch(req, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
  );
});

// Tapping a score alert brings the app forward (or opens it).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.registration.scope));
      if (!open) return self.clients.openWindow(url);
      // The app is already running: bring it forward and tell it where to go.
      open.postMessage({ type: "open-url", url });
      return open.focus();
    })
  );
});

// An alert from the alerts server (sent even when the app is closed). Game
// alerts carry the score, and get a scoreboard picture like Google's live
// sports cards, drawn here; Android shows it when the notification is expanded.
self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  const show = (art) =>
    self.registration.showNotification(d.title || "Scoreline", {
      body: d.body || "",
      tag: d.tag,
      // Live score updates replace the game's notification quietly; alerts buzz.
      renotify: !!d.tag && !d.silent,
      silent: !!d.silent,
      // Collapsed, Android only shows the small square icon, so that's the two teams' logos.
      icon: art?.icon || "icons/icon-192.png",
      badge: "icons/badge-96.png",
      ...(art?.image ? { image: art.image } : {}),
      data: { url: d.url || self.registration.scope },
    });
  // Alerts arrive while the app is closed, so check for a newer version of
  // this file now and then, instead of only when the app is opened.
  self.registration.update().catch(() => {});
  // Never hold a notification up for long waiting on the picture.
  const t0 = Date.now();
  let problem = "";
  const picture = d.card
    ? Promise.race([
        drawCard(d.card).catch((err) => ((problem = String(err?.message || err)), null)),
        new Promise((r) => setTimeout(() => ((problem ||= "timed out"), r(null)), 4000)),
      ])
    : Promise.resolve(null);
  e.waitUntil(
    picture.then(async (art) => {
      await show(art);
      const image = art?.image;
      // Once per version, tell the server this phone is running it (and what it was handed).
      const seen = `./reported-${CACHE}`;
      const cache = await caches.open(LOGOS);
      if (!(await cache.match(seen))) {
        await cache.put(seen, new Response("1"));
        const shown = (await self.registration.getNotifications({ tag: d.tag }))[0];
        await report({ tag: "version", badge: shown?.badge || "", icon: (shown?.icon || "").slice(0, 40), drawn: art?.image ? art.image.length : 0 });
      }
      // Tell the server how drawing went for test alerts and failures, to fix problems on real phones.
      if (d.card && (d.tag === "scoreline-test" || !image)) {
        const shown = (await self.registration.getNotifications({ tag: d.tag }))[0];
        await report({ tag: d.tag, drawn: image ? image.length : 0, shownImage: shown?.image ? shown.image.length : 0, ms: Date.now() - t0, problem, offscreen: typeof OffscreenCanvas });
      }
    })
  );
});

async function report(info) {
  const server = String(self.SCORELINE_CONFIG?.alertsServer || "").replace(/\/$/, "");
  if (!server) return;
  try {
    await fetch(`${server}/diag`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...info, v: CACHE, ua: navigator.userAgent }) });
  } catch {
    /* nothing to do */
  }
}

// Team logos come through the alerts server (so they can be drawn) and are kept for next time.
// The dark-background version of an ESPN logo first (the Rams' navy logo is white there), then the regular one.
async function logoBitmap(src) {
  if (!src) return null;
  const dark = String(src).replace(/(\/i\/teamlogos\/[a-z]+\/)500\//, "$1500-dark/");
  return (dark !== src && (await logoBitmapFrom(dark).catch(() => null))) || logoBitmapFrom(src);
}

async function logoBitmapFrom(src) {
  const server = String(self.SCORELINE_CONFIG?.alertsServer || "").replace(/\/$/, "");
  const url = server ? `${server}/logo?src=${encodeURIComponent(src)}` : src;
  const cache = await caches.open(LOGOS);
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    await cache.put(url, res.clone());
  }
  return createImageBitmap(await res.blob());
}

function teamColor(t) {
  const ok = (h) => /^[0-9a-f]{6}$/i.test(h || "");
  const dark = (h) => {
    const n = parseInt(h, 16);
    return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) / 255 < 0.12;
  };
  if (ok(t.color) && !(dark(t.color) && ok(t.alt))) return `#${t.color}`;
  return ok(t.alt) ? `#${t.alt}` : "#3a3a3c";
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// A mini leaderboard for golf alerts: tournament, round, top three and your golfers.
async function drawGolfCard(c) {
  const W = 1000;
  const H = 500;
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d");
  const font = (weight, size) => `${weight} ${size}px Roboto, "Google Sans", system-ui, sans-serif`;
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1f6b43");
  bg.addColorStop(1, "#0b2a1b");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.textBaseline = "middle";
  g.textAlign = "left";
  g.fillStyle = "#fff";
  g.font = font(700, 40);
  g.fillText(c.title, 50, 50, W - 100);
  g.fillStyle = c.status === "Final" ? "#d9d9de" : "#ff8a80";
  g.font = font(700, 30);
  g.fillText([c.league, c.status].filter(Boolean).join(" · "), 50, 95);
  const rows = (c.rows || []).slice(0, 5);
  const rowH = Math.min(78, 350 / Math.max(rows.length, 1));
  rows.forEach((r, i) => {
    const y = 135 + i * rowH + rowH / 2;
    g.fillStyle = r.mine ? "rgba(255,214,10,0.2)" : "rgba(255,255,255,0.08)";
    roundRect(g, 40, y - rowH / 2 + 5, W - 80, rowH - 10, 18);
    g.fill();
    g.textAlign = "left";
    g.fillStyle = "rgba(255,255,255,0.75)";
    g.font = font(700, 34);
    g.fillText(r.pos, 70, y);
    g.fillStyle = r.mine ? "#ffd60a" : "#fff";
    g.font = font(600, 38);
    g.fillText(r.name, 170, y, 600);
    g.textAlign = "right";
    g.fillStyle = /^-/.test(r.score) ? "#ff8a80" : "#fff";
    g.font = font(800, 42);
    g.fillText(r.score, W - 70, y);
  });
  return { image: await dataURL(canvas, "image/jpeg"), icon: null };
}

async function drawCard(c) {
  if (typeof OffscreenCanvas === "undefined") return null;
  if (c.golf) return drawGolfCard(c);
  const W = 1000;
  const H = 500;
  const canvas = new OffscreenCanvas(W, H);
  const g = canvas.getContext("2d");
  const font = (weight, size) => `${weight} ${size}px Roboto, "Google Sans", system-ui, sans-serif`;

  // Dark card with each team's color glowing in from its side.
  g.fillStyle = "#1f1f22";
  g.fillRect(0, 0, W, H);
  for (const [t, x] of [
    [c.a, 0],
    [c.h, W],
  ]) {
    const glow = g.createRadialGradient(x, H * 0.35, 0, x, H * 0.35, W * 0.55);
    glow.addColorStop(0, `${teamColor(t)}cc`);
    glow.addColorStop(1, `${teamColor(t)}00`);
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
  }

  const [la, lh] = await Promise.all([logoBitmap(c.a.logo).catch(() => null), logoBitmap(c.h.logo).catch(() => null)]);
  const icon = la && lh ? await drawIcon(la, lh) : null;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const tile = 170;
  for (const [t, img, x, sx] of [
    [c.a, la, 40, 300],
    [c.h, lh, W - 40 - tile, W - 300],
  ]) {
    g.globalAlpha = c.st === "post" && !t.won ? 0.55 : 1;
    g.fillStyle = "rgba(255,255,255,0.14)";
    roundRect(g, x, 60, tile, tile, 28);
    g.fill();
    if (img) g.drawImage(img, x + 20, 80, tile - 40, tile - 40);
    else {
      g.fillStyle = teamColor(t);
      g.beginPath();
      g.arc(x + tile / 2, 60 + tile / 2, 55, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "#e8e8ec";
    g.font = font(600, 46);
    g.fillText(t.abbr, x + tile / 2, 290);
    g.fillStyle = "#fff";
    g.font = font(700, 128);
    if (t.score !== "") g.fillText(t.score, sx, 150);
    g.globalAlpha = 1;
  }
  // Who has the ball: a dot just outside that team's score, toward the middle.
  if (c.poss) {
    g.font = font(700, 128);
    const half = g.measureText((c.poss === "a" ? c.a : c.h).score || "0").width / 2;
    g.fillStyle = "#ffd60a";
    g.beginPath();
    g.arc(c.poss === "a" ? 300 + half + 16 : W - 300 - half - 16, 100, 11, 0, Math.PI * 2);
    g.fill();
  }

  // The clock in a pill: red while live, gray otherwise.
  g.font = font(700, 36);
  const status = c.status || "";
  const pw = Math.min(250, g.measureText(status).width + 44);
  g.fillStyle = c.st === "in" ? "#b3261e" : "rgba(255,255,255,0.16)";
  roundRect(g, W / 2 - pw / 2, 120, pw, 64, 32);
  g.fill();
  g.fillStyle = "#fff";
  g.fillText(status, W / 2, 153, pw - 24);
  g.fillStyle = "#b9b9c0";
  g.font = font(600, 38);
  g.fillText(c.league, W / 2, 290);

  if (c.line) {
    g.fillStyle = "rgba(255,255,255,0.18)";
    g.fillRect(60, 350, W - 120, 2);
    g.fillStyle = c.rz ? "#ff6961" : "#f2f2f5";
    g.font = font(500, 42);
    g.fillText(c.line, W / 2, 425, W - 120);
  }

  return { image: await dataURL(canvas, "image/jpeg"), icon };
}

// The small square shown on the collapsed notification: away logo top-left, home bottom-right.
async function drawIcon(la, lh) {
  const S = 256;
  const canvas = new OffscreenCanvas(S, S);
  const g = canvas.getContext("2d");
  g.fillStyle = "#2a2a2e";
  roundRect(g, 0, 0, S, S, 48);
  g.fill();
  g.drawImage(la, 14, 14, 140, 140);
  g.drawImage(lh, S - 154, S - 154, 140, 140);
  return dataURL(canvas, "image/png");
}

async function dataURL(canvas, type) {
  const blob = await canvas.convertToBlob(type === "image/jpeg" ? { type, quality: 0.88 } : { type });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}
