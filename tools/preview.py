# -*- coding: utf-8 -*-
"""截一张当前界面的图，方便调样式。

用法：
    python tools/preview.py              # 出图到 _preview.png
    python tools/preview.py --done       # 切到「已完成」标签再截图
    python tools/preview.py --sheet      # 打开新建任务的弹层再截图

它做的事：把 index.html 复制成 _preview.html，用一份假数据顶掉 IndexedDB
（无头浏览器里 IndexedDB 的回调不会触发，只能用假数据），页面按 390x844
的手机框居中，再用无头 Edge 截一张。

注意：临时文件都以 _ 开头，.gitignore 里已经挡掉了。
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
PORT = 8911

D = 86400000


def build_page(extra_js):
    now = "Date.now()"
    seed = """
(function () {
  var D = 86400000, now = Date.now();
  var base = [
    { id:'a1', title:'提交三季度考核表', note:'HR 系统里填，需要主管签字确认', priority:2,
      startAt:null, dueAt: now - 2*D, remindDays:1, done:false, doneAt:null,
      sortKey: now - 2*D, pinned:false, createdAt:1, updatedAt:1, deletedAt:null },
    { id:'a2', title:'把本周周报发给组长', note:'', priority:1,
      startAt:null, dueAt: now + 3*3600000, remindDays:0, done:false, doneAt:null,
      sortKey: now + 3*3600000, pinned:false, createdAt:2, updatedAt:2, deletedAt:null },
    { id:'a3', title:'学习 Git 分支管理', note:'看完 Pro Git 第 3 章，把 merge 和 rebase 各练一遍', priority:0,
      startAt:null, dueAt: now + 1*D, remindDays:1, done:false, doneAt:null,
      sortKey: now + 1*D, pinned:false, createdAt:3, updatedAt:3, deletedAt:null },
    { id:'a4', title:'准备下周一项目启动会材料', note:'', priority:2,
      startAt: now + 3*D, dueAt: now + 5*D, remindDays:2, done:false, doneAt:null,
      sortKey: now + 5*D, pinned:true, createdAt:4, updatedAt:4, deletedAt:null },
    { id:'a5', title:'整理需求评审意见', note:'把上周会议里待确认的 6 个问题归类', priority:1,
      startAt:null, dueAt: now + 9*D, remindDays:3, done:false, doneAt:null,
      sortKey: now + 9*D, pinned:false, createdAt:5, updatedAt:5, deletedAt:null }
  ];
  var doneList = [
    { id:'b1', title:'熟悉公司内网与报销流程', note:'', priority:1,
      startAt:null, dueAt: now - 1*D, remindDays:1, done:true, doneAt: now - 12*3600000,
      sortKey: now - 1*D, pinned:false, createdAt:6, updatedAt:6, deletedAt:null }
  ];
  window.DB = {
    open: function(){ return Promise.resolve(); },
    purgeOld: function(){ return Promise.resolve(0); },
    active: function(){ return Promise.resolve(base.slice()); },
    finished: function(){ return Promise.resolve(doneList.slice()); },
    get: function(){ return Promise.resolve(null); },
    put: function(t){ return Promise.resolve(t); },
    makeTask: function(){ return {}; },
    setDone: function(){ return Promise.resolve(null); },
    remove: function(){ return Promise.resolve(null); },
    restore: function(){ return Promise.resolve(null); },
    moveBefore: function(){ return Promise.resolve(null); },
    unpin: function(){ return Promise.resolve(null); },
    unpinAll: function(){ return Promise.resolve(0); },
    exportAll: function(){ return Promise.resolve({tasks:[]}); },
    importAll: function(){ return Promise.resolve(0); }
  };
})();
"""

    frame_css = """
<style>
  html, body { background: #05070a; }
  body { display: flex; align-items: center; justify-content: center; }
  .app {
    width: 390px; height: 844px;
    border-radius: 26px; overflow: hidden;
    box-shadow: 0 24px 70px rgba(0,0,0,.75), 0 0 0 1px #1d2229;
  }
</style>
"""

    src = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    src = src.replace('<script src="js/db.js"></script>',
                      '<script src="js/db.js"></script>\n<script>' + seed + '</script>')
    src = src.replace('</head>', frame_css + '</head>')
    if extra_js:
        src = src.replace('</body>', '<script>' + extra_js + '</script>\n</body>')
    return src


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='_preview.png')
    ap.add_argument('--done', action='store_true', help='截「已完成」页')
    ap.add_argument('--sheet', action='store_true', help='截新建任务弹层')
    ap.add_argument('--width', type=int, default=470)
    ap.add_argument('--height', type=int, default=900)
    args = ap.parse_args()

    extra = ''
    if args.done:
        extra += ('setTimeout(function(){'
                  'document.querySelector(".tab[data-view=done]").click();'
                  '}, 700);')
    if args.sheet:
        extra += 'setTimeout(function(){ document.querySelector("#fab").click(); }, 700);'

    page = os.path.join(ROOT, '_preview.html')
    open(page, 'w', encoding='utf-8').write(build_page(extra))

    exe = EDGE if os.path.isfile(EDGE) else (CHROME if os.path.isfile(CHROME) else None)
    if not exe:
        print('找不到 Edge 或 Chrome')
        return 1

    srv = subprocess.Popen(
        [sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1'],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        import time
        time.sleep(1.5)
        out = os.path.join(ROOT, args.out)
        if os.path.isfile(out):
            os.remove(out)
        subprocess.run([
            exe, '--headless=new', '--disable-gpu', '--hide-scrollbars',
            '--window-size=%d,%d' % (args.width, args.height),
            '--virtual-time-budget=4500',
            '--screenshot=' + out,
            'http://127.0.0.1:%d/_preview.html' % PORT,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
        print('已生成 %s' % out if os.path.isfile(out) else '截图失败')
    finally:
        srv.terminate()
    return 0


if __name__ == '__main__':
    sys.exit(main())
