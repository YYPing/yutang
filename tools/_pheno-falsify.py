#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双向验证：把实现改回旧值，判据必须报红。
用法：python tools/_pheno-falsify.py
"""
import shutil, subprocess, sys, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TV = os.path.join(ROOT, 'src/engine/term-visual.js')
BAK = TV + '.bak'


def run(label):
    p = subprocess.run(['node', 'tools/check-lotus-pheno.mjs'], cwd=ROOT,
                       capture_output=True)
    # ★ 必须按 bytes 读再解码：Windows 控制台默认 GBK，`✘`/`✔` 会被吞成 '?'，
    #   于是「红项明细」整行筛不出来，只剩个计数 —— 复现时看不到是哪条判据。
    out = p.stdout.decode('utf-8', errors='replace')
    tail = out.strip().splitlines()[-1]
    reds = [l.strip() for l in out.splitlines() if '✘' in l]
    print('  [%s] %s' % (label, tail))
    for r in reds:
        print('        ' + r[:160])
    return len(reds)


CASES = [
    ('基线（未改）', None, None),
    ('反证A LOTUS_MAX 9→5（旧物理天花板）', r'const LOTUS_MAX = 9;', r'const LOTUS_MAX = 5;'),
    ('反证B OPEN_HI .88→.92（旧窗口）', r'const OPEN_HI = 0.88;', r'const OPEN_HI = 0.92;'),
    # 反证C 要模拟「第一版用 litter 判枯瓣」。必须**语法合法**才能跑到判据，
    #   所以把 litter 从档案侧接进来，而不是凭空引用未定义变量。
    ('反证C budKindOf 改用 litter>=0.30 判枯瓣（第一版的错法）', [
        (r'function budKindOf\(bud, pod\) \{', r'function budKindOf(bud, pod, litter) {'),
        (r'  if \(pod >= 0\.50\) return BUD_KIND\.WITHERED;',
         r'  if (litter >= 0.30) return BUD_KIND.WITHERED;'),
        (r'budKindOf\(clamp01\(p\.bud \?\? 0\), clamp01\(p\.pod \?\? 0\)\)',
         r'budKindOf(clamp01(p.bud ?? 0), clamp01(p.pod ?? 0), clamp01(p.litter ?? 0))'),
    ], None),
    ('反证D 大暑 lotus .88→.55（峰值塌腰到芒种量级）', None, None),
]

src0 = open(TV, 'r', encoding='utf-8', newline='').read()
shutil.copyfile(TV, BAK)
try:
    for label, pat, rep in CASES:
        if label.startswith('反证D'):
            # 改档案：大暑 lotus .88 -> .55（模拟「峰值塌腰」）
            AL = os.path.join(ROOT, 'src/engine/almanac.js')
            al0 = open(AL, 'r', encoding='utf-8', newline='').read()
            al_bak = AL + '.bak'
            shutil.copyfile(AL, al_bak)
            open(AL, 'w', encoding='utf-8', newline='').write(
                al0.replace('lotus: .88', 'lotus: .55', 1))
            try:
                run(label)
            finally:
                shutil.copyfile(al_bak, AL)
                os.remove(al_bak)
            continue
        if pat is None:
            run(label)
            continue
        if isinstance(pat, list):
            s = src0
            for a, b in pat:
                if not re.search(a, s):
                    print('  [%s] ⚠️ 模式未命中，判据未真正被反证：%s' % (label, a))
                    s = None
                    break
                s = re.sub(a, b, s)
            if s is None:
                continue
            open(TV, 'w', encoding='utf-8', newline='').write(s)
            chk = subprocess.run(['node', '--check', TV], capture_output=True, text=True)
            if chk.returncode != 0:
                print('  [%s] ⚠️ 反证版语法不合法，判据未真正被反证：%s' % (label, chk.stderr[:200]))
                shutil.copyfile(BAK, TV)
                continue
            try:
                run(label)
            finally:
                shutil.copyfile(BAK, TV)
            continue
        if not re.search(pat, src0):
            print('  [%s] ⚠️ 模式未命中，判据未真正被反证：%s' % (label, pat))
            continue
        open(TV, 'w', encoding='utf-8', newline='').write(re.sub(pat, rep, src0))
        try:
            run(label)
        finally:
            shutil.copyfile(BAK, TV)
finally:
    shutil.copyfile(BAK, TV)
    os.remove(BAK)

print('\n还原完成，重跑基线：')
run('还原后')