#!/usr/bin/env node
// 无额外测试框架：用 esbuild 打包 TS 测试，配合浏览器环境 shim 在 Node 中运行。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'sologsb-test-'));
const esbuild = join(root, 'node_modules', '.bin', 'esbuild');

const suites = [
  { entry: join(root, 'test', 'withdrawal.test.ts'), shim: false, name: '撤回纯逻辑（匹配 / 抹除 / 墓碑 / 幂等）' },
  { entry: join(root, 'test', 'store.smoke.ts'), shim: true, name: 'Store 集成（撤回流程 / 多标签页旧状态防护）' },
  { entry: join(root, 'test', 'recovery.smoke.ts'), shim: true, name: '写入失败 / 检查点恢复' }
];

let failed = 0;
for (const suite of suites) {
  const base = suite.entry.split('/').pop();
  const bundle = join(work, `${base}.mjs`);
  execFileSync(esbuild, [suite.entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`], { stdio: 'inherit' });
  const runner = join(work, `run-${base}.mjs`);
  if (suite.shim) {
    writeFileSync(runner, `import ${JSON.stringify(join(root, 'test', 'browser-shim.mjs'))};\nimport ${JSON.stringify(bundle)};\n`);
  } else {
    writeFileSync(runner, `import ${JSON.stringify(bundle)};\n`);
  }
  process.stdout.write(`\n=== ${suite.name} ===\n`);
  try {
    execFileSync(process.execPath, [runner], { stdio: 'inherit', env: process.env });
  } catch {
    failed += 1;
  }
}
if (failed) {
  console.error(`\n${failed} 个测试套件失败`);
  process.exit(1);
}
console.log('\n全部测试套件通过');
