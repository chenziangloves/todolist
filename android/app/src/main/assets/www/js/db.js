/* TodoList 的本地存储层（IndexedDB）
 *
 * 一条任务长这样：
 *   id          唯一标识
 *   title       标题
 *   note        备注
 *   priority    2 高 / 1 中 / 0 低
 *   startAt     开始时间（毫秒时间戳，可为 null，表示"随时可做"）
 *   dueAt       截止时间（毫秒时间戳，必填）
 *   remindDays  提前几天提醒，0 表示截止当天
 *   done        是否已完成
 *   doneAt      完成时刻
 *   sortKey     排序键。新建时等于 dueAt，所以天然按截止时间排；
 *               用户拖动后只改这一条的 sortKey，它就"钉"在当前位置了。
 *   pinned      是否被手动调整过（界面据此显示"已手动排序"）
 *   savedDue    上一次为它排过闹钟的截止时间，用来判断要不要重排
 *   createdAt / updatedAt / deletedAt  软删除走 deletedAt
 */
(function (global) {
  'use strict';

  var DB_NAME = 'todolist';
  var DB_VER = 1;
  var STORE = 'tasks';
  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('sortKey', 'sortKey');
          os.createIndex('done', 'done');
          os.createIndex('deletedAt', 'deletedAt');
        }
      };
      req.onsuccess = function () {
        _db = req.result;
        resolve(_db);
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(mode) {
    return open().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function wrap(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function now() { return Date.now(); }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return 't' + now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* 新建一条任务。dueAt 必填，其余给默认值。 */
  function makeTask(input) {
    var t = now();
    var due = Number(input.dueAt) || t;
    return {
      id: uuid(),
      title: String(input.title || '').trim(),
      note: String(input.note || ''),
      priority: Number(input.priority) || 0,
      startAt: input.startAt ? Number(input.startAt) : null,
      dueAt: due,
      remindDays: input.remindDays === undefined ? 1 : Number(input.remindDays),
      done: false,
      doneAt: null,
      sortKey: due,
      pinned: false,
      savedDue: 0,
      createdAt: t,
      updatedAt: t,
      deletedAt: null
    };
  }

  function put(task) {
    task.updatedAt = now();
    return tx('readwrite').then(function (os) {
      return wrap(os.put(task)).then(function () { return task; });
    });
  }

  function get(id) {
    return tx('readonly').then(function (os) { return wrap(os.get(id)); });
  }

  function allRaw() {
    return tx('readonly').then(function (os) { return wrap(os.getAll()); });
  }

  /* 所有没被删除的任务 */
  function all() {
    return allRaw().then(function (list) {
      return list.filter(function (t) { return !t.deletedAt; });
    });
  }

  /* 未完成的任务，按排序键升序（截止时间近的在前） */
  function active() {
    return all().then(function (list) {
      return list
        .filter(function (t) { return !t.done; })
        .sort(function (a, b) {
          if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
          return a.createdAt - b.createdAt;
        });
    });
  }

  /* 已完成的任务，最近完成的在最上面 */
  function finished() {
    return all().then(function (list) {
      return list
        .filter(function (t) { return t.done; })
        .sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
    });
  }

  /* 改成已完成 / 撤回 */
  function setDone(id, done) {
    return get(id).then(function (t) {
      if (!t) return null;
      t.done = !!done;
      t.doneAt = done ? now() : null;
      return put(t);
    });
  }

  /* 软删除，便于"撤销" */
  function remove(id) {
    return get(id).then(function (t) {
      if (!t) return null;
      t.deletedAt = now();
      return put(t);
    });
  }

  function restore(id) {
    return get(id).then(function (t) {
      if (!t) return null;
      t.deletedAt = null;
      return put(t);
    });
  }

  /* 彻底删掉回收站里的旧数据（超过 7 天） */
  function purgeOld() {
    var cut = now() - 7 * 86400000;
    return allRaw().then(function (list) {
      var dead = list.filter(function (t) { return t.deletedAt && t.deletedAt < cut; });
      return dead.reduce(function (p, t) {
        return p.then(function () {
          return tx('readwrite').then(function (os) { return wrap(os.delete(t.id)); });
        });
      }, Promise.resolve()).then(function () { return dead.length; });
    });
  }

  /* 拖动排序：把 task 插到 target 与邻居之间
   *
   * 这里的间隔（GAP）给了 10 亿，约等于 31 年，是有意为之：
   * 拖到最前/最后，意味着「我就要它待在这儿别动」。如果只减 60 秒，
   * 之后来一条截止更早的新任务，仍会插到它前面，钉住就形同虚设。
   */
  var GAP = 1e9;

  function moveBefore(movingId, nextId, prevId) {
    return all().then(function (list) {
      var map = {};
      list.forEach(function (t) { map[t.id] = t; });
      var moving = map[movingId];
      if (!moving) return null;

      var lo = prevId && map[prevId] ? map[prevId].sortKey : null;
      var hi = nextId && map[nextId] ? map[nextId].sortKey : null;

      var key;
      if (lo === null && hi === null) {
        key = moving.sortKey;
      } else if (lo === null) {
        key = hi - GAP;                        // 拖到最前面：留足向下的空间
      } else if (hi === null) {
        key = lo + GAP;                        // 拖到最后面
      } else {
        key = (lo + hi) / 2;                   // 插在两者中间
      }
      if (!isFinite(key) || key === lo || key === hi) key = (lo || 0) + 1;

      moving.sortKey = key;
      moving.pinned = true;
      return put(moving);
    });
  }

  /* 恢复按截止时间排序（只影响这一条） */
  function unpin(id) {
    return get(id).then(function (t) {
      if (!t) return null;
      t.sortKey = t.dueAt;
      t.pinned = false;
      return put(t);
    });
  }

  /* 全部恢复自动排序 */
  function unpinAll() {
    return all().then(function (list) {
      var pins = list.filter(function (t) { return t.pinned; });
      return pins.reduce(function (p, t) {
        return p.then(function () { return unpin(t.id); });
      }, Promise.resolve()).then(function () { return pins.length; });
    });
  }

  /* 导出 / 导入（纯 JSON，方便你自己备份） */
  function exportAll() {
    return allRaw().then(function (list) {
      return {
        app: 'TodoList',
        version: 1,
        exportedAt: now(),
        tasks: list.map(function (t) {
          // sortKey 是内部实现，导出时带上也无妨
          return t;
        })
      };
    });
  }

  function importAll(data, mode) {
    var list = (data && data.tasks) || [];
    if (mode === 'replace') {
      return tx('readwrite').then(function (os) {
        return wrap(os.clear());
      }).then(function () {
        return list.reduce(function (p, t) {
          return p.then(function () { return put(t); });
        }, Promise.resolve()).then(function () { return list.length; });
      });
    }
    // merge：同 id 的跳过，不同 id 的补进来
    return allRaw().then(function (exist) {
      var seen = {};
      exist.forEach(function (t) { seen[t.id] = true; });
      var add = list.filter(function (t) { return t.id && !seen[t.id]; });
      return add.reduce(function (p, t) {
        return p.then(function () { return put(t); });
      }, Promise.resolve()).then(function () { return add.length; });
    });
  }

  global.DB = {
    open: open,
    makeTask: makeTask,
    put: put,
    get: get,
    all: all,
    active: active,
    finished: finished,
    setDone: setDone,
    remove: remove,
    restore: restore,
    purgeOld: purgeOld,
    moveBefore: moveBefore,
    unpin: unpin,
    unpinAll: unpinAll,
    exportAll: exportAll,
    importAll: importAll
  };
})(window);
