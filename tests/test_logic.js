/* TodoList 核心逻辑测试
 *
 * 用 jsdom + fake-indexeddb 把真实的 db.js / app.js 跑起来，
 * 不依赖真机、不依赖无头浏览器（无头浏览器里 IndexedDB 回调不触发）。
 *
 * 重点验证「排序」这套设计：新建按截止时间排、拖动只钉住被拖的那条、
 * 新任务插入不破坏已钉住的位置。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const stripped = html.replace(/<script[^>]*><\/script>/g, '');

const DAY = 86400000;
let pass = 0, failN = 0;

function ok(m) { console.log('✓ ' + m); pass++; }
function fail(m) { console.log('✗ ' + m); failN++; process.exitCode = 1; }
function eq(actual, expected, label) {
  if (actual === expected) ok(label);
  else fail(label + ' → 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

function boot() {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', (e) => errs.push(String((e && e.message) || e)));

  const dom = new JSDOM(stripped, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.indexedDB = new IDBFactory();
      window.IDBKeyRange = IDBKeyRange;
      window.scrollTo = () => {};
      window.matchMedia = window.matchMedia || function () {
        return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
      };
    },
  });

  const w = dom.window;
  for (const rel of ['js/db.js', 'js/native.js', 'js/app.js']) {
    w.eval(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  }
  return { w, dom, errs };
}

async function main() {
  const { w, dom, errs } = boot();
  const DB = w.DB;
  await new Promise((r) => setTimeout(r, 250));

  if (errs.length) fail('页面脚本报错：' + errs.join(' | '));
  else ok('三个脚本加载无异常');

  const now = Date.now();

  /* ---------- 1. 新建任务的默认值 ---------- */
  const t1 = DB.makeTask({ title: ' A 最早 ', dueAt: now + 1 * DAY });
  eq(t1.title, 'A 最早', '标题去掉首尾空格');
  eq(t1.sortKey, t1.dueAt, '新任务的排序键等于截止时间');
  eq(t1.pinned, false, '新任务不是手动排序状态');
  eq(t1.done, false, '新任务默认未完成');
  eq(t1.remindDays, 1, '默认提前 1 天提醒');
  eq(DB.makeTask({ title: 'x' }).dueAt > 0, true, '不传截止时间时给一个兜底值');

  /* ---------- 2. 按截止时间排序 ---------- */
  const t2 = DB.makeTask({ title: 'B 中间', dueAt: now + 3 * DAY });
  const t3 = DB.makeTask({ title: 'C 最晚', dueAt: now + 7 * DAY });
  await DB.put(t3); await DB.put(t1); await DB.put(t2);      // 故意乱序写入

  let list = await DB.active();
  eq(list.map((x) => x.title).join(','), 'A 最早,B 中间,C 最晚', '按截止时间升序排列（与写入顺序无关）');

  /* ---------- 3. 完成与撤销 ---------- */
  await DB.setDone(t2.id, true);
  eq((await DB.active()).length, 2, '标记完成后从待办里消失');
  eq((await DB.finished()).length, 1, '已完成里有 1 条');
  eq((await DB.finished())[0].title, 'B 中间', '已完成里就是刚才那条');
  eq((await DB.finished())[0].doneAt > 0, true, '记录了完成时刻');

  await DB.setDone(t2.id, false);
  eq((await DB.active()).length, 3, '撤销完成后回到待办');
  eq((await DB.finished()).length, 0, '已完成清空');
  eq((await DB.get(t2.id)).doneAt, null, '撤销后完成时刻被清掉');

  /* ---------- 4. 拖动排序：把最晚的拖到最前 ---------- */
  await DB.moveBefore(t3.id, t1.id, null);
  list = await DB.active();
  eq(list[0].id, t3.id, '拖到最前：C 排第一');
  eq(list[0].pinned, true, '被拖的任务标记为手动排序');
  eq(list[0].sortKey < list[1].sortKey, true, '排序键确实排到了前面');
  eq(list[0].sortKey !== list[0].dueAt, true, '排序键已经偏离它自己的截止时间');

  /* ---------- 5. 新任务插入不破坏已钉住的位置 ---------- */
  const t4 = DB.makeTask({ title: 'D 明天', dueAt: now + 0.5 * DAY });
  await DB.put(t4);
  list = await DB.active();
  eq(list[0].id, t3.id, '新任务插入后，钉住的那条仍在最前');
  eq(list[1].id, t4.id, '新任务按截止时间插到第二位');
  eq(list[0].pinned, true, '钉住状态没被新任务影响');

  /* ---------- 6. 拖到中间 ---------- */
  // 现在顺序：C(钉) D A B，把 B 拖到 A 和 D 之间
  await DB.moveBefore(t2.id, t4.id, t1.id);
  list = await DB.active();
  const idxB = list.findIndex((x) => x.id === t2.id);
  const idxA = list.findIndex((x) => x.id === t1.id);
  const idxD = list.findIndex((x) => x.id === t4.id);
  eq(idxB, idxD + 1, 'B 插到了 D 后面');
  eq(idxB, idxA - 1, 'B 插到了 A 前面');
  eq(list[idxB].pinned, true, '插中间后也标记为手动排序');

  /* ---------- 7. 拖到最后 ---------- */
  await DB.moveBefore(t3.id, null, list[list.length - 1].id);
  list = await DB.active();
  eq(list[list.length - 1].id, t3.id, '拖到最后：C 排末尾');

  /* ---------- 8. 恢复自动排序 ---------- */
  await DB.unpin(t3.id);
  const c = await DB.get(t3.id);
  eq(c.sortKey, c.dueAt, '单条恢复后排序键回到截止时间');
  eq(c.pinned, false, '单条恢复后去掉手动标记');

  await DB.put(Object.assign(await DB.get(t2.id), { pinned: true, sortKey: 1 }));
  const n = await DB.unpinAll();
  eq(n >= 1, true, '批量恢复至少处理了 1 条');
  eq((await DB.active()).every((x) => !x.pinned), true, '批量恢复后没有手动排序的残留');

  /* ---------- 9. 软删除与恢复 ---------- */
  await DB.remove(t4.id);
  eq((await DB.active()).some((x) => x.id === t4.id), false, '删除后从待办消失');
  eq((await DB.all()).some((x) => x.id === t4.id), false, '删除后也不在正常数据里');
  await DB.restore(t4.id);
  eq((await DB.active()).some((x) => x.id === t4.id), true, '撤销删除后回来了');

  /* ---------- 10. 过期回收站清理 ---------- */
  const old = await DB.get(t4.id);
  old.deletedAt = Date.now() - 8 * DAY;
  await DB.put(old);
  const purged = await DB.purgeOld();
  eq(purged, 1, '清理掉 1 条超过 7 天的删除记录');
  eq(await DB.get(t4.id), undefined, '超期记录被彻底移除');

  /* ---------- 11. 导出与导入 ---------- */
  const dump = await DB.exportAll();
  eq(dump.app, 'TodoList', '导出数据带有应用标识');
  eq(dump.tasks.length >= 3, true, '导出包含全部任务');

  const before = (await DB.all()).length;
  const added = await DB.importAll(dump, 'merge');
  eq(added, 0, '导入同一份数据时不会重复添加');
  eq((await DB.all()).length, before, '导入后条数没变');

  const fresh = DB.makeTask({ title: '外来的任务', dueAt: now + 2 * DAY });
  const added2 = await DB.importAll({ tasks: [fresh] }, 'merge');
  eq(added2, 1, '导入一条新任务成功');
  eq((await DB.all()).length, before + 1, '导入后条数 +1');

  const replaced = await DB.importAll({ tasks: [fresh] }, 'replace');
  eq(replaced, 1, '覆盖导入返回写入条数');
  eq((await DB.all()).length, 1, '覆盖导入后只剩导入的那条');

  /* ---------- 12. 时间文案 ---------- */
  const A = w.__app;
  eq(A.relDay(now), '今天', '今天');
  eq(A.relDay(now + DAY), '明天', '明天');
  eq(A.relDay(now + 2 * DAY), '后天', '后天');
  eq(A.relDay(now - DAY), '昨天', '昨天');
  eq(A.relDay(now - 3 * DAY), '已逾期 3 天', '逾期天数');
  eq(A.relDay(now + 5 * DAY), '5 天后', '未来几天');

  const overdue = A.fmtDue(now - 2 * DAY);
  eq(overdue, '已逾期 2 天', '逾期任务不显示具体时刻');
  eq(/今天|明天/.test(A.fmtDue(now + 3 * 3600 * 1000)), true, '近期任务显示相对日期');

  eq(A.urgency({ dueAt: now - 1000 }), 'overdue', '紧急程度：逾期');
  eq(A.urgency({ dueAt: now + 3600 * 1000 }), 'soon', '紧急程度：24 小时内');
  eq(A.urgency({ dueAt: now + 2 * DAY }), 'upcoming', '紧急程度：3 天内');
  eq(A.urgency({ dueAt: now + 9 * DAY }), 'normal', '紧急程度：普通');

  /* ---------- 收尾 ---------- */
  console.log('\n通过 ' + pass + ' 项，失败 ' + failN + ' 项');
  dom.window.close();
  process.exit(failN ? 1 : 0);
}

main().catch((e) => {
  console.log('✗ 测试崩溃：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
