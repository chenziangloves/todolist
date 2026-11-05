package com.chenziang.todolist;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 手机重启或 App 升级后，AlarmManager 里的闹钟会全部丢失，
 * 这里把它们按存下的列表重建一遍，否则重启一次就再也不会提醒了。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String a = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)
                || "android.intent.action.QUICKBOOT_POWERON".equals(a)) {
            Reminders.ensureChannel(context);
            Reminders.scheduleAll(context);
        }
    }
}
