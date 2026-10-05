// 撤回同意核心不变量测试（Node 环境，stub 浏览器 API）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};
globalThis.crypto.randomUUID; // Node 20 已提供 randomUUID

import esbuild from '/workspace/node_modules/esbuild/lib/main.js';
import { writeFileSync } from 'fs';

const result = await esbuild.build({
  entryPoints: ['/workspace/src/utils/withdrawal.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  loader: { '.ts': 'ts' }
});
writeFileSync('/tmp/wd-test.mjs', result.outputFiles[0].text);
const wd = await import('file:///tmp/wd-test.mjs');

let passed = 0, failed = 0;
const assert = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
};

const baseState = () => ({
  revision: 5, updatedAt: '2026-10-05T10:00:00.000Z', activeTranscriptId: 'tr-1', activeSegmentId: 's-1', activeThemeId: 't-1',
  coderA: '林', coderB: '赵',
  transcripts: [
    { id: 'tr-1', title: '李岚访谈', participant: '李岚', importedAt: '', sourceName: '录音01' },
    { id: 'tr-2', title: '王梅访谈', participant: '王梅', importedAt: '', sourceName: '录音02' }
  ],
  segments: [
    { id: 's-1', transcriptId: 'tr-1', order: 0, speaker: '李岚', time: '00:01', text: '小学时老师让我第一次接触地图', assignments: { A: ['t-1'], B: ['t-1', 't-2'] }, note: '重点片段' },
    { id: 's-2', transcriptId: 'tr-1', order: 1, speaker: '李岚', time: '00:02', text: '她认识镇上学校的王老师，说那边图书室有很多书', assignments: { A: [], B: [] }, note: '' },
    { id: 's-3', transcriptId: 'tr-2', order: 0, speaker: '王梅', time: '00:01', text: '我们那时候都在厂办学校读书', assignments: { A: ['t-2'], B: ['t-2'] }, note: '' }
  ],
  themes: [
    { id: 't-1', name: '教育经历', parentId: null, color: '#000', definition: '受访者提到小学时老师让我第一次接触地图的经历', memo: '注意小学时老师让我第一次接触地图这条材料很关键', examples: ['小学时老师让我第一次接触地图', '他总能把课文讲成故事'] },
    { id: 't-2', name: '学校选择', parentId: 't-1', color: '#000', definition: '关于择校的陈述', memo: '', examples: [] }
  ],
  withdrawals: [],
  audit: [
    { id: 'a1', at: '2026-10-05T09:00:00.000Z', action: '编辑片段', detail: '把原文改为 小学时老师让我第一次接触地图' },
    { id: 'a2', at: '2026-10-05T08:00:00.000Z', action: '新建主题', detail: '学校选择' }
  ]
});

console.log('1) 撤回瞬间彻底清除');
store.clear();
let s = baseState();
const entry = wd.buildWithdrawalEntry(s, 'tr-1', '受访者邮件要求撤回', 'tab-1');
assert(entry && !('text' in entry), '墓碑不含原文字段');
assert(entry.segmentCount === 2 && entry.codeCount === 3, '墓碑记录片段/判断数量 (2/3)');
const applied = wd.applyWithdrawal(s, entry);
const out = applied.state;
assert(!out.transcripts.some((t) => t.id === 'tr-1'), '访谈条目被删除');
assert(!out.segments.some((seg) => seg.transcriptId === 'tr-1'), '该访谈全部片段被删除');
assert(out.segments.length === 1 && out.segments[0].id === 's-3', '其他访谈片段保留');
assert(out.withdrawals.length === 1 && out.withdrawals[0].title === '李岚访谈', '留下不含原文的撤回记录');
const theme1 = out.themes.find((t) => t.id === 't-1');
assert(!theme1.definition.includes('地图') && theme1.definition.includes(wd.REDACTION_MARK), '主题定义中的原话被清除');
assert(!theme1.memo.includes('地图'), '备忘录中的原话被清除');
assert(!theme1.examples.some((e) => e.includes('地图')), '示例中的原话被清除');
assert(theme1.examples.includes('他总能把课文讲成故事'), '不相关示例保留');
assert(!out.audit.some((a) => a.detail.includes('地图')), '审计中内联原话的旧条目被剔除');
assert(out.audit[0].action === '受访者撤回同意' && !out.audit[0].detail.includes('地图'), '追加不含原文的撤回审计');
assert(out.activeTranscriptId === 'tr-2', '活动访谈切换到剩余访谈');

console.log('2) 引用位置扫描（撤回前清单）');
s = baseState();
const refs = wd.findReferences(s, 'tr-1');
const locations = refs.map((r) => `${r.themeId}:${r.field}`).sort();
assert(locations.includes('t-1:definition'), '检出主题定义引用');
assert(locations.includes('t-1:memo'), '检出备忘录引用');
assert(locations.includes('t-1:example'), '检出示例引用');
assert(!refs.some((r) => r.themeId === 't-2'), '未引用原话的主题不出现在清单');

console.log('3) 账本与 sanitizeState：旧状态复活防护');
store.clear();
wd.addToLedger(entry);
assert(wd.isWithdrawn('tr-1'), '账本持久化撤回墓碑');
const stale = baseState(); // 模拟多标签页晚到的旧状态：完整带着已撤回内容
const sanitized = wd.sanitizeState(stale);
assert(!sanitized.state.transcripts.some((t) => t.id === 'tr-1'), '旧状态里的已撤回访谈被剥除');
assert(!sanitized.state.segments.some((seg) => seg.transcriptId === 'tr-1'), '旧状态里的片段/A-B判断被剥除');
assert(sanitized.scrubbedThemes.includes('教育经历'), '旧状态主题文本里的原话被清理');
assert(sanitized.state.withdrawals.length === 1, '净化后仍保留撤回墓碑');
assert(sanitized.state.segments.length === 1, '其他访谈数据不受影响');

console.log('4) 净化幂等：已净化状态再过账本不变化、不丢新工作');
const twice = wd.sanitizeState(sanitized.state);
assert(JSON.stringify(twice.state) === JSON.stringify(sanitized.state), '二次净化幂等');

console.log('5) 检查点');
store.clear();
s = baseState();
const cp = wd.writeCheckpoint(s, 'tr-1');
assert(!!wd.readCheckpoint(), '检查点可读取');
assert(cp.state.segments.length === 3, '检查点保留撤回前完整状态');
wd.clearCheckpoint();
assert(wd.readCheckpoint() === null, '清除后检查点不存在（彻底清除后无法恢复原文）');

console.log('6) 账本是权威：状态镜像里缺墓碑时以账本补齐');
store.clear();
wd.addToLedger(entry);
const stateWithoutMirror = wd.sanitizeState({ ...baseState(), withdrawals: [] });
assert(stateWithoutMirror.state.withdrawals.length === 1, '账本墓碑补入状态镜像');

console.log('7) 回滚（撤回写入失败后恢复）会从本页账本移除墓碑');
wd.removeFromLedger('tr-1');
assert(!wd.isWithdrawn('tr-1'), '恢复后本页账本不再含该墓碑');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
