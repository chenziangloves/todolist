# -*- coding: utf-8 -*-
"""把网页源码同步进安卓工程（android/app/src/main/assets/www）。

用法：
    python tools/sync_android.py

改了 index.html / css / js / icons 之后跑一次，再提交 android 仓库，
GitHub Actions 就会打出新的 APK。
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WWW = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www')

FILES = ['index.html', 'manifest.webmanifest']
DIRS = ['css', 'js', 'icons']

# 只同步这些后缀，避免把 .map / 备份文件带进去
EXTS = {'.html', '.css', '.js', '.webmanifest', '.json', '.svg', '.png', '.ico'}

# 这些文件只在开发时用，不进 App
SKIP_NAMES = {'sw.js'}


def sync():
    if not os.path.isdir(os.path.dirname(WWW)):
        print('找不到安卓资源目录：%s' % WWW)
        return 1

    os.makedirs(WWW, exist_ok=True)
    copied = []

    for name in FILES:
        src = os.path.join(ROOT, name)
        if not os.path.isfile(src):
            print('跳过（不存在）：%s' % name)
            continue
        shutil.copy2(src, os.path.join(WWW, name))
        copied.append(name)

    for folder in DIRS:
        src_dir = os.path.join(ROOT, folder)
        dst_dir = os.path.join(WWW, folder)
        if not os.path.isdir(src_dir):
            continue
        os.makedirs(dst_dir, exist_ok=True)
        for name in sorted(os.listdir(src_dir)):
            if name in SKIP_NAMES:
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in EXTS:
                continue
            shutil.copy2(os.path.join(src_dir, name), os.path.join(dst_dir, name))
            copied.append(folder + '/' + name)

    # 清掉源目录里已经删掉、但 www 里还留着的旧文件
    for folder in DIRS:
        dst_dir = os.path.join(WWW, folder)
        src_dir = os.path.join(ROOT, folder)
        if not os.path.isdir(dst_dir):
            continue
        for name in os.listdir(dst_dir):
            if os.path.isdir(os.path.join(dst_dir, name)):
                continue
            if not os.path.isfile(os.path.join(src_dir, name)):
                os.remove(os.path.join(dst_dir, name))
                print('  删除残留：%s/%s' % (folder, name))

    print('已同步 %d 个文件到 assets/www：' % len(copied))
    for c in copied:
        print('   ' + c)
    return 0


if __name__ == '__main__':
    sys.exit(sync())
