# 安卓外壳

把上一级的网页（`index.html` + `css/` + `js/`）包成原生 App。网页放在
`app/src/main/assets/www/`，由 `tools/sync_android.py` 从源目录同步过去。

网页做不到、必须由这一层实现的能力只有三个：

| 能力 | 在哪 |
|---|---|
| 到点推送系统通知 | `Reminders.java` + `AlarmReceiver.java` + `BootReceiver.java` |
| 把备份文件写进「下载」目录 | `MainActivity.writeDownload()` |
| 检查更新 | `MainActivity.fetchLatest()` |

## 通知是怎么工作的

1. 网页每次任务有增删改，就调 `TodoNative.syncAlarms(json)`，把**完整**的提醒列表整批传过来
2. `Reminders.sync()` 先取消旧闹钟，把列表存进 SharedPreferences，再逐条 `setExactAndAllowWhileIdle`
3. 闹钟到点 → `AlarmReceiver` 收到 → `Reminders.fire()` 弹通知
4. 手机重启或 App 升级后，`BootReceiver` 按存下的列表重建闹钟
   （AlarmManager 的闹钟在重启后会全部丢失，这是 Android 的既定行为）
5. App 每次打开时会 `catchUp()` 补发 12 小时内漏掉的提醒
   —— 国产 ROM 限制后台时闹钟可能没响，这一层是兜底

**为什么整批重排而不是增量**：增量调度看着省事，但只要某次同步漏掉一条，
残留或缺失的闹钟就很难排查。整批重排每次都是幂等的，代价只是几十毫秒。

**关于可靠性**：Android 13+ 需要 `POST_NOTIFICATIONS` 权限，Android 12+ 的精确闹钟
还要单独授权。没拿到精确闹钟权限时会退化成普通闹钟（可能晚几分钟），
而不是直接不提醒。小米/华为/OPPO 等系统还需要用户在系统设置里允许「自启动 / 后台运行」，
否则闹钟可能被压掉 —— 这一点 App 无法绕过。

## 构建与签名

CI（`.github/workflows/build.yml`）在推送 `main` 后自动构建，产出**未签名** APK
并发布成 `unsigned-*` 预览版；随后由本地 `tools/publish_release.py` 用固定密钥补签，
再发布成正式版 `v1.0.N`，资产名固定为 `todolist-latest.apk`。

为什么签名放在本地：当前 PAT 没有 Actions Secrets 权限，CI 拿不到密钥。
把 PAT 补上 `Secrets: Read and write` 之后就能全自动。

签名密钥在 `secrets/todolist-release.jks`（不入仓库），**一旦换密钥，手机上装过的版本
就必须卸载重装**，所以这个文件要备份好。

## 覆盖安装不丢数据的三个前提

| 条件 | 当前值 |
|---|---|
| 包名不变 | `com.chenziang.todolist` |
| 签名不变 | `secrets/todolist-release.jks` |
| versionCode 递增 | `1000 + 构建序号`，永远比上一版大 |

三条同时满足，系统才会走「覆盖安装」而不是拒绝安装。
