package com.chenziang.todolist;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 闹钟到点时被系统唤起，负责把通知弹出来 */
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra("id");
        String title = intent.getStringExtra("title");
        long dueAt = intent.getLongExtra("dueAt", 0);
        Reminders.fire(context, id, title, dueAt);
    }
}
