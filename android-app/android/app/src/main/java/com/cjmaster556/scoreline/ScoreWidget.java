package com.cjmaster556.scoreline;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONObject;

// Home screen widget: the followed teams' games as scoreboard rows (the notification's row design),
// live first, then upcoming, then finals. Android refreshes it every 30 minutes; it also refreshes
// when the app starts or the follows change (WidgetPlugin) and whenever a game push arrives (ScoreNotifier).
public class ScoreWidget extends AppWidgetProvider {

    static final String PREFS = "scoreline.widget";
    private static final int[] ROWS = { R.id.row1, R.id.row2, R.id.row3, R.id.row4, R.id.row5 };

    // Scoreline's league keys and ESPN's scoreboard paths (golf isn't shown).
    private static final Map<String, String> PATHS = new HashMap<>();
    static {
        PATHS.put("nfl", "football/nfl");
        PATHS.put("cfb", "football/college-football");
        PATHS.put("nba", "basketball/nba");
        PATHS.put("wnba", "basketball/wnba");
        PATHS.put("mlb", "baseball/mlb");
        PATHS.put("nhl", "hockey/nhl");
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager manager, int[] ids) {
        PendingResult done = goAsync();
        new Thread(() -> {
            try {
                update(ctx, manager, ids);
            } finally {
                done.finish();
            }
        }).start();
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager manager, int id, Bundle options) {
        onUpdate(ctx, manager, new int[] { id });
    }

    // Redraw every Scoreline widget, off the main thread.
    static void refresh(Context ctx) {
        Context app = ctx.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        int[] ids = manager.getAppWidgetIds(new ComponentName(app, ScoreWidget.class));
        if (ids.length == 0) return;
        new Thread(() -> update(app, manager, ids)).start();
    }

    private static synchronized void update(Context ctx, AppWidgetManager manager, int[] ids) {
        Set<String> teams = new HashSet<>();
        try {
            JSONArray saved = new JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("teams", "[]"));
            for (int i = 0; i < saved.length(); i++) teams.add(saved.optString(i));
        } catch (Exception ignored) {}

        List<Game> games = teams.isEmpty() ? new ArrayList<>() : games(ctx, teams);
        String empty = teams.isEmpty() ? "Follow teams in Scoreline to see their games here." : games.isEmpty() ? "No games right now for your teams." : null;

        for (int id : ids) {
            Bundle opts = manager.getAppWidgetOptions(id);
            int w = Math.max(200, opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250));
            int h = Math.max(80, opts.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 110));
            // Each row is 1000 x 140 on the drawing grid: inside the 10dp padding it shows (w - 20) * 0.14 tall, plus a 6dp
            // gap, under a header of about 37dp. When the games don't all fit at full size, the "fill" layout shares the
            // height between them and the rows shrink (down to about 70%) instead of a game being dropped.
            float rowH = (w - 20) * 0.14f;
            int full = (int) ((h - 37) / (rowH + 6));
            int squeezed = (int) ((h - 37) / (rowH * 0.7f + 4));
            int fit = Math.max(1, Math.min(ROWS.length, Math.min(games.size(), squeezed)));
            int layout = fit > full ? R.layout.widget_scores_fill : R.layout.widget_scores;

            RemoteViews views = new RemoteViews(ctx.getPackageName(), layout);
            views.setOnClickPendingIntent(R.id.widget_root, openApp(ctx, null, 0));
            views.setViewVisibility(R.id.empty, empty != null ? View.VISIBLE : View.GONE);
            if (empty != null) views.setTextViewText(R.id.empty, empty);
            for (int i = 0; i < ROWS.length; i++) {
                Game g = i < fit && i < games.size() ? games.get(i) : null;
                views.setViewVisibility(ROWS[i], g != null && g.row != null ? View.VISIBLE : View.GONE);
                if (g == null || g.row == null) continue;
                views.setImageViewBitmap(ROWS[i], g.row);
                views.setOnClickPendingIntent(ROWS[i], openApp(ctx, "#" + g.league + "/" + g.id, i + 1));
            }
            views.setTextViewText(R.id.updated, new SimpleDateFormat("h:mm a", Locale.US).format(new Date()));
            manager.updateAppWidget(id, views);
        }
    }

    // Opens the app; with a game link, the push plugin hands it to the web app like a tapped alert.
    private static PendingIntent openApp(Context ctx, String hash, int code) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (hash != null) {
            intent.putExtra("google.message_id", "widget" + code);
            intent.putExtra("url", hash);
        }
        return PendingIntent.getActivity(ctx, 9000 + code, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ---------- games ----------

    private static final class Game {
        String league;
        String id;
        String st;
        long when;
        Bitmap row;
    }

    private static List<Game> games(Context ctx, Set<String> teams) {
        Map<String, Set<String>> byLeague = new HashMap<>();
        for (String key : teams) {
            int colon = key.indexOf(':');
            if (colon < 0) continue;
            String league = key.substring(0, colon);
            if (!PATHS.containsKey(league)) continue;
            byLeague.computeIfAbsent(league, k -> new HashSet<>()).add(key.substring(colon + 1));
        }
        List<Game> out = new ArrayList<>();
        for (Map.Entry<String, Set<String>> e : byLeague.entrySet()) {
            String league = e.getKey();
            JSONObject board = getJSON("https://site.api.espn.com/apis/site/v2/sports/" + PATHS.get(league) + "/scoreboard" + ("cfb".equals(league) ? "?groups=80&limit=300" : "?limit=300"));
            JSONArray events = board != null ? board.optJSONArray("events") : null;
            if (events == null) continue;
            for (int i = 0; i < events.length(); i++) {
                JSONObject ev = events.optJSONObject(i);
                Game g = ev != null ? game(ctx, league, ev, e.getValue()) : null;
                if (g != null) out.add(g);
            }
        }
        // Live, then upcoming (soonest first), then finals (latest first).
        out.sort((x, y) -> {
            int rx = rank(x.st);
            int ry = rank(y.st);
            if (rx != ry) return rx - ry;
            return "post".equals(x.st) ? Long.compare(y.when, x.when) : Long.compare(x.when, y.when);
        });
        return out;
    }

    private static int rank(String st) {
        return "in".equals(st) ? 0 : "pre".equals(st) ? 1 : 2;
    }

    private static Game game(Context ctx, String league, JSONObject ev, Set<String> follows) {
        JSONArray comps = ev.optJSONArray("competitions");
        JSONObject comp = comps != null ? comps.optJSONObject(0) : null;
        JSONArray cs = comp != null ? comp.optJSONArray("competitors") : null;
        if (cs == null) return null;
        JSONObject away = null;
        JSONObject home = null;
        boolean mine = false;
        for (int i = 0; i < cs.length(); i++) {
            JSONObject c = cs.optJSONObject(i);
            if (c == null) continue;
            if ("home".equals(c.optString("homeAway"))) home = c;
            else away = c;
            JSONObject team = c.optJSONObject("team");
            if (team != null && follows.contains(team.optString("id"))) mine = true;
        }
        if (!mine || away == null || home == null) return null;

        JSONObject status = ev.optJSONObject("status");
        if (status == null) status = comp.optJSONObject("status");
        JSONObject type = status != null ? status.optJSONObject("type") : null;
        String st = type != null ? type.optString("state", "pre") : "pre";
        Game g = new Game();
        g.league = league;
        g.id = ev.optString("id");
        g.st = st;
        g.when = parseDate(ev.optString("date"));
        try {
            JSONObject card = card(league, st, status, type, comp, away, home, g.when);
            JSONObject a = card.getJSONObject("a");
            JSONObject h = card.getJSONObject("h");
            g.row = ScoreNotifier.drawRow(card, a, h, ScoreNotifier.logo(ctx, a.optString("logo")), ScoreNotifier.logo(ctx, h.optString("logo")), 26);
        } catch (Exception | OutOfMemoryError ignored) {}
        return g;
    }

    // The same fields the server's scoreCardData sends with notifications.
    private static JSONObject card(String league, String st, JSONObject status, JSONObject type, JSONObject comp, JSONObject away, JSONObject home, long when) throws Exception {
        String sport = PATHS.get(league).split("/")[0];
        int period = status != null ? status.optInt("period") : 0;
        String clock = status != null ? status.optString("displayClock") : "";
        String name = type != null ? type.optString("name") : "";
        String text = type != null ? type.optString("shortDetail") : "";
        if ("pre".equals(st) && when > 0) {
            text = startTime(when);
        } else if ("in".equals(st) && !clock.isEmpty() && !name.matches(".*(HALFTIME|END_PERIOD|DELAYED).*")
            && ("football".equals(sport) || "basketball".equals(sport) || "hockey".equals(sport))) {
            String p = "hockey".equals(sport) ? (period > 3 ? "OT" : "P" + period) : period > 4 ? "OT" : "Q" + period;
            text = p + " · " + clock;
        }
        JSONObject sit = comp.optJSONObject("situation");
        String poss = "";
        if ("football".equals(sport) && "in".equals(st) && sit != null) {
            String who = sit.optString("possession");
            if (!who.isEmpty() && who.equals(teamId(away))) poss = "a";
            else if (!who.isEmpty() && who.equals(teamId(home))) poss = "h";
        }
        JSONObject card = new JSONObject();
        card.put("st", st);
        card.put("status", text);
        card.put("poss", poss);
        card.put("a", side(away, st));
        card.put("h", side(home, st));
        return card;
    }

    private static JSONObject side(JSONObject c, String st) throws Exception {
        JSONObject team = c.optJSONObject("team");
        if (team == null) team = new JSONObject();
        JSONObject s = new JSONObject();
        s.put("abbr", team.optString("abbreviation"));
        s.put("score", "pre".equals(st) ? "" : c.optString("score"));
        s.put("logo", team.optString("logo"));
        s.put("color", team.optString("color"));
        s.put("alt", team.optString("alternateColor"));
        s.put("won", "post".equals(st) && c.optBoolean("winner"));
        return s;
    }

    private static String teamId(JSONObject c) {
        JSONObject team = c.optJSONObject("team");
        return team != null ? team.optString("id") : c.optString("id");
    }

    // "8:15 PM" today, "Tue 8:15 PM" another day.
    private static String startTime(long when) {
        Calendar now = Calendar.getInstance();
        Calendar then = Calendar.getInstance();
        then.setTimeInMillis(when);
        boolean today = now.get(Calendar.YEAR) == then.get(Calendar.YEAR) && now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR);
        return new SimpleDateFormat(today ? "h:mm a" : "EEE h:mm a", Locale.US).format(new Date(when));
    }

    private static long parseDate(String s) {
        for (String pattern : new String[] { "yyyy-MM-dd'T'HH:mm'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'" }) {
            try {
                SimpleDateFormat f = new SimpleDateFormat(pattern, Locale.US);
                f.setTimeZone(TimeZone.getTimeZone("UTC"));
                Date d = f.parse(s);
                if (d != null) return d.getTime();
            } catch (Exception ignored) {}
        }
        return 0;
    }

    private static JSONObject getJSON(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(8000);
            if (c.getResponseCode() != 200) return null;
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[16384];
                for (int n; (n = in.read(buf)) > 0; ) bytes.write(buf, 0, n);
            }
            return new JSONObject(bytes.toString("UTF-8"));
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
