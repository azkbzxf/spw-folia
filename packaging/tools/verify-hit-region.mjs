#!/usr/bin/env node
// 鼠标穿透热区的回归测试（issue #24 / PR #25）。
//
// ## 为什么用「查窗口区域」而不是「模拟点击」
//
// `SetWindowRgn` 的窗口区域**就是**命中测试本身：区域外的点击由系统直接交给下层窗口，区域内的
// 才进捕获窗。所以「中心点不在区域内」与「点击会穿到下层」是同一件事，「齿轮点在区域内」与
// 「热区可点」也是同一件事 —— 但这个判据不需要挪用户的鼠标、不依赖窗口焦点、不受屏幕锁影响，
// 因此可以进发布门禁。
//
// ## 覆盖的回归点（每一条都对应一次真实故障）
//
//   R1 穿透开启时捕获窗有区域且**不是整窗** —— v0.5.0 的 fail-open 让它是 null（= 整窗），
//      于是每一次点击都被吃掉。这是 issue #24 的现象本身。
//   R2 画面中央**不在**区域内 —— 穿透必须真的生效。
//   R3 右上齿轮在区域内 —— 热区必须仍可点，否则用户没有出路。
//   R4 右下圆钮在区域内 —— 同上。
//   R5 区域是 COMPLEXREGION 而不是 SIMPLEREGION —— 证明它是多个热区的并集，
//      不是某个覆盖整块的矩形（PR #25 之前有过 460×460 的大兜底，那会遮住大片画面）。
//   R6 关掉穿透后区域回到整窗 —— 普通（非穿透）会话必须完全可点。
//   R7 捕获窗在 z-order 上位于主窗之上 —— PR #25 保留 `BringToFront()` 在 `Show()` 之前的
//      顺序，对隐藏窗口那是 no-op，捕获窗因此收不到输入。这条钉住 v0.5.1 的 `Owner` +
//      `SetWindowPos(HWND_TOPMOST)` 修复。
//
// 用法: node packaging/tools/verify-hit-region.mjs
// 退出码: 0 = PASS, 1 = FAIL, 2 = 缺少打包产物
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG = join(ROOT, 'packaging');
const OUT = join(PKG, 'out');
mkdirSync(OUT, { recursive: true });

const exe = join(PKG, 'native', 'spw-folia-host.exe');
const probe = join(PKG, 'tools', 'win-region-probe.ps1');
for (const p of [exe, join(PKG, 'web', 'index.html'), probe]) {
    if (!existsSync(p)) {
        console.error(`missing ${p}\n  run: bash packaging/build-package.sh`);
        process.exit(2);
    }
}

const results = [];
const assert = (label, ok, detail) => {
    results.push({ label, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${label}] ${detail === undefined ? '' : JSON.stringify(detail)}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动宿主，等它 ready，然后查捕获窗区域。 */
async function withHost(settings, fn) {
    const lines = [];
    const child = spawn(exe, [
        '--bundle', join(PKG, 'web'),
        '--fullscreen',
        '--keep-alive',
        '--dev-settings', JSON.stringify({ settings }),
        '--user-data-dir', join(OUT, `hit-region-${Date.now()}`),
        '--no-curtain',
    ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (c) => {
        buf += c.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const l = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (l) lines.push(l);
        }
    });
    child.stderr.on('data', () => {});
    try {
        // 页面 ready（`hitbox rects=` 出现）后再等一拍，让区域稳定。
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline && !lines.some((l) => /hitbox rects=|hitbox apply/.test(l))) await sleep(250);
        await sleep(2500);
        return await fn(child, lines);
    } finally {
        try { child.stdin.end(); } catch { /* gone */ }
        await sleep(600);
        try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
}

function probeRegion(pid) {
    const r = spawnSync('pwsh', ['-NoProfile', '-File', probe, '-ProcessId', String(pid)], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) throw new Error(`region probe failed: ${r.status} ${r.stderr || ''}`);
    const parsed = JSON.parse(r.stdout.trim());
    return parsed;
}

// 捕获窗在 z-order 上的位置：用 EnumWindows 的枚举顺序近似（先枚举到的更靠上）。
function zOrderOf(pid, catcherHwnd) {
    const ps = `
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ZOrder {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<long> ForPid(int pid) {
    List<long> list = new List<long>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)pid) list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
($([ZOrder]::ForPid(${pid})) -join ',')
`;
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
    const order = (r.stdout || '').trim().split(',').filter(Boolean).map(Number);
    const idx = order.indexOf(Number(catcherHwnd));
    return { order, index: idx };
}

async function main() {
    // ---------------------------------------------------------------- 穿透开启
    const on = await withHost({ transparentPlayerBackground: true, mousePassthrough: true }, async (child) => {
        const region = probeRegion(child.pid);
        const z = zOrderOf(child.pid, region.catcher && region.catcher.hwnd);
        return { region, z, pid: child.pid };
    });

    const c = on.region.catcher;
    assert('R1 a passthrough session has a catcher region at all', !!c && c.regionKind !== 0,
        c ? { regionKind: c.regionKind, box: c.regionBox } : { catcher: null });
    assert('R1b it is not the whole window (fail-closed, issue #24)',
        !!c && c.regionKind !== 0 && !(c.regionBox === `0,0,${c.width},${c.height}`),
        c ? { regionBox: c.regionBox, window: `${c.width}x${c.height}` } : null);
    assert('R2 the centre of the picture passes through to the window below',
        !!c && c.centreInside === 'no', c ? { centreInside: c.centreInside } : null);
    assert('R3 the top-right gear stays clickable', !!c && c.gearInside === 'yes', c ? { gearInside: c.gearInside } : null);
    assert('R4 the bottom-right round button stays clickable',
        !!c && c.playerButtonInside === 'yes', c ? { playerButtonInside: c.playerButtonInside } : null);
    assert('R5 the region is a union of hot zones (COMPLEXREGION), not one covering block',
        !!c && c.regionKind === 3, c ? { regionKind: c.regionKind } : null);
    // z-order：捕获窗必须比主窗先被枚举到（更靠上）。主窗 = 同进程里另一个可见的 1776x1110 窗口。
    const others = on.region.windows.filter((w) => w.visible && w.hwnd !== (c && c.hwnd) && w.width > 100);
    assert('R7 the catcher sits above the player window in z-order (PR #25 kept the no-op BringToFront)',
        on.z.index >= 0 && others.length > 0 && on.z.index < on.z.order.indexOf(others[0].hwnd),
        { catcherIndex: on.z.index, otherIndex: on.z.order.indexOf(others[0] && others[0].hwnd) });

    // ---------------------------------------------------------------- 穿透关闭
    const off = await withHost({ transparentPlayerBackground: true }, async (child) => {
        await sleep(1500);
        return probeRegion(child.pid);
    });
    const c2 = off.catcher;
    assert('R6 with passthrough off the catcher is the whole window again',
        !!c2 && c2.regionKind === 0, c2 ? { regionKind: c2.regionKind } : null);

    const pass = results.every((r) => r.ok);
    writeFileSync(join(OUT, 'hit-region-report.json'), JSON.stringify({
        at: new Date().toISOString(), results, pass,
        passthroughOn: on.region, passthroughOff: off,
    }, null, 2));
    console.log(`\n${pass ? 'PASS' : 'FAIL'}  ${results.filter((r) => r.ok).length}/${results.length} checks`);
    process.exit(pass ? 0 : 1);
}

await main();
