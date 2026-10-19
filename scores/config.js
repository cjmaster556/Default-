// Where the alerts server lives, once it's deployed to Cloudflare
// (for example "https://scoreline-alerts.your-name.workers.dev").
// Leave it empty and alerts only come while the app is open.
// ("self" so the service worker can read it too, for drawing notification scoreboards.)
self.SCORELINE_CONFIG = {
  alertsServer: "https://scoreline-alerts.cjmaster556.workers.dev",
};
