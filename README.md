# TodoList

一个给自己用的待办清单 App：把提前两周通知下来的事记下来，按截止时间自动排好，到点提醒。

装在安卓手机上，**纯本地**，不联网、不要账号、数据不上传。

## 它解决什么

刚工作时最常见的丢事方式不是「忘了做」，而是「当时说要两周后做，然后就忘了」。所以这个 App 的重心是三件事：

1. **先记下来再说**：三秒记一条，标题 + 截止时间就够，其余可以后补
2. **自动排出先后**：按截止时间排序，逾期和 24 小时内到期的标红，一眼看到最急的
3. **到点提醒，而不是等你打开**：提前 N 天推系统通知，关掉 App 也能收到

## 已经有的功能

- 标题、备注、优先级、开始时间、截止时间、每个任务单独设提前几天提醒
- 标记完成 → 自动归到「已完成」，可撤销
- 默认按截止时间排；拖动某条就把它"钉"在当前位置，其它任务照常按时间流动
- 逾期 / 24 小时内 / 3 天内分级着色
- 软删除 + 撤销，回收站记录 7 天后自动清理
- 一键导出 JSON 备份到手机「下载」目录
- 检查更新（走 GitHub Releases）

## 目录结构

```
index.html css/ js/ icons/     网页本体（也是 App 里的界面）
android/                       安卓外壳：WebView + 通知 + 导出
  app/src/main/java/.../       MainActivity / Reminders / AlarmReceiver / BootReceiver
  app/src/main/assets/www/     由 tools/sync_android.py 从上面同步过去
tools/                         开发工具
  preview.py                   截一张当前界面（调样式用）
  sync_android.py              网页 → assets/www
  make_icons.py                生成全套图标
  push_via_api.py              绕开被墙的 git，用 REST API 推送
tests/test_logic.js            核心逻辑测试（jsdom + fake-indexeddb）
.github/workflows/build.yml    推送到 main 自动打 APK 并发 Release
```

## 开发

```bash
python tools/preview.py          # 看一眼界面长什么样
node tests/test_logic.js         # 跑逻辑测试（55 项）
python tools/sync_android.py     # 改完网页后同步进 App
```

测试依赖装一次即可：

```bash
cd tests && npm install
```

## 数据安全

- 任务存在手机本地 IndexedDB，卸载才会丢
- 「设置 → 导出备份」会把完整 JSON 存到「下载」目录，换手机可以导入
- 版本号每次构建自动递增，装新版直接覆盖，数据原地保留
