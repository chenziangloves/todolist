/* TodoList 主逻辑
 *
 * 排序这件事值得先说明，因为它是这个 App 最容易做拧的地方：
 * 每个任务有个 sortKey，新建时直接等于截止时间。列表按 sortKey 升序，
 * 于是"天然按截止时间排"。用户拖动某条任务时，只改这一条的 sortKey
 * （取它前后两个邻居的中间值），它就"钉"在当前位置了，其它任务照旧
 * 按截止时间流动。界面上给这类任务标一个「已手动排序」，点一下恢复。
 */
(function () {
  'use strict';

  var DAY = 86400000;
  var state = {
    view: 'active',
    active: [],
    done: [],
    editing: null,      // 正在编辑的任务对象；null 表示新建
    draft: null,
    noDueWarned: false
  };

  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }

  /* ---------------- 时间小工具 ---------------- */

  function startOfDay(ts) {
    var d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function todayStart() { return startOfDay(Date.now()); }

  /* 今天 / 明天 / 后天 / N 天后 / 已逾期 N 天 */
  function relDay(ts) {
    var diff = Math.round((startOfDay(ts) - todayStart()) / DAY);
    if (diff === 0) return '今天';
    if (diff === 1) return '明天';
    if (diff === 2) return '后天';
    if (diff === -1) return '昨天';
    if (diff < 0) return '已逾期 ' + (-diff) + ' 天';
    if (diff <= 7) return diff + ' 天后';
    return '';
  }

  function hhmm(ts) {
    var d = new Date(ts);
    var h = d.getHours(), m = d.getMinutes();
    if (h === 0 && m === 0) return '';
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function fmtDue(ts) {
    if (!ts) return '未设截止';
    var rel = relDay(ts);
    var t = hhmm(ts);
    // 已经逾期的不再显示几点几分，只说逾期几天，信息更干净
    if (rel && rel.indexOf('已逾期') === 0) return rel;
    if (rel) return t ? rel + ' ' + t : rel;
    var d = new Date(ts);
    var s = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    if (d.getFullYear() !== new Date().getFullYear()) s = d.getFullYear() + '年' + s;
    return t ? s + ' ' + t : s;
  }

  /* 开始时间只用日期表述，不需要精确到分钟 */
  function fmtStart(ts) {
    var rel = relDay(ts);
    if (rel && rel.indexOf('已逾期') !== 0) return rel + '开始';
    var d = new Date(ts);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日开始';
  }

  /* 紧急程度：overdue / soon(24h内) / upcoming(3天内) / normal */
  function urgency(t) {
    var left = t.dueAt - Date.now();
    if (left < 0) return 'overdue';
    if (left <= DAY) return 'soon';
    if (left <= 3 * DAY) return 'upcoming';
    return 'normal';
  }

  /* datetime-local 需要的本地时间字符串，不能用 toISOString（那是 UTC） */
  function toInputValue(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fromInputValue(v) {
    if (!v) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
  }

  function defaultDue() {
    var d = new Date();
    d.setHours(18, 0, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  /* ---------------- toast ---------------- */

  var toastTimer = null;
  function toast(msg, onUndo, undoText) {
    var el = $('#toast');
    el.innerHTML = '';
    el.appendChild(document.createTextNode(msg));
    if (onUndo) {
      var b = document.createElement('span');
      b.className = 'undo';
      b.textContent = undoText || '撤销';
      b.onclick = function () {
        el.classList.remove('on');
        onUndo();
      };
      el.appendChild(b);
    }
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, onUndo ? 5000 : 2200);
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    var list = $('#list');
    var items = state.view === 'active' ? state.active : state.done;

    $('#n-active').textContent = state.active.length;
    $('#n-done').textContent = state.done.length;
    $$('.tab').forEach(function (b) {
      b.classList.toggle('on', b.dataset.view === state.view);
    });

    renderHeader();

    if (!items.length) {
      list.innerHTML = state.view === 'active'
        ? '<div class="empty"><div class="ico">◎</div><p>现在没有待办<br>点右下角加一件要做的事</p></div>'
        : '<div class="empty"><div class="ico">✓</div><p>还没有完成的任务</p></div>';
      return;
    }

    var html = [];
    items.forEach(function (t, i) {
      html.push(itemHtml(t, i));
    });
    list.innerHTML = html.join('');
    bindItems();
  }

  function renderHeader() {
    var d = new Date();
    var week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    $('#head-date').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + week;

    var today = 0, overdue = 0, week7 = 0;
    var now = Date.now();
    state.active.forEach(function (t) {
      var left = t.dueAt - now;
      if (left < 0) overdue++;
      else if (startOfDay(t.dueAt) === todayStart()) today++;
      else if (left <= 7 * DAY) week7++;
    });

    var sum = $('#head-sum');
    if (!state.active.length) {
      sum.innerHTML = '还没有任务';
      return;
    }
    var parts = [];
    if (overdue) parts.push('<b class="hot">' + overdue + '</b> 件已逾期');
    if (today) parts.push('<b>' + today + '</b> 件今天到期');
    if (week7) parts.push('<span class="soon">' + week7 + '</span> 件 7 天内');
    if (!parts.length) parts.push('共 <b>' + state.active.length + '</b> 件待办');
    sum.innerHTML = parts.join(' · ');
  }

  var PRIO_TEXT = { 2: '高', 1: '中', 0: '低' };

  function itemHtml(t, idx) {
    var u = urgency(t);
    var cls = 'item';
    if (u === 'overdue') cls += ' overdue';
    if (u === 'soon') cls += ' due-soon';

    var meta = [];
    // 截止
    var dueCls = u === 'overdue' ? 'urgent' : (u === 'soon' ? 'soon' : '');
    meta.push('<span class="m ' + dueCls + '">' +
      icoClock() + fmtDue(t.dueAt) + '</span>');

    // 还没开始的，标出来
    if (t.startAt && t.startAt > Date.now()) {
      meta.push('<span class="m">' + icoPlay() + fmtStart(t.startAt) + '</span>');
    }
    // 提醒
    if (t.remindDays >= 0) {
      meta.push('<span class="m">' + icoBell() +
        (t.remindDays === 0 ? '当天提醒' : '提前' + t.remindDays + '天') + '</span>');
    }
    // 手动排序标记（只留一个图钉，文字太长会挤爆一行）
    if (t.pinned) {
      meta.push('<span class="m pin" data-unpin="' + t.id + '" title="已手动排序，点一下恢复">' +
        icoPin() + '手动排序</span>');
    }

    var prio = Number(t.priority) || 0;

    return '<div class="' + cls + '" data-id="' + t.id + '" data-p="' + prio + '" data-idx="' + idx + '">' +
      '<button class="check" data-toggle="' + t.id + '" aria-label="完成">' +
      '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7"/></svg></button>' +
      '<div class="body">' +
      '<div class="t-title">' + esc(t.title) + '</div>' +
      (t.note ? '<div class="t-note">' + esc(t.note) + '</div>' : '') +
      '<div class="t-meta">' + meta.join('') +
      (prio === 2 ? '<span class="pill high">高</span>' : '') +
      '</div></div></div>';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function icoClock() {
    return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg>';
  }
  function icoPlay() {
    return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l6 3.5-6 3.5z"/></svg>';
  }
  function icoBell() {
    return '<svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 1112 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9z"/><path d="M10 18a2 2 0 004 0"/></svg>';
  }
  function icoPin() {
    return '<svg viewBox="0 0 24 24"><path d="M12 3v9"/><circle cx="12" cy="16" r="4.5"/></svg>';
  }

  /* ---------------- 列表交互 ---------------- */

  function bindItems() {
    var list = $('#list');

    list.onclick = function (e) {
      var check = e.target.closest('[data-toggle]');
      if (check) {
        e.stopPropagation();
        toggleDone(check.dataset.toggle);
        return;
      }
      var unpin = e.target.closest('[data-unpin]');
      if (unpin) {
        e.stopPropagation();
        DB.unpin(unpin.dataset.unpin).then(function () {
          return load();
        }).then(function () {
          toast('已恢复按截止时间排序');
          syncAlarms();
        });
        return;
      }
      var item = e.target.closest('.item');
      if (item && !dragging.moved) {
        var t = findTask(item.dataset.id);
        if (t) openSheet(t);
      }
    };

    bindDrag(list);
  }

  function findTask(id) {
    var all = state.active.concat(state.done);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* ---------------- 长按拖动排序 ---------------- */

  var dragging = {
    on: false, moved: false, el: null, startY: 0, lastY: 0, timer: null, ph: null
  };

  function bindDrag(list) {
    list.onpointerdown = function (e) {
      if (state.view !== 'active') return;
      if (e.target.closest('.check') || e.target.closest('[data-unpin]')) return;
      var el = e.target.closest('.item');
      if (!el) return;

      dragging.el = el;
      dragging.startY = e.clientY;
      dragging.lastY = e.clientY;
      dragging.on = false;
      dragging.moved = false;

      clearTimeout(dragging.timer);
      // 长按 180ms 才进入拖动，避免和列表滚动打架
      dragging.timer = setTimeout(function () {
        beginDrag(el, e.clientY);
      }, 180);

      el.setPointerCapture && el.setPointerCapture(e.pointerId);
    };

    list.onpointermove = function (e) {
      if (!dragging.el) return;
      var dy = e.clientY - dragging.startY;

      if (!dragging.on) {
        // 还没长按就划走了 —— 放弃拖动，让列表正常滚
        if (Math.abs(dy) > 8) {
          clearTimeout(dragging.timer);
          dragging.el = null;
        }
        return;
      }

      e.preventDefault();
      dragging.moved = true;
      dragging.lastY = e.clientY;
      dragging.el.style.transform = 'translateY(' + dy + 'px)';

      // 越过邻居一半就把 DOM 顺序换一换
      var el = dragging.el;
      var prev = el.previousElementSibling;
      var next = el.nextElementSibling;

      if (prev && el.getBoundingClientRect().top < prev.getBoundingClientRect().top +
          prev.getBoundingClientRect().height / 2) {
        list.insertBefore(el, prev);
        dragging.startY = e.clientY;
        el.style.transform = 'translateY(0)';
        Native.vibrate(8);
      } else if (next && el.getBoundingClientRect().bottom >
          next.getBoundingClientRect().bottom - next.getBoundingClientRect().height / 2) {
        list.insertBefore(next, el);
        dragging.startY = e.clientY;
        el.style.transform = 'translateY(0)';
        Native.vibrate(8);
      }
    };

    function finish(e) {
      clearTimeout(dragging.timer);
      if (dragging.on && dragging.moved) {
        commitDrag();
      }
      if (dragging.el) {
        dragging.el.classList.remove('dragging');
        dragging.el.style.transform = '';
      }
      dragging.on = false;
      dragging.el = null;
      // 让这次的 click 不要误触发"打开编辑"
      setTimeout(function () { dragging.moved = false; }, 30);
    }

    list.onpointerup = finish;
    list.onpointercancel = finish;
    list.onpointerleave = function (e) {
      if (dragging.on) finish(e);
    };
  }

  function beginDrag(el, y) {
    if (!dragging.el || state.view !== 'active') return;
    dragging.on = true;
    dragging.startY = y;
    el.classList.add('dragging');
    Native.vibrate(14);
  }

  function commitDrag() {
    var list = $('#list');
    var nodes = $$('#list .item');
    var el = dragging.el;
    var idx = nodes.indexOf(el);
    if (idx < 0) return;

    var prev = nodes[idx - 1];
    var next = nodes[idx + 1];
    var id = el.dataset.id;
    var prevId = prev ? prev.dataset.id : null;
    var nextId = next ? next.dataset.id : null;

    DB.moveBefore(id, nextId, prevId).then(function () {
      return load();
    }).then(function () {
      toast('已调整顺序');
      syncAlarms();
    });
  }

  /* ---------------- 完成 / 删除 ---------------- */

  function toggleDone(id) {
    var t = findTask(id);
    if (!t) return;
    var to = !t.done;
    DB.setDone(id, to).then(function () {
      return load();
    }).then(function () {
      Native.vibrate(10);
      if (to) {
        toast('已完成', function () {
          DB.setDone(id, false).then(load).then(syncAlarms);
        }, '撤销');
      }
      syncAlarms();
    });
  }

  /* ---------------- 新建 / 编辑 ---------------- */

  function openSheet(task) {
    state.editing = task || null;
    var isNew = !task;
    $('#sh-title').textContent = isNew ? '新任务' : '编辑任务';
    $('#sh-del').classList.toggle('hidden', isNew);

    var d = task || {
      title: '', note: '', priority: 1,
      startAt: null, dueAt: defaultDue(), remindDays: 1
    };
    $('#f-title').value = d.title || '';
    $('#f-note').value = d.note || '';
    $('#f-start').value = toInputValue(d.startAt);
    $('#f-due').value = toInputValue(d.dueAt);
    setSeg('#f-priority', String(d.priority == null ? 1 : d.priority));
    setSeg('#f-remind', String(d.remindDays == null ? 1 : d.remindDays));

    $('#sheet-mask').classList.add('on');
    setTimeout(function () { $('#f-title').focus(); }, 220);
  }

  function closeSheet() {
    $('#sheet-mask').classList.remove('on');
    state.editing = null;
  }

  function setSeg(sel, val) {
    $$(sel + ' .seg-i').forEach(function (b) {
      var v = b.dataset.p !== undefined ? b.dataset.p : b.dataset.d;
      b.classList.toggle('on', v === val);
    });
  }

  function segValue(sel) {
    var on = $(sel + ' .seg-i.on');
    if (!on) return null;
    return on.dataset.p !== undefined ? on.dataset.p : on.dataset.d;
  }

  function saveSheet() {
    var title = $('#f-title').value.trim();
    if (!title) {
      toast('给它起个名字吧');
      $('#f-title').focus();
      return;
    }
    var due = fromInputValue($('#f-due').value);
    if (!due) {
      toast('请设置截止时间');
      $('#f-due').focus();
      return;
    }
    var start = fromInputValue($('#f-start').value);
    if (start && start > due) {
      toast('开始时间不能晚于截止时间');
      return;
    }

    var data = {
      title: title,
      note: $('#f-note').value.trim(),
      priority: Number(segValue('#f-priority')),
      startAt: start,
      dueAt: due,
      remindDays: Number(segValue('#f-remind'))
    };

    var isEdit = !!state.editing;
    var p;
    if (isEdit) {
      var t = state.editing;
      var dueChanged = t.dueAt !== due;
      t.title = data.title;
      t.note = data.note;
      t.priority = data.priority;
      t.startAt = data.startAt;
      t.dueAt = data.dueAt;
      t.remindDays = data.remindDays;
      // 截止时间变了、而它又没被手动钉住，就跟着新截止时间走
      if (dueChanged && !t.pinned) t.sortKey = due;
      p = DB.put(t);
    } else {
      p = DB.put(DB.makeTask(data));
    }

    p.then(function () {
      closeSheet();
      return load();
    }).then(function () {
      syncAlarms();
      toast(isEdit ? '已保存' : '已加入清单');
    });
  }

  function deleteEditing() {
    if (!state.editing) return;
    var id = state.editing.id;
    var title = state.editing.title;
    closeSheet();
    DB.remove(id).then(function () {
      return load();
    }).then(function () {
      syncAlarms();
      toast('已删除「' + title.slice(0, 10) + '」', function () {
        DB.restore(id).then(load).then(syncAlarms);
      }, '撤销');
    });
  }

  /* ---------------- 数据加载 ---------------- */

  function load() {
    return Promise.all([DB.active(), DB.finished()]).then(function (r) {
      state.active = r[0];
      state.done = r[1];
      render();
    });
  }

  /* ---------------- 通知调度 ---------------- */

  /* 把未来要提醒的时刻整批交给原生。
   * 只交"还没到点"的；已经过点的由 App 打开时的补发逻辑处理。 */
  function syncAlarms() {
    var now = Date.now();
    var items = [];
    state.active.forEach(function (t) {
      if (t.remindDays < 0) return;              // -1 表示不提醒
      var remindAt = t.dueAt - t.remindDays * DAY;
      // 已经过点的提醒不再排（避免一打开就炸一堆通知）；但保留 2 小时内的补救窗口
      if (remindAt + 2 * 3600 * 1000 < now) return;
      items.push({
        id: t.id,
        title: t.title,
        remindAt: remindAt,
        dueAt: t.dueAt
      });
    });
    Native.syncAlarms(items);
  }

  /* ---------------- 菜单 ---------------- */

  function openMenu() {
    $('#menu-mask').classList.add('on');
    var st = Native.notifState();
    var map = {
      granted: '已允许', denied: '被拒绝', prompt: '未授权',
      unsupported: '浏览器里不支持'
    };
    $('#m-notif-v').textContent = map[st] || st;
    var v = Native.appVersion();
    $('#m-ver').textContent = v ? 'v' + v : '开发版';
  }

  function closeMenu() {
    $('#menu-mask').classList.remove('on');
  }

  function doExport() {
    DB.exportAll().then(function (data) {
      var text = JSON.stringify(data, null, 2);
      var name = 'todolist-' + new Date().toISOString().slice(0, 10) + '.json';
      var path = Native.saveText(name, text);

      if (!path && navigator.clipboard) {
        return navigator.clipboard.writeText(text).then(function () {
          toast('已复制到剪贴板（共 ' + data.tasks.length + ' 条）');
        });
      }
      if (!path) {
        // 浏览器兜底：直接下载
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
        toast('已下载 ' + name);
        return;
      }
      toast('已保存到 ' + path, null);
    });
  }

  function doCheckUpdate() {
    var rid = Native.checkUpdate();
    if (!rid) {
      toast('浏览器里无法检查更新');
      return;
    }
    toast('正在检查…');
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var raw = Native.pollUpdate(rid);
      if (!raw) {
        if (tries > 20) { clearInterval(timer); toast('检查超时，请稍后再试'); }
        return;
      }
      clearInterval(timer);
      var r;
      try { r = JSON.parse(raw); } catch (e) { toast('返回内容异常'); return; }

      if (r.ok && r.hasUpdate) {
        toast('发现新版本 v' + r.version);
        if (r.url) setTimeout(function () { Native.openUrl(r.url); }, 900);
      } else if (r.ok) {
        toast('已是最新版本');
      } else {
        toast(r.error || '检查失败');
      }
    }, 700);
  }

  /* ---------------- 启动 ---------------- */

  function bindStatic() {
    $('#fab').onclick = function () { openSheet(null); };
    $('#sh-cancel').onclick = closeSheet;
    $('#sh-save').onclick = saveSheet;
    $('#sh-del').onclick = deleteEditing;
    $('#sheet-mask').onclick = function (e) {
      if (e.target === $('#sheet-mask')) closeSheet();
    };

    $$('.tab').forEach(function (b) {
      b.onclick = function () {
        state.view = b.dataset.view;
        render();
      };
    });

    $('#f-priority').onclick = function (e) {
      var b = e.target.closest('.seg-i');
      if (b) setSeg('#f-priority', b.dataset.p);
    };
    $('#f-remind').onclick = function (e) {
      var b = e.target.closest('.seg-i');
      if (b) setSeg('#f-remind', b.dataset.d);
    };

    $('#btn-menu').onclick = openMenu;
    $('#m-close').onclick = closeMenu;
    $('#menu-mask').onclick = function (e) {
      if (e.target === $('#menu-mask')) closeMenu();
    };
    $('#m-export').onclick = function () { closeMenu(); doExport(); };
    $('#m-check').onclick = function () { closeMenu(); doCheckUpdate(); };
    $('#m-unpin').onclick = function () {
      closeMenu();
      DB.unpinAll().then(function (n) {
        return load().then(function () {
          toast(n ? '已恢复 ' + n + ' 条的自动排序' : '没有手动调整过的任务');
          syncAlarms();
        });
      });
    };
    $('#m-notif').onclick = function () {
      var st = Native.notifState();
      if (st === 'granted') {
        toast('通知权限已开启');
        return;
      }
      if (Native.requestNotif()) {
        toast('已发出申请，请在系统弹窗里允许');
      } else {
        toast('浏览器里收不到系统通知');
      }
    };

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if ($('#sheet-mask').classList.contains('on')) closeSheet();
        else if ($('#menu-mask').classList.contains('on')) closeMenu();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if ($('#sheet-mask').classList.contains('on')) {
          e.preventDefault();
          saveSheet();
        }
      }
    });

    // 页面回到前台时刷新一次（时间相关的文案会变）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        load().then(syncAlarms);
      }
    });
  }

  function boot() {
    bindStatic();
    DB.open()
      .then(function () { return DB.purgeOld(); })
      .then(function () { return load(); })
      .then(function () {
        syncAlarms();
        // 每天 0 点之后重算一次"今天/逾期"，文案才不会停在昨天
        setInterval(function () {
          renderHeader();
        }, 60000);
      })
      .catch(function (e) {
        document.body.innerHTML =
          '<div style="padding:40px;color:#ff5f57;font-size:14px;line-height:1.8">' +
          '启动失败：' + (e && e.message ? e.message : e) + '</div>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 安卓返回键会先问这里：有弹层就关弹层，没有就让系统退到后台
  window.__back = function () {
    if ($('#sheet-mask').classList.contains('on')) { closeSheet(); return true; }
    if ($('#menu-mask').classList.contains('on')) { closeMenu(); return true; }
    if (state.view === 'done') { state.view = 'active'; render(); return true; }
    return false;
  };

  // 暴露给测试与开发调试用
  window.__app = {
    relDay: relDay,
    fmtDue: fmtDue,
    urgency: urgency,
    state: state,
    load: load,
    syncAlarms: syncAlarms,
    /* 灌一批数据，截图和自动化测试都用它 */
    seed: function (list) {
      var p = Promise.resolve();
      (list || []).forEach(function (o) {
        p = p.then(function () {
          var t = DB.makeTask(o);
          return DB.put(t).then(function () {
            if (o.done) return DB.setDone(t.id, true);
          });
        });
      });
      return p.then(load);
    }
  };
})();
