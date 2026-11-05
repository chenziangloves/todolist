# -*- coding: utf-8 -*-
"""把 CI 产出的未签名 APK 用正式密钥签名、发布成正式版，并清理未签名预览。

版本号直接从 APK 里读（aapt），不在脚本里另写一份，避免和 workflow 对不上。

用法：
    python tools/publish_release.py          # 取最新一次 unsigned-* 构建
    python tools/publish_release.py 4        # 指定构建序号

为什么签名在本地：当前 PAT 没有 Actions Secrets 权限，CI 拿不到签名密钥。
把 PAT 补上 Secrets: Read and write 之后，就能改成 CI 直接出签名包。
"""
import io
import json
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = 'chenziangloves/todolist'
MCP = os.path.join(os.path.expanduser('~'), '.workbuddy', 'mcp.json')
KS = os.path.join(ROOT, 'secrets', 'todolist-release.jks')
KS_PROPS = os.path.join(ROOT, 'android', 'keystore.properties')
APKSIGNER = os.path.join(ROOT, '.cache', 'apksigner.jar')
AAPT = os.path.join(ROOT, '.cache', 'aapt.exe')
ASSET_NAME = 'todolist-latest.apk'
KEY_ALIAS = 'todolist'

JAVA = 'java'
for cand in [r'C:\Program Files\Microsoft\jdk-17.0.18.8-hotspot\bin\java.exe']:
    if os.path.exists(cand):
        JAVA = cand
        break


def apk_version(apk_path):
    """从 APK 里读出真实的 versionName / versionCode"""
    if not os.path.exists(AAPT):
        return None, None
    try:
        out = subprocess.run([AAPT, 'dump', 'badging', apk_path],
                             capture_output=True, text=True,
                             encoding='utf-8', errors='replace').stdout
    except Exception:
        return None, None
    vn = vc = None
    for line in out.splitlines():
        if line.startswith('package:'):
            m = re.search(r"versionCode='(\d+)'", line)
            if m:
                vc = int(m.group(1))
            m = re.search(r"versionName='([^']*)'", line)
            if m:
                vn = m.group(1)
            break
    return vn, vc


def token():
    d = json.load(io.open(MCP, encoding='utf-8'))
    return d['mcpServers']['github-write']['headers']['Authorization'].split(' ', 1)[1]


def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request('https://api.github.com' + path, data=body, method=method)
    req.add_header('Authorization', 'Bearer ' + token())
    req.add_header('Accept', 'application/vnd.github+json')
    if body:
        req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        return json.loads(raw or b'{}')


def download_asset(asset_id, dest):
    req = urllib.request.Request(
        'https://api.github.com/repos/%s/releases/assets/%d' % (REPO, asset_id))
    req.add_header('Authorization', 'Bearer ' + token())
    req.add_header('Accept', 'application/octet-stream')
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, 'wb') as f:
        f.write(r.read())
    return os.path.getsize(dest)


def upload_asset(upload_url, name, path):
    with open(path, 'rb') as f:
        data = f.read()
    url = upload_url.split('{')[0] + '?name=' + name
    req = urllib.request.Request(url, data=data, method='POST')
    req.add_header('Authorization', 'Bearer ' + token())
    req.add_header('Accept', 'application/vnd.github+json')
    req.add_header('Content-Type', 'application/vnd.android.package-archive')
    req.add_header('Content-Length', str(len(data)))
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def keystore_password():
    with io.open(KS_PROPS, encoding='utf-8') as f:
        for line in f:
            if line.startswith('storePassword='):
                return line.strip().split('=', 1)[1]
    raise RuntimeError('keystore.properties 里没有密码')


def find_unsigned(build_no=None):
    rels = api('GET', '/repos/%s/releases?per_page=30' % REPO)
    cands = [r for r in rels if str(r.get('tag_name', '')).startswith('unsigned-')]
    if not cands:
        raise RuntimeError('没有找到 unsigned-* 构建，先等 CI 跑完')
    if build_no is not None:
        for r in cands:
            if r['tag_name'] == 'unsigned-%s' % build_no:
                return r
        raise RuntimeError('没有找到构建 %s' % build_no)
    return cands[0]


def main():
    build_no = sys.argv[1] if len(sys.argv) > 1 else None
    rel = find_unsigned(build_no)
    n = rel['tag_name'].split('-', 1)[1]

    assets = rel.get('assets') or []
    if not assets:
        raise RuntimeError('这次构建没有产物')
    asset = assets[0]
    unsigned = os.path.join(ROOT, '.cache', 'unsigned-%s.apk' % n)
    print('下载未签名包… %.2f MB' % (download_asset(asset['id'], unsigned) / 1048576.0))

    vn, vc = apk_version(unsigned)
    if not vn:
        vn = '1.0.%s' % n
        vc = 1000 + int(n)
    print('构建：%s  版本：v%s (versionCode %s)' % (rel['tag_name'], vn, vc))

    pw = keystore_password()
    signed = os.path.join(ROOT, '.cache', 'todolist-%s-release.apk' % vn)
    cmd = [JAVA, '-jar', APKSIGNER, 'sign',
           '--ks', KS, '--ks-key-alias', KEY_ALIAS,
           '--ks-pass', 'pass:' + pw, '--key-pass', 'pass:' + pw,
           '--v1-signing-enabled', 'true',
           '--v2-signing-enabled', 'true',
           '--v3-signing-enabled', 'true',
           '--out', signed, unsigned]
    subprocess.run(cmd, check=True)
    print('签名完成：%s  %.2f MB' % (os.path.basename(signed),
                                 os.path.getsize(signed) / 1048576.0))

    verify = subprocess.run([JAVA, '-jar', APKSIGNER, 'verify', '--print-certs', '-v', signed],
                            capture_output=True, text=True, encoding='utf-8', errors='replace')
    ok = 'Verifies' in (verify.stdout or '')
    print('验签：%s' % ('通过' if ok else '失败'))
    for line in (verify.stdout or '').splitlines()[:8]:
        if 'Signer' in line or 'certificate DN' in line or 'SHA-256' in line:
            print('   ', line.strip())
    if not ok:
        raise SystemExit('签名校验没通过，停下来')

    body = (
        'TodoList 待办清单 v%s（versionCode %s）\n\n' % (vn, vc) +
        '**固定下载地址（存成书签，以后一直用这个）**\n'
        'https://github.com/chenziangloves/todolist/releases/latest/download/%s\n\n' % ASSET_NAME +
        '### 这一版有什么\n'
        '- 记任务：标题、备注、优先级、开始时间、截止时间，每个任务单独设提前几天提醒\n'
        '- 按截止时间自动排序；拖动某条就能把它钉在当前位置，其它任务照常按时间流动\n'
        '- 逾期、24 小时内、3 天内分级着色，最急的永远在最上面\n'
        '- 到点推系统通知，关掉 App 也能收到；手机重启后闹钟自动重建\n'
        '- 标记完成自动归入「已完成」，可撤销；删除也能撤销\n'
        '- 一键导出备份到手机「下载」目录\n\n'
        '### 安装\n'
        '直接点开安装即可**覆盖**旧版，任务数据原地保留。\n'
        '装完第一次打开，请在「右上角菜单 → 通知权限」里允许通知，否则收不到提醒。'
    )

    new = api('POST', '/repos/%s/releases' % REPO, {
        'tag_name': 'v' + vn,
        'name': 'TodoList v%s' % vn,
        'body': body,
        'draft': False,
        'prerelease': False,
        'target_commitish': 'main',
    })
    print('发布：%s  %s' % (new['tag_name'], new['html_url']))

    up = upload_asset(new['upload_url'], ASSET_NAME, signed)
    print('资产：%s  %.2f MB' % (up['name'], up['size'] / 1048576.0))

    # 清理未签名预览，避免它干扰 releases/latest
    for r in api('GET', '/repos/%s/releases?per_page=30' % REPO):
        tag = str(r.get('tag_name', ''))
        if tag.startswith('unsigned-') or tag.startswith('build-'):
            api('DELETE', '/repos/%s/releases/%d' % (REPO, r['id']))
            try:
                api('DELETE', '/repos/%s/git/refs/tags/%s' % (REPO, tag))
            except Exception:
                pass
            print('已清理：' + tag)

    print('\n固定下载地址：')
    print('https://github.com/chenziangloves/todolist/releases/latest/download/%s' % ASSET_NAME)


if __name__ == '__main__':
    main()
