/**
 * systemd 安装件的形态守卫（2026-11-21 owner：不要做到机器上，但安装/卸载必须可重复）。
 *
 * 本测试**只跑 print/--help/非法参数**，绝不执行 install/uninstall（那两个会动机器级状态）。
 * 它守三件事：
 *   ① print 输出的单元含关键字段（WorkingDirectory / ExecStart / Restart=always / 日志 / WantedBy）；
 *   ② 单元是**用户级**且显式给 PATH（systemd 极简 PATH 下 npm 找不到是常见事故）；
 *   ③ 用法自描述（--help 可读、非法参数 exit 2）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'ops', 'fshine-systemd.sh');

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, TMPDIR: '/tmp' } });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('fshine-systemd.sh：可重复安装件的形态', () => {
  it('print：输出单元正文且关键字段齐全（不写任何文件）', () => {
    const { status, stdout } = run(['print']);
    expect(status).toBe(0);
    expect(stdout).toContain(`WorkingDirectory=${REPO_ROOT}`);
    expect(stdout).toContain("ExecStart=/usr/bin/bash -lc 'exec npm start'");
    expect(stdout).toContain('Restart=always');
    expect(stdout).toContain('RestartSec=3');
    expect(stdout).toContain('Environment=PATH=');
    expect(stdout).toContain(`StandardOutput=append:${REPO_ROOT}/.runtime/server/service.log`);
    expect(stdout).toContain('WantedBy=default.target');
    // 用户级单元：不得出现 system 级路径或 root 要求。
    expect(stdout).not.toContain('/etc/systemd');
    expect(stdout).not.toContain('User=root');
  });

  it('print --name/--dir/--log：三个选项都进单元（可参数化安装）', () => {
    const { status, stdout } = run(['print', '--name', 'x-svc', '--dir', '/tmp/x-dir', '--log', '/tmp/x.log']);
    expect(status).toBe(0);
    expect(stdout).toContain('WorkingDirectory=/tmp/x-dir');
    expect(stdout).toContain('StandardOutput=append:/tmp/x.log');
  });

  it('--help：用法可读，且说明了 install/uninstall 与 linger 前提', () => {
    const { status, stdout } = run(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('install');
    expect(stdout).toContain('uninstall');
    expect(stdout).toContain('enable-linger');
  });

  it('非法参数：exit 2（不静默忽略）', () => {
    const { status, stderr } = run(['--bogus']);
    expect(status).toBe(2);
    expect(stderr).toContain('未知参数');
  });
});
