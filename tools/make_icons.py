# -*- coding: utf-8 -*-
"""生成 TodoList 的全套图标。

用法：
    python tools/make_icons.py

产出：
  - android/app/src/main/res/mipmap-*/ic_launcher(.round).png
  - android/.../drawable/ic_launcher_foreground.xml（自适应图标前景）
  - android/.../drawable/ic_launcher_background.xml（蓝底渐变）
  - android/.../drawable/ic_notify.xml（通知栏小图标）
  - icons/*.png（网页版 / PWA 用）

设计：蓝底 + 白色对勾。选它是因为在 48dp 的通知栏和桌面图标上都能一眼认出来，
比"清单+线条"那种细节多的方案更耐缩小。
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
WEB_ICONS = os.path.join(ROOT, 'icons')

BLUE_TOP = (111, 178, 255)
BLUE_BOTTOM = (58, 123, 224)
WHITE = (255, 255, 255)

# 512 设计稿里的对勾折点
CHECK = [(150, 268), (225, 345), (370, 175)]
STROKE = 46


def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def circle_mask(size):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([0, 0, size - 1, size - 1], fill=255)
    return m


def gradient(size):
    """从 BLUE_TOP 到 BLUE_BOTTOM 的竖直渐变"""
    img = Image.new('RGB', (1, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(round(BLUE_TOP[i] + (BLUE_BOTTOM[i] - BLUE_TOP[i]) * t) for i in range(3))
        d.point((0, y), c)
    return img.resize((size, size), Image.NEAREST)


def draw_check(draw, pts, width, color=WHITE):
    draw.line(pts, fill=color, width=width, joint='curve')
    r = width / 2.0
    for p in (pts[0], pts[-1]):
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)


def base_icon(size):
    """方形底图（512 设计稿），返回 RGBA"""
    img = gradient(size).convert('RGBA')
    img.putalpha(rounded_mask(size, int(size * 0.22)))
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    k = size / 512.0
    pts = [(x * k, y * k) for x, y in CHECK]
    draw_check(d, pts, max(2, round(STROKE * k)))
    return Image.alpha_composite(img, layer)


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG')
    print('  ' + os.path.relpath(path, ROOT))


def main():
    print('生成桌面图标：')
    # mipmap 各密度。minSdk 26 走自适应 xml，但低密度兜底和 roundIcon 仍要 png
    for folder, px in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96),
                       ('xxhdpi', 144), ('xxxhdpi', 192)]:
        square = base_icon(px)
        save(square, os.path.join(RES, 'mipmap-' + folder, 'ic_launcher.png'))

        circle = base_icon(px)
        circle.putalpha(circle_mask(px))
        save(circle, os.path.join(RES, 'mipmap-' + folder, 'ic_launcher_round.png'))

    print('生成网页图标：')
    save(base_icon(512), os.path.join(WEB_ICONS, 'icon-512.png'))
    save(base_icon(192), os.path.join(WEB_ICONS, 'icon-192.png'))
    save(base_icon(180), os.path.join(WEB_ICONS, 'apple-touch-icon.png'))
    save(base_icon(32), os.path.join(WEB_ICONS, 'favicon-32.png'))

    # maskable：四周留出安全边距，被系统裁成圆形时不切掉对勾
    big = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
    inner = base_icon(360)
    big.paste(inner, ((512 - 360) // 2, (512 - 360) // 2), inner)
    bg = Image.new('RGBA', (512, 512), BLUE_BOTTOM + (255,))
    bg.putalpha(rounded_mask(512, 0))
    save(Image.alpha_composite(bg, big), os.path.join(WEB_ICONS, 'icon-512-maskable.png'))

    print('生成矢量图标：')
    # 自适应图标前景：108 viewport，对勾缩到安全区（约 34~74）内
    k = 108.0 / 512.0
    pts = [(x * k, y * k) for x, y in CHECK]
    # 往中间收一点，避免被圆形遮罩切到
    cx, cy, shrink = 54.0, 54.0, 0.92
    pts = [(cx + (x - cx) * shrink, cy + (y - cy) * shrink) for x, y in pts]
    path = ('M%.1f,%.1f L%.1f,%.1f L%.1f,%.1f' %
            (pts[0][0], pts[0][1], pts[1][0], pts[1][1], pts[2][0], pts[2][1]))
    fg = '''<?xml version="1.0" encoding="utf-8"?>
<!-- 自适应图标前景：白色对勾（按 512 设计稿等比缩放到 108 viewport） -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:pathData="%s"
        android:strokeColor="#FFFFFF"
        android:strokeWidth="%.1f"
        android:strokeLineCap="round"
        android:strokeLineJoin="round" />
</vector>
''' % (path, STROKE * k * shrink)
    p = os.path.join(RES, 'drawable', 'ic_launcher_foreground.xml')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf-8', newline='\n').write(fg)
    print('  ' + os.path.relpath(p, ROOT))

    bg = '''<?xml version="1.0" encoding="utf-8"?>
<!-- 自适应图标背景：蓝色对角渐变，和网页主色一致 -->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <gradient
        android:angle="315"
        android:startColor="#6FB2FF"
        android:centerColor="#4D9BFF"
        android:endColor="#3A7BE0"
        android:type="linear" />
</shape>
'''
    p = os.path.join(RES, 'drawable', 'ic_launcher_background.xml')
    open(p, 'w', encoding='utf-8', newline='\n').write(bg)
    print('  ' + os.path.relpath(p, ROOT))

    # 通知栏小图标：必须是纯白剪影，系统会按状态栏配色着色
    notify = '''<?xml version="1.0" encoding="utf-8"?>
<!-- 通知栏小图标：纯白剪影，系统会自动着色 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:pathData="M9.2,17.4 L4.6,12.8 L6.4,11 L9.2,13.8 L17.6,5.4 L19.4,7.2 Z"
        android:fillColor="#FFFFFF" />
</vector>
'''
    p = os.path.join(RES, 'drawable', 'ic_notify.xml')
    open(p, 'w', encoding='utf-8', newline='\n').write(notify)
    print('  ' + os.path.relpath(p, ROOT))

    # 网页 favicon 的 svg 也顺手写一份
    svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#6FB2FF"/><stop offset="1" stop-color="#3A7BE0"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <path d="M150,268 L225,345 L370,175" fill="none" stroke="#fff"
        stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
'''
    open(os.path.join(WEB_ICONS, 'icon.svg'), 'w', encoding='utf-8', newline='\n').write(svg)
    print('  icons/icon.svg')
    print('完成')


if __name__ == '__main__':
    main()
