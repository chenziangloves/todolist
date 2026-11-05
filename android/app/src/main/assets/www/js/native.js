/* 原生能力的桥接层
 *
 * 浏览器里打开时，下面这些接口全部降级为空操作，
 * 所以同一套网页代码既能当 PWA 用，也能塞进安卓壳里。
 */
(function (global) {
  'use strict';

  var N = global.TodoNative || null;   // 安卓壳通过 addJavascriptInterface 注入

  function has() { return !!N; }

  /* ---------------- 通知 ---------------- */

  /* 把「哪些任务要什么时候提醒」整批交给原生重排闹钟。
   * items: [{ id, title, remindAt, dueAt }]
   * 每次任务有增删改，就整体重算一遍 —— 比增量调度可靠得多。 */
  function syncAlarms(items) {
    if (!has() || !N.syncAlarms) return false;
    try {
      N.syncAlarms(JSON.stringify(items || []));
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 通知权限状态：granted / denied / prompt（还需要申请） */
  function notifState() {
    if (!has() || !N.notifState) return 'unsupported';
    try { return N.notifState(); } catch (e) { return 'unsupported'; }
  }

  function requestNotif() {
    if (!has() || !N.requestNotif) return false;
    try { N.requestNotif(); return true; } catch (e) { return false; }
  }

  /* 安卓 12+ 的精确闹钟需要单独授权，否则只能拿到不精确的闹钟 */
  function exactAlarmState() {
    if (!has() || !N.exactAlarmState) return 'unsupported';
    try { return N.exactAlarmState(); } catch (e) { return 'unsupported'; }
  }

  function requestExactAlarm() {
    if (!has() || !N.requestExactAlarm) return false;
    try { N.requestExactAlarm(); return true; } catch (e) { return false; }
  }

  /* ---------------- 导出 ---------------- */

  /* 把文本写成文件存到手机「下载」目录，返回真实路径或空字符串 */
  function saveText(name, text) {
    if (!has() || !N.saveText) return '';
    try { return N.saveText(name, text) || ''; } catch (e) { return ''; }
  }

  /* 从系统选择器里挑一个文件读回文本（暂未在雏形中启用） */
  function pickText() {
    if (!has() || !N.pickText) return '';
    try { return N.pickText() || ''; } catch (e) { return ''; }
  }

  /* ---------------- 更新 ---------------- */

  function appVersion() {
    if (!has() || !N.appVersion) return '';
    try { return N.appVersion() || ''; } catch (e) { return ''; }
  }

  function checkUpdate() {
    if (!has() || !N.checkUpdate) return '';
    try { return N.checkUpdate() || ''; } catch (e) { return ''; }
  }

  function pollUpdate(rid) {
    if (!has() || !N.pollUpdate) return '';
    try { return N.pollUpdate(rid) || ''; } catch (e) { return ''; }
  }

  function openUrl(url) {
    if (!has() || !N.openUrl) return false;
    try { N.openUrl(url); return true; } catch (e) { return false; }
  }

  /* --------------- 小工具 --------------- */

  function vibrate(ms) {
    if (has() && N.vibrate) {
      try { N.vibrate(ms || 12); return; } catch (e) { /* 落到下面 */ }
    }
    if (global.navigator && global.navigator.vibrate) {
      try { global.navigator.vibrate(ms || 12); } catch (e) { /* ignore */ }
    }
  }

  global.Native = {
    has: has,
    syncAlarms: syncAlarms,
    notifState: notifState,
    requestNotif: requestNotif,
    exactAlarmState: exactAlarmState,
    requestExactAlarm: requestExactAlarm,
    saveText: saveText,
    pickText: pickText,
    appVersion: appVersion,
    checkUpdate: checkUpdate,
    pollUpdate: pollUpdate,
    openUrl: openUrl,
    vibrate: vibrate
  };
})(window);
