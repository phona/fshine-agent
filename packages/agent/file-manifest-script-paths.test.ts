/**
 * CAP-01 修复轮 ⑤ · 清单渲染给出脚本内路径（接口事实）。
 *
 * 背景（验收真模型红·新发现）：in/ 里的物化名是 `<fileId><原扩展名>`（file-store
 * materializeInputs 的 materializedName），但清单没说——模型先写 `in/file_a8259b…`
 * （无扩展名）失败一次才改对，6 次调用浪费 2 次。修法：清单每条给出「脚本内路径」
 * （in/<fileId><安全扩展名>，与物化同一公式、只由 fileId + 安全扩展名机械派生），
 * run_js 描述写明这条约定。
 *
 * 硬边界（负例钉住）：路径**不由原始文件名拼出**——构造 `../etc/passwd.xlsx` 的输入，
 * 断言清单里不出现 `..`（分隔符与 `..` 序列在渲染侧机械净化；file_refs 原值不动）。
 */
import { describe, expect, it } from 'vitest';
import { renderFileManifest, renderWorkerFileManifest } from './src/execution-runtime';

describe('⑤ 清单渲染：每条给出脚本内路径 in/<fileId><安全扩展名>', () => {
  it('Main 会话清单：脚本内路径与物化公式一致（in/<fileId><ext>）', () => {
    const manifest = renderFileManifest([{ fileId: 'file_a8259b01', name: '明细.xlsx', bytes: 20480 }]);
    expect(manifest).toContain('脚本内路径：in/file_a8259b01.xlsx');
    // 整行形状钉住：name/fileId/bytes 原样，路径段只由 fileId + 安全扩展名拼出。
    expect(manifest).toContain(
      '- 明细.xlsx（fileId: file_a8259b01，20480 字节；脚本内路径：in/file_a8259b01.xlsx）',
    );
  });

  it('Worker 任务清单：同样给出脚本内路径（Worker 的 run_js 同一面）', () => {
    const manifest = renderWorkerFileManifest([{ fileId: 'file_copy04ab', name: '清单.csv', bytes: 3 }]);
    expect(manifest).toContain('脚本内路径：in/file_copy04ab.csv');
    expect(manifest).toContain('- 清单.csv（fileId: file_copy04ab，3 字节；脚本内路径：in/file_copy04ab.csv）');
  });

  it('无安全扩展名的 name：路径是 in/<fileId>（无扩展名段，与物化行为一致）', () => {
    const manifest = renderFileManifest([{ fileId: 'file_noext01', name: '说明文件（无扩展名）', bytes: 7 }]);
    expect(manifest).toContain('脚本内路径：in/file_noext01）');
    expect(manifest).not.toContain('in/file_noext01.');
  });

  it('负例：原始名 ../etc/passwd.xlsx → 清单不出现 ..，路径只由 fileId + 安全扩展名派生', () => {
    const manifest = renderFileManifest([{ fileId: 'file_evil0a1b', name: '../etc/passwd.xlsx', bytes: 5 }]);
    // 清单里任何位置都不出现 `..`（路径/显示名都不携带穿越序列）。
    expect(manifest).not.toContain('..');
    // 脚本内路径仍是纯 fileId 派生：in/file_evil0a1b.xlsx（extname 取安全尾段 .xlsx）。
    expect(manifest).toContain('脚本内路径：in/file_evil0a1b.xlsx');
    // 由原始名拼出的路径（../etc/passwd…）不存在。
    expect(manifest).not.toContain('etc/passwd');
    expect(manifest).not.toContain('/etc');
  });

  it('负例：反斜杠分隔的穿越名同样不进清单（..\\ 与 \\ 一并净化）', () => {
    const manifest = renderFileManifest([{ fileId: 'file_bs000a1b', name: '..\\win\\evil.xlsx', bytes: 5 }]);
    expect(manifest).not.toContain('..');
    expect(manifest).not.toContain('\\');
    expect(manifest).toContain('脚本内路径：in/file_bs000a1b.xlsx');
  });

  it('正常中文原名照常显示（净化只碰分隔符与 .. 序列，不碰识别面）', () => {
    const manifest = renderFileManifest([{ fileId: 'file_cn00a1b2', name: '三季度汇总（终版）.xlsx', bytes: 9 }]);
    expect(manifest).toContain('- 三季度汇总（终版）.xlsx（fileId: file_cn00a1b2，9 字节；脚本内路径：in/file_cn00a1b2.xlsx）');
  });
});
