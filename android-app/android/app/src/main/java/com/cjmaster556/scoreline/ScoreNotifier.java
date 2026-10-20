package com.cjmaster556.scoreline;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.os.Build;
import android.widget.RemoteViews;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.drawable.IconCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import org.json.JSONObject;

// Draws Scoreline's own notification from a server message: the scoreboard picture (the same
// design as the web app's notification picture) shown collapsed and expanded. The live score
// notification uses the "scoreboard" channel (normal rank so Android can open it expanded at the top, but silent) and stays put while the game is on; alerts use
// "alerts" and replace it (same tag), and the next live update replaces them again.
final class ScoreNotifier {

    private static final int ID = 1;
    private static final float SCALE = 0.76f; // pictures are drawn on a 1000-wide grid, saved smaller

    private ScoreNotifier() {}

    static void show(Context ctx, Map<String, String> d, String messageId) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        makeChannels(ctx);
        boolean silent = "1".equals(d.get("silent"));
        String title = text(d.get("title"));
        String body = text(d.get("body"));
        String tag = text(d.get("tag"));
        if (tag.isEmpty()) tag = "msg:" + (messageId != null ? messageId : System.currentTimeMillis());

        JSONObject card = null;
        try {
            String c = d.get("card");
            if (c != null && !c.isEmpty()) card = new JSONObject(c);
        } catch (Exception ignored) {}

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, silent ? "scoreboard" : "alerts")
            .setSmallIcon(R.drawable.ic_stat_scoreline)
            .setColor(0xFF0A84FF)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(silent ? NotificationCompat.PRIORITY_DEFAULT : NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(tapIntent(ctx, d, tag, messageId));
        if (silent) b.setOnlyAlertOnce(true).setSilent(true);

        JSONObject a = card != null ? card.optJSONObject("a") : null;
        JSONObject h = card != null ? card.optJSONObject("h") : null;
        Bitmap big = null;
        Bitmap row = null;
        if (a != null && h != null) {
            try {
                Bitmap la = logo(ctx, a.optString("logo"));
                Bitmap lh = logo(ctx, h.optString("logo"));
                big = drawCard(card, a, h, la, lh, silent ? "Scoreline" : title, !silent);
                row = drawRow(card, a, h, la, lh, silent ? 0 : 26);
            } catch (Exception | OutOfMemoryError e) {
                big = null;
                row = null;
            }
        }
        if (big != null && row != null) {
            RemoteViews small = new RemoteViews(ctx.getPackageName(), silent ? R.layout.notif_row : R.layout.notif_small);
            small.setImageViewBitmap(R.id.card, row);
            if (!silent) small.setTextViewText(R.id.title, title);
            RemoteViews large = new RemoteViews(ctx.getPackageName(), R.layout.notif_big);
            large.setImageViewBitmap(R.id.card, big);
            // No system header (the app targets Android 11), so these views are the whole notification, like Google's.
            b.setCustomContentView(small).setCustomBigContentView(large).setCustomHeadsUpContentView(small);
            Bitmap mini = statusScore(a, h);
            if (mini != null) b.setSmallIcon(IconCompat.createWithBitmap(mini));
            // The live score stays pinned while the game is on (cleared after a few hours just in case).
            if (silent && "in".equals(card.optString("st"))) b.setOngoing(true).setAutoCancel(false).setTimeoutAfter(4 * 3600 * 1000L);
        } else {
            b.setStyle(new NotificationCompat.BigTextStyle().bigText(body));
        }
        NotificationManagerCompat.from(ctx).notify(tag, ID, b.build());
    }

    // Tapping opens the app; the push plugin hands the data (with the game's link) to the web app.
    private static PendingIntent tapIntent(Context ctx, Map<String, String> d, String tag, String messageId) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("google.message_id", messageId != null ? messageId : tag);
        for (Map.Entry<String, String> e : d.entrySet()) {
            if (!"card".equals(e.getKey())) intent.putExtra(e.getKey(), e.getValue());
        }
        return PendingIntent.getActivity(ctx, tag.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // The web app makes these too; making them here covers a message arriving before it has run.
    private static void makeChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel("alerts") == null) {
            NotificationChannel c = new NotificationChannel("alerts", "Score alerts", NotificationManager.IMPORTANCE_HIGH);
            c.setDescription("Scores, starts, finals and reminders");
            nm.createNotificationChannel(c);
        }
        // Not the web app's low-rank "live" channel: Android never opens quiet-group notifications expanded.
        if (nm.getNotificationChannel("scoreboard") == null) {
            NotificationChannel c = new NotificationChannel("scoreboard", "Live scoreboard", NotificationManager.IMPORTANCE_DEFAULT);
            c.setDescription("The live score as the game goes on");
            c.setSound(null, null);
            c.enableVibration(false);
            nm.createNotificationChannel(c);
        }
    }

    // ---------- logos ----------

    // ESPN's dark-background logo first (the card is dark), then the regular one. Kept on disk.
    private static Bitmap logo(Context ctx, String src) {
        if (src == null || !src.startsWith("https://")) return null;
        String dark = src.replace("/500/", "/500-dark/");
        Bitmap b = fetch(ctx, dark);
        if (b == null && !dark.equals(src)) b = fetch(ctx, src);
        return b;
    }

    private static Bitmap fetch(Context ctx, String url) {
        File dir = new File(ctx.getCacheDir(), "logos");
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        String name = Integer.toHexString(url.hashCode());
        File file = new File(dir, name + ".png");
        File none = new File(dir, name + ".none");
        if (file.exists()) {
            Bitmap b = BitmapFactory.decodeFile(file.getPath());
            if (b != null) return b;
        }
        if (none.exists() && System.currentTimeMillis() - none.lastModified() < 86400000L) return null;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(4000);
            if (c.getResponseCode() != 200) {
                none.createNewFile();
                none.setLastModified(System.currentTimeMillis());
                return null;
            }
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] buf = new byte[16384];
                for (int n; (n = in.read(buf)) > 0; ) bytes.write(buf, 0, n);
            }
            byte[] data = bytes.toByteArray();
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = 2;
            Bitmap b = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
            if (b != null) {
                try (FileOutputStream out = new FileOutputStream(file)) {
                    b.compress(Bitmap.CompressFormat.PNG, 100, out);
                }
            }
            return b;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ---------- drawing ----------

    private static final Typeface BOLD = Typeface.create("sans-serif", Typeface.BOLD);
    private static final Typeface MEDIUM = Typeface.create("sans-serif-medium", Typeface.NORMAL);

    // The full card, in Google's layout: a small label on top (the app's name, or what happened for an
    // alert), logos in gray tiles, big scores, the clock in a pill, the league, and the bottom line.
    private static Bitmap drawCard(JSONObject c, JSONObject a, JSONObject h, Bitmap la, Bitmap lh, String label, boolean strong) {
        int W = 1000;
        String st = c.optString("st");
        String line = c.optString("line");
        Canvas g = new Canvas();
        int H = (line.isEmpty() ? 330 : 480) + 70;
        Bitmap bmp = canvas(g, W, H, 0);
        glow(g, a, h, W, 70 + 145, W * 0.55f);
        Paint p = paint();
        p.setTypeface(strong ? BOLD : MEDIUM);
        p.setTextSize(strong ? 40 : 34);
        p.setColor(strong ? Color.WHITE : 0xFFC4C7CE);
        centered(g, p, label, W / 2f, 48, W - 80);
        g.translate(0, 70);
        int tile = 170;
        side(g, p, st, a, la, 40, 60, tile, 300, 150, 128, 290, 46);
        side(g, p, st, h, lh, W - 40 - tile, 60, tile, W - 300, 150, 128, 290, 46);
        possession(g, p, c, a, h, 300, W - 300, 100, 128, 11);
        pill(g, p, st, c.optString("status"), W / 2f, 152, 250, 64, 36);
        p.setTypeface(MEDIUM);
        p.setColor(0xFFB9B9C0);
        p.setTextSize(38);
        centered(g, p, c.optString("league"), W / 2f, 290, 300);
        if (!line.isEmpty()) {
            p.setColor(0x2EFFFFFF);
            g.drawRect(60, 350, W - 60, 352, p);
            p.setColor(c.optBoolean("rz") ? 0xFFFF6961 : 0xFFF2F2F5);
            p.setTextSize(42);
            centered(g, p, line, W / 2f, 425, W - 120);
        }
        return bmp;
    }

    // One row for the collapsed notification: logo, abbreviation and score on each side, clock between.
    // Drawn a little taller than the row (shown center-cropped) so the glow reaches the notification's edges;
    // rounded when it sits under an alert's text instead.
    private static Bitmap drawRow(JSONObject c, JSONObject a, JSONObject h, Bitmap la, Bitmap lh, float radius) {
        int W = 1000;
        int H = radius > 0 ? 140 : 180;
        String st = c.optString("st");
        Canvas g = new Canvas();
        Bitmap bmp = canvas(g, W, H, radius);
        glow(g, a, h, W, H / 2f, W * 0.45f);
        g.translate(0, (H - 140) / 2f);
        Paint p = paint();
        int tile = 104;
        side(g, p, st, a, la, 18, 18, tile, 320, 70, 84, 0, 0);
        side(g, p, st, h, lh, W - 18 - tile, 18, tile, W - 320, 70, 84, 0, 0);
        abbr(g, p, st, a, 190, 70);
        abbr(g, p, st, h, W - 190, 70);
        possession(g, p, c, a, h, 320, W - 320, 40, 84, 9);
        pill(g, p, st, c.optString("status"), W / 2f, 70, 210, 60, 34);
        return bmp;
    }

    // Dark like Google's card, under the team-color glow; the layouts use the same color around the picture (notif_bg).
    static final int BG = 0xFF1E2129;

    // The status bar icon: the away score over the home score, white on clear (Android uses only the shape).
    private static Bitmap statusScore(JSONObject a, JSONObject h) {
        String top = a.optString("score");
        String bottom = h.optString("score");
        if (top.isEmpty() || bottom.isEmpty()) return null;
        int S = 96;
        Bitmap bmp = Bitmap.createBitmap(S, S, Bitmap.Config.ARGB_8888);
        Canvas g = new Canvas(bmp);
        Paint p = paint();
        p.setTypeface(Typeface.create("sans-serif-condensed", Typeface.BOLD));
        p.setColor(Color.WHITE);
        p.setTextSize(50);
        centered(g, p, top, S / 2f, S * 0.26f, S);
        p.setTextSize(50);
        centered(g, p, bottom, S / 2f, S * 0.76f, S);
        return bmp;
    }

    private static Bitmap canvas(Canvas g, int w, int h, float radius) {
        Bitmap bmp = Bitmap.createBitmap(Math.round(w * SCALE), Math.round(h * SCALE), Bitmap.Config.ARGB_8888);
        g.setBitmap(bmp);
        g.scale(SCALE, SCALE);
        if (radius > 0) {
            Path clip = new Path();
            clip.addRoundRect(new RectF(0, 0, w, h), radius, radius, Path.Direction.CW);
            g.clipPath(clip);
        }
        g.drawColor(BG);
        return bmp;
    }

    // Each team's color glowing in from its side.
    private static void glow(Canvas g, JSONObject a, JSONObject h, int w, float cy, float r) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        float[] xs = { 0, w };
        JSONObject[] teams = { a, h };
        for (int i = 0; i < 2; i++) {
            int col = teamColor(teams[i]);
            p.setShader(new RadialGradient(xs[i], cy, r, (col & 0xFFFFFF) | 0xCC000000, col & 0xFFFFFF, Shader.TileMode.CLAMP));
            g.drawPaint(p);
        }
    }

    private static void side(Canvas g, Paint p, String st, JSONObject t, Bitmap logo, float x, float y, int tile, float sx, float sy, float scoreSize, float ay, float abbrSize) {
        int alpha = "post".equals(st) && !t.optBoolean("won") ? 140 : 255;
        p.setAlpha(255);
        p.setColor(0x4DFFFFFF);
        p.setAlpha(Math.round(0x4D * alpha / 255f));
        g.drawRoundRect(new RectF(x, y, x + tile, y + tile), tile * 0.16f, tile * 0.16f, p);
        float pad = tile * 0.12f;
        if (logo != null) {
            p.setAlpha(alpha);
            g.drawBitmap(logo, null, new RectF(x + pad, y + pad, x + tile - pad, y + tile - pad), p);
        } else {
            p.setColor(teamColor(t));
            p.setAlpha(alpha);
            g.drawCircle(x + tile / 2f, y + tile / 2f, tile * 0.32f, p);
        }
        if (abbrSize > 0) {
            p.setTypeface(MEDIUM);
            p.setTextSize(abbrSize);
            p.setColor(0xFFE8E8EC);
            p.setAlpha(alpha);
            centered(g, p, t.optString("abbr"), x + tile / 2f, ay, 260);
        }
        String score = t.optString("score");
        if (!score.isEmpty()) {
            p.setTypeface(BOLD);
            p.setTextSize(scoreSize);
            p.setColor(Color.WHITE);
            p.setAlpha(alpha);
            centered(g, p, score, sx, sy, tile * 1.5f);
        }
        p.setAlpha(255);
    }

    private static void abbr(Canvas g, Paint p, String st, JSONObject t, float x, float y) {
        p.setTypeface(MEDIUM);
        p.setTextSize(40);
        p.setColor(0xFFE8E8EC);
        p.setAlpha("post".equals(st) && !t.optBoolean("won") ? 140 : 255);
        centered(g, p, t.optString("abbr"), x, y, 110);
        p.setAlpha(255);
    }

    // Who has the ball: a yellow dot just outside that team's score, toward the middle.
    private static void possession(Canvas g, Paint p, JSONObject c, JSONObject a, JSONObject h, float ax, float hx, float y, float size, float r) {
        String poss = c.optString("poss");
        if (!"a".equals(poss) && !"h".equals(poss)) return;
        boolean away = "a".equals(poss);
        p.setTypeface(BOLD);
        p.setTextSize(size);
        String score = (away ? a : h).optString("score");
        float half = p.measureText(score.isEmpty() ? "0" : score) / 2;
        p.setColor(0xFFFFD60A);
        g.drawCircle(away ? ax + half + r + 6 : hx - half - r - 6, y, r, p);
    }

    // The clock in a pill: red while live, gray otherwise.
    private static void pill(Canvas g, Paint p, String st, String status, float cx, float cy, float maxW, float ph, float size) {
        p.setTypeface(BOLD);
        p.setTextSize(size);
        float pw = Math.min(maxW, p.measureText(status) + 44);
        p.setColor("in".equals(st) ? 0xFFB3261E : 0x29FFFFFF);
        g.drawRoundRect(new RectF(cx - pw / 2, cy - ph / 2, cx + pw / 2, cy + ph / 2), ph / 2, ph / 2, p);
        p.setColor(Color.WHITE);
        centered(g, p, status, cx, cy, pw - 24);
    }

    // Text centered on (x, y), shrunk to fit maxW.
    private static void centered(Canvas g, Paint p, String s, float x, float y, float maxW) {
        if (s == null || s.isEmpty()) return;
        float size = p.getTextSize();
        while (p.measureText(s) > maxW && p.getTextSize() > 12) p.setTextSize(p.getTextSize() - 2);
        g.drawText(s, x, y - (p.ascent() + p.descent()) / 2, p);
        p.setTextSize(size);
    }

    private static Paint paint() {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        p.setTextAlign(Paint.Align.CENTER);
        return p;
    }

    // The team's color, or its alternate when the main one is nearly black.
    private static int teamColor(JSONObject t) {
        String c = t.optString("color");
        String alt = t.optString("alt");
        if (hex(c) && !(dark(c) && hex(alt))) return 0xFF000000 | Integer.parseInt(c, 16);
        if (hex(alt)) return 0xFF000000 | Integer.parseInt(alt, 16);
        return 0xFF5A5A64;
    }

    private static boolean hex(String s) {
        return s != null && s.matches("[0-9a-fA-F]{6}");
    }

    private static boolean dark(String s) {
        int n = Integer.parseInt(s, 16);
        return ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) / 255 < 0.12;
    }

    private static String text(String s) {
        return s == null ? "" : s;
    }
}
