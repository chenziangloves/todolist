package com.chenziang.todolist;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 任务提醒的调度与发送。
 *
 * 设计取舍：
 * 1. 每次任务有增删改，网页端就把「完整的提醒列表」整批传过来，这里整体重排。
 *    增量调度看起来省事，但一旦某次同步漏了，闹钟就会残留或缺失，很难查。
 * 2. 闹钟列表同时存在 SharedPreferences 里，手机重启后由 BootReceiver 重建 ——
 *    AlarmManager 的闹钟在重启后会全部丢失，这是 Android 的既定行为。
 * 3. 精确闹钟权限（Android 12+）没拿到时不报错，退化成不精确闹钟，
 *    宁可晚几分钟提醒，也不要直接不提醒。
 */
public final class Reminders {

    static final String CHANNEL = "todo_remind";
    private static final String PREF = "todo_alarms";
    private static final String KEY = "list";
    private static final String ACTION = "com.chenziang.todolist.REMIND";

    private Reminders() {}

    private static NotificationManager nm(Context c) {
        return (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static AlarmManager am(Context c) {
        return (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager m = nm(c);
        if (m == null || m.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL, "任务提醒", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("任务截止前的提醒");
        ch.enableVibration(true);
        ch.setShowBadge(true);
        m.createNotificationChannel(ch);
    }

    static boolean canNotify(Context c) {
        if (Build.VERSION.SDK_INT >= 33) {
            return c.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        }
        NotificationManager m = nm(c);
        return m != null && m.areNotificationsEnabled();
    }

    static boolean canExact(Context c) {
        if (Build.VERSION.SDK_INT >= 31) {
            AlarmManager a = am(c);
            return a != null && a.canScheduleExactAlarms();
        }
        return true;
    }

    static String load(Context c) {
        SharedPreferences sp = c.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        return sp.getString(KEY, "[]");
    }

    private static JSONArray parse(String json) {
        try {
            return new JSONArray(json == null ? "[]" : json);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** 整体重排：先取消旧的，再存下新的，最后逐条设置 */
    static void sync(Context c, String json) {
        ensureChannel(c);
        AlarmManager a = am(c);
        if (a == null) return;

        JSONArray old = parse(load(c));
        for (int i = 0; i < old.length(); i++) {
            JSONObject o = old.optJSONObject(i);
            if (o == null) continue;
            PendingIntent pi = pi(c, o.optString("id"), o.optString("title"),
                    o.optLong("dueAt"), PendingIntent.FLAG_NO_CREATE);
            if (pi != null) a.cancel(pi);
        }

        c.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().putString(KEY, json == null ? "[]" : json).apply();

        scheduleAll(c);
    }

    /** 按已存下的列表重新设置所有未来闹钟（开机后、App 启动时调用） */
    static void scheduleAll(Context c) {
        ensureChannel(c);
        AlarmManager a = am(c);
        if (a == null) return;

        JSONArray arr = parse(load(c));
        long now = System.currentTimeMillis();
        boolean exact = canExact(c);

        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("remindAt");
            if (at <= now) continue;                       // 已经过点的不用再排
            String id = o.optString("id");
            if (id.isEmpty()) continue;

            PendingIntent pi = pi(c, id, o.optString("title"), o.optLong("dueAt"),
                    PendingIntent.FLAG_UPDATE_CURRENT);
            try {
                if (exact) {
                    a.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    a.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } catch (SecurityException e) {
                // 极端情况下精确闹钟权限被收回，退一步用普通闹钟
                a.set(AlarmManager.RTC_WAKEUP, at, pi);
            }
        }
    }

    /** 补发：App 打开时，把「提醒时间已过但还没提醒过」的任务补一条出来。
     *  国产 ROM 压后台时闹钟可能没响，这个兜底保证打开就能看到。 */
    static void catchUp(Context c, long windowMs) {
        if (!canNotify(c)) return;
        JSONArray arr = parse(load(c));
        long now = System.currentTimeMillis();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("remindAt");
            long due = o.optLong("dueAt");
            if (at > now || at + windowMs < now) continue;   // 还没到点，或已经过期太久
            if (due + 7L * 86400000L < now) continue;        // 任务本身早就过期了，别再翻旧账
            fire(c, o.optString("id"), o.optString("title"), due);
        }
    }

    private static PendingIntent pi(Context c, String id, String title, long dueAt, int extraFlag) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(ACTION);
        i.putExtra("id", id);
        i.putExtra("title", title);
        i.putExtra("dueAt", dueAt);
        int flags = PendingIntent.FLAG_IMMUTABLE | extraFlag;
        return PendingIntent.getBroadcast(c, codeOf(id), i, flags);
    }

    /** 用字符串算一个稳定的通知/闹钟 ID（同一个任务反复重排要能覆盖） */
    static int codeOf(String id) {
        if (id == null) return 0;
        int h = 17;
        for (int i = 0; i < id.length(); i++) h = h * 31 + id.charAt(i);
        return h & 0x7FFFFFFF;
    }

    static void fire(Context c, String id, String title, long dueAt) {
        ensureChannel(c);
        if (!canNotify(c)) return;

        Intent open = new Intent(c, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent content = PendingIntent.getActivity(c, codeOf(id), open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        String when = fmtWhen(dueAt);
        String name = (title == null || title.trim().isEmpty()) ? "有一件事该做了" : title.trim();

        Notification.Builder b = new Notification.Builder(c, CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(name)
                .setContentText(when)
                .setStyle(new Notification.BigTextStyle().bigText(when))
                .setAutoCancel(true)
                .setContentIntent(content)
                .setPriority(Notification.PRIORITY_HIGH)
                .setDefaults(Notification.DEFAULT_ALL);

        NotificationManager m = nm(c);
        if (m != null) m.notify(codeOf(id), b.build());
    }

    private static String fmtWhen(long ts) {
        if (ts <= 0) return "别忘了处理";
        Date d = new Date(ts);
        String hm = new SimpleDateFormat("M月d日 HH:mm", Locale.CHINA).format(d);
        long left = ts - System.currentTimeMillis();
        String tail;
        if (left < 0) {
            long days = (-left) / 86400000L;
            tail = days >= 1 ? "已逾期 " + days + " 天" : "刚刚到期";
        } else if (left < 3600000L) {
            tail = "不到 1 小时后到期";
        } else if (left < 86400000L) {
            tail = (left / 3600000L) + " 小时后到期";
        } else {
            tail = (left / 86400000L) + " 天后到期";
        }
        return "截止 " + hm + " · " + tail;
    }
}
