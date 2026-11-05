# -*- coding: utf-8 -*-
"""通过 GitHub REST API 把本地 git 仓库的 HEAD 推到远端。

用途：这台机器上 `git push` 走 https://github.com 经常被网络挡住
（CONNECT tunnel failed / 502），但 api.github.com 是通的。
这个脚本绕开 git 传输层，直接调 API 建 blob → tree → commit → 更新 ref。

用法：
    python tools/push_via_api.py main            # 推到 chenziangloves/todolist
    python tools/push_via_api.py main --dry-run  # 只看要推什么

前提：本地工作区必须干净、且 HEAD 已经 commit（脚本推的是 HEAD，不是工作区）。
"""
import base64
import io
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MCP = os.path.join(os.path.expanduser('~'), '.workbuddy', 'mcp.json')

REPOS = {
    # 逻辑名 -> (owner/repo, 分支)；'main' 表示仓库根就是当前目录
    'main': ('chenziangloves/todolist', 'main'),
}


def token():
    d = json.load(io.open(MCP, encoding='utf-8'))
    h = d['mcpServers']['github-write']['headers']
    return h['Authorization'].split(' ', 1)[1]


TOKEN = token()


def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request('https://api.github.com' + path, data=body, method=method)
    req.add_header('Authorization', 'Bearer ' + TOKEN)
    req.add_header('Accept', 'application/vnd.github+json')
    if body:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw or b'{}')
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:400]
        raise RuntimeError('HTTP %s %s %s\n%s' % (e.code, method, path, detail))


def git(repo, *args, binary=False):
    out = subprocess.run(['git', '-C', repo] + list(args), capture_output=True)
    if out.returncode != 0:
        raise RuntimeError('git %s 失败：%s' % (' '.join(args),
                                              out.stderr.decode('utf-8', 'replace')[:300]))
    return out.stdout if binary else out.stdout.decode('utf-8').strip()


def local_tree(repo):
    """返回 [(mode, type, sha, path)]，以及 blob 列表需要的内容。"""
    raw = subprocess.run(['git', '-C', repo, 'ls-tree', '-r', '-z', 'HEAD'],
                         capture_output=True, check=True).stdout
    entries = []
    for item in raw.split(b'\x00'):
        if not item:
            continue
        meta, path = item.split(b'\t', 1)
        mode, typ, sha = meta.decode().split(' ')
        entries.append((mode, typ, sha, path.decode('utf-8')))
    return entries


def build_tree(repo, entries):
    """按目录层级自底向上建 tree，返回顶层 tree sha。"""
    blob_cache = {}

    def blob_sha(sha):
        if sha in blob_cache:
            return blob_cache[sha]
        data = subprocess.run(['git', '-C', repo, 'cat-file', 'blob', sha],
                              capture_output=True, check=True).stdout
        res = api('POST', '/repos/%s/git/blobs' % SLUG, {
            'content': base64.b64encode(data).decode('ascii'),
            'encoding': 'base64',
        })
        blob_cache[sha] = res['sha']
        return res['sha']

    # 组装成嵌套 dict：{name: (mode, sha)} 或 {name: {子目录}}
    root = {}
    for mode, typ, sha, path in entries:
        parts = path.split('/')
        node = root
        for p in parts[:-1]:
            node = node.setdefault(p, {})
        node[parts[-1]] = (mode, sha)

    def make(node):
        items = []
        for name, val in node.items():
            if isinstance(val, dict):
                items.append({'path': name, 'mode': '040000', 'type': 'tree',
                              'sha': make(val)})
            else:
                mode, sha = val
                items.append({'path': name, 'mode': mode, 'type': 'blob',
                              'sha': blob_sha(sha)})
        res = api('POST', '/repos/%s/git/trees' % SLUG, {'tree': items})
        return res['sha']

    return make(root), len(blob_cache)


def main():
    global SLUG
    if len(sys.argv) < 2 or sys.argv[1] not in REPOS:
        print('用法：python tools/push_via_api.py {%s}' % '|'.join(REPOS))
        raise SystemExit(2)
    dry = '--dry-run' in sys.argv[1:]

    key = sys.argv[1]
    SLUG, branch = REPOS[key]
    repo = ROOT if key == 'main' else os.path.join(ROOT, key)

    dirty = git(repo, 'status', '--porcelain')
    if dirty:
        print('本地有未提交的改动，先 commit：\n' + dirty)
        raise SystemExit(1)

    head = git(repo, 'rev-parse', 'HEAD')
    msg = git(repo, 'log', '-1', '--pretty=%B')
    entries = local_tree(repo)
    print('本地 HEAD %s，%d 个文件' % (head[:7], len(entries)))

    # 空仓库没有 ref，GET 会返回 409，这时第一次推送要新建分支
    try:
        ref = api('GET', '/repos/%s/git/ref/heads/%s' % (SLUG, branch))
        remote_sha = ref['object']['sha']
        print('远端 %s = %s' % (branch, remote_sha[:7]))
    except RuntimeError as e:
        if '409' not in str(e):
            raise
        remote_sha = None
        print('远端 %s 为空仓库，将创建分支' % branch)

    if remote_sha == head:
        print('已经一致，不需要推送')
        return

    if dry:
        for mode, typ, sha, path in entries:
            print('   ', mode, path)
        return

    tree_sha, nblobs = build_tree(repo, entries)
    print('tree %s（上传了 %d 个 blob）' % (tree_sha[:7], nblobs))

    commit = api('POST', '/repos/%s/git/commits' % SLUG, {
        'message': msg,
        'tree': tree_sha,
        'parents': [remote_sha] if remote_sha else [],
    })
    print('commit %s' % commit['sha'][:7])

    if remote_sha:
        api('PATCH', '/repos/%s/git/refs/heads/%s' % (SLUG, branch), {
            'sha': commit['sha'],
            'force': True,
        })
        print('已更新 %s -> %s' % (branch, commit['sha'][:7]))
    else:
        api('POST', '/repos/%s/git/refs' % SLUG, {
            'ref': 'refs/heads/%s' % branch,
            'sha': commit['sha'],
        })
        print('已创建 %s -> %s' % (branch, commit['sha'][:7]))
    print('注意：本地与远端 commit sha 不会相同（API 重建的 commit），')
    print('      下次能直连时要 git fetch + git reset --hard origin/%s 对齐。' % branch)


if __name__ == '__main__':
    main()
