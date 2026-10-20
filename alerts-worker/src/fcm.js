// Firebase Cloud Messaging, for the Android app (its WebView can't use Web Push).
// The service account key comes from the FCM_SERVICE_ACCOUNT secret; Google's
// sign-in token is made from it and reused for most of an hour.

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

let cached = null; // { token, until }

async function accessToken(account) {
  if (cached && cached.until > Date.now()) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64urlText(
    JSON.stringify({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })
  );
  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${b64url(signature)}` }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status})`);
  const data = await res.json();
  cached = { token: data.access_token, until: Date.now() + (data.expires_in - 300) * 1000 };
  return cached.token;
}

// Send one alert to one phone. Returns an HTTP-like status: 404 means the app is gone.
export async function sendFcm(env, token, message) {
  const account = JSON.parse(env.FCM_SERVICE_ACCOUNT || "null");
  if (!account?.private_key) return 0;
  const data = {
    title: String(message.title || "Scoreline"),
    body: String(message.body || ""),
    tag: String(message.tag || ""),
    url: String(message.url || ""),
    silent: message.silent ? "1" : "",
    card: message.card ? JSON.stringify(message.card) : "",
  };
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken(account)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        // Shown by Android itself while the app is closed; the same tag replaces the game's earlier alert.
        notification: { title: data.title, body: data.body },
        data,
        android: {
          priority: message.silent ? "normal" : "high",
          ttl: message.silent ? "60s" : "600s",
          notification: {
            tag: data.tag || undefined,
            channel_id: message.silent ? "live" : "alerts",
            notification_priority: message.silent ? "PRIORITY_LOW" : "PRIORITY_HIGH",
            icon: "ic_stat_scoreline",
            color: "#0a84ff",
          },
        },
      },
    }),
  });
  if (res.status === 404 || res.status === 400) {
    const text = await res.text();
    if (/UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT.*token/i.test(text)) return 404;
  }
  return res.status;
}
