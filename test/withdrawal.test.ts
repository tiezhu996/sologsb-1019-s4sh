import assert from 'node:assert';
import {
  applyTombstoneToState,
  applyReferenceRedactions,
  collectNeedles,
  countMatches,
  findRedactionRanges,
  normalizeText,
  reconcileWithdrawals,
  redactText,
  scanReferences,
  scrubAuditTrail
} from '../src/utils/withdrawal';
import type { CodingState, Segment, WithdrawalRecord } from '../src/types';

const makeSegment = (id: string, transcriptId: string, text: string, order: number, A: string[] = [], B: string[] = []): Segment => ({
  id, transcriptId, order, speaker: '受访者', time: `00:0${order}`, text,
  assignments: { A, B }, note: ''
});

const baseState = (): CodingState => ({
  revision: 1,
  updatedAt: '2026-10-05T08:00:00.000Z',
  activeTranscriptId: 'tr-1',
  activeSegmentId: 's-1',
  activeThemeId: 't-a',
  coderA: '林研究员',
  coderB: '赵研究员',
  transcripts: [
    { id: 'tr-1', title: '王梅访谈', participant: '王梅', importedAt: '2026-09-01T00:00:00.000Z', sourceName: 'WM-01.txt' },
    { id: 'tr-2', title: '李岚访谈', participant: '李岚', importedAt: '2026-09-02T00:00:00.000Z', sourceName: 'LL-02.txt' }
  ],
  segments: [
    makeSegment('s-1', 'tr-1', '我是在临河镇长大的，小时候经常去河边。', 0, ['t-a'], ['t-a', 't-b']),
    makeSegment('s-2', 'tr-1', '班主任周老师没有只盯着成绩，常拿旧地图给我们讲河流和城市。', 1, ['t-a'], ['t-a']),
    makeSegment('s-3', 'tr-2', '另一位受访者的内容必须保留。', 0)
  ],
  themes: [
    { id: 't-a', name: '教师影响', parentId: null, color: '#000', definition: '如受访者回忆“他没有只盯着成绩，常拿旧地图给我们讲河流和城市”。', memo: '', examples: [] },
    { id: 't-b', name: '成长地', parentId: null, color: '#111', definition: '成长地相关陈述', memo: '受访者说“我是在临河镇长大的”，注意区分。', examples: ['完全无关的示例'] },
    { id: 't-c', name: '家庭', parentId: null, color: '#222', definition: '', memo: '', examples: ['不是替我做决定，而是在我犹豫的时候把可能性讲清楚'] }
  ],
  audit: [
    { id: 'au-1', at: '2026-10-01T00:00:00.000Z', action: '添加主题示例', detail: '我是在临河镇长大的' },
    { id: 'au-2', at: '2026-10-02T00:00:00.000Z', action: '调整编码', detail: '给 t-a 加主题' }
  ],
  withdrawals: [],
  exportLogs: [
    { id: 'e-1', at: '2026-10-03T00:00:00.000Z', format: 'json', transcriptIds: ['tr-1', 'tr-2'] },
    { id: 'e-2', at: '2026-10-04T00:00:00.000Z', format: 'csv', transcriptIds: ['tr-2'] }
  ]
});

const recordFor = (transcriptId: string, state: CodingState): WithdrawalRecord => {
  const transcript = state.transcripts.find((t) => t.id === transcriptId)!;
  const segments = state.segments.filter((s) => s.transcriptId === transcriptId);
  const needles = collectNeedles(segments);
  const references = scanReferences(state.themes, needles);
  return {
    id: `w-${transcriptId}`,
    transcriptId,
    transcriptTitle: transcript.title,
    participantLabel: transcript.participant,
    sourceName: transcript.sourceName,
    importedAt: transcript.importedAt,
    requestedAt: '2026-10-05T09:00:00.000Z',
    completedAt: '2026-10-05T09:00:00.000Z',
    segmentCount: segments.length,
    codingCount: segments.reduce((n, s) => n + s.assignments.A.length + s.assignments.B.length, 0),
    assignmentThemeIds: ['t-a'],
    references,
    purgedExports: [],
    scrubbedAuditCount: 0,
    note: ''
  };
};

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

console.log('匹配与抹除原语');
test('归一化忽略空白与引号', () => {
  assert.equal(normalizeText('“你好 世界”'), '你好世界');
});
test('跨标点引用可定位原文区间', () => {
  const text = '班主任周老师没有只盯着成绩，常拿旧地图给我们讲河流和城市。';
  const needles = ['没有只盯着成绩常拿旧地图给我们讲河流和城市'];
  const ranges = findRedactionRanges(text, needles);
  assert.equal(ranges.length, 1);
  assert.ok(ranges[0].start >= 0 && ranges[0].end <= text.length);
  const redacted = redactText(text, ranges);
  assert.ok(redacted.includes('［已撤回原话］'));
  assert.ok(!redacted.includes('旧地图'));
  assert.ok(redacted.includes('班主任周老师'));
});
test('过短短语不构成引用', () => {
  const segments = [makeSegment('x', 't', '河边', 0)];
  assert.deepEqual(collectNeedles(segments), []);
});

console.log('\n撤回执行');
test('撤回删除访谈、片段、A/B 判断并保留墓碑', () => {
  const state = baseState();
  const record = recordFor('tr-1', state);
  const changed = applyTombstoneToState(state, record);
  assert.equal(changed, true);
  assert.equal(state.transcripts.find((t) => t.id === 'tr-1'), undefined);
  assert.equal(state.segments.some((s) => s.transcriptId === 'tr-1'), false);
  assert.ok(state.segments.some((s) => s.transcriptId === 'tr-2'));
  assert.equal(state.withdrawals.length, 1);
  assert.equal(state.withdrawals[0].transcriptId, 'tr-1');
  assert.equal(JSON.stringify(state.withdrawals[0]).includes('临河镇'), false);
});
test('引用原话的主题定义与备忘录被抹除，无关主题不动', () => {
  const state = baseState();
  const record = recordFor('tr-1', state);
  applyTombstoneToState(state, record);
  const teacher = state.themes.find((t) => t.id === 't-a')!;
  const growth = state.themes.find((t) => t.id === 't-b')!;
  assert.ok(!teacher.definition.includes('旧地图'));
  assert.ok(teacher.definition.includes('［已撤回原话］'));
  assert.ok(!growth.memo.includes('临河镇'));
  assert.ok(growth.memo.includes('［已撤回原话］'));
  const family = state.themes.find((t) => t.id === 't-c')!;
  assert.equal(family.examples[0], '不是替我做决定，而是在我犹豫的时候把可能性讲清楚');
});
test('导出记录中含该访谈的条目被清除', () => {
  const state = baseState();
  applyTombstoneToState(state, recordFor('tr-1', state));
  assert.equal(state.exportLogs.some((log) => log.transcriptIds.includes('tr-1')), false);
  assert.ok(state.exportLogs.some((log) => log.id === 'e-2'));
});
test('审计记录中残留原话被清洗', () => {
  const state = baseState();
  const needles = collectNeedles(state.segments.filter((s) => s.transcriptId === 'tr-1'));
  const count = scrubAuditTrail(state, needles);
  assert.equal(count, 1);
  assert.ok(!state.audit.some((a) => a.detail.includes('临河镇')));
});
test('活动指针在撤回后切离被删内容', () => {
  const state = baseState();
  applyTombstoneToState(state, recordFor('tr-1', state));
  assert.notEqual(state.activeTranscriptId, 'tr-1');
  assert.ok(!state.segments.some((s) => s.id === state.activeSegmentId && s.transcriptId === 'tr-1'));
});

console.log('\n多标签页旧状态复活防护');
test('晚到的旧状态包含已撤回原文时，墓碑可确定性抹除', () => {
  // tab2 持有的旧状态：tr-1 与原文全都还在
  const stale = baseState();
  // tab1 已完成撤回，墓碑只来自当时的记录
  const record = recordFor('tr-1', baseState());
  const changed = applyTombstoneToState(stale, record);
  assert.equal(changed, true);
  assert.equal(stale.segments.some((s) => s.transcriptId === 'tr-1'), false);
  assert.equal(stale.transcripts.some((t) => t.id === 'tr-1'), false);
  assert.ok(!JSON.stringify(stale.themes).includes('临河镇'));
  assert.ok(!JSON.stringify(stale.themes).includes('旧地图'));
  assert.ok(!JSON.stringify(stale.audit).includes('临河镇'));
  assert.ok(stale.segments.some((s) => s.transcriptId === 'tr-2'));
});
test('重复应用墓碑幂等，不产生重复撤回记录', () => {
  const state = baseState();
  const record = recordFor('tr-1', state);
  applyTombstoneToState(state, record);
  const changedAgain = applyTombstoneToState(state, record);
  assert.equal(changedAgain, false);
  assert.equal(state.withdrawals.length, 1);
});
test('多个标签页各自撤回不同访谈，reconcile 合并墓碑', () => {
  const state = baseState();
  const r1 = recordFor('tr-1', baseState());
  const r2State = baseState();
  r2State.segments = r2State.segments.filter((s) => s.transcriptId === 'tr-2');
  const r2 = recordFor('tr-2', r2State);
  const applied = reconcileWithdrawals(state, [r1, r2]);
  assert.ok(applied >= 2);
  assert.equal(state.segments.length, 0);
  assert.equal(state.transcripts.length, 0);
  assert.equal(state.withdrawals.length, 2);
  assert.equal(state.exportLogs.length, 0);
});
test('旧状态中新增的引用（撤回后又被旧标签页写回）同样被抹除', () => {
  const stale = baseState();
  stale.themes[2].definition = '他说“我是在临河镇长大的”，这是关键证据';
  const record = recordFor('tr-1', baseState());
  applyTombstoneToState(stale, record);
  assert.ok(!JSON.stringify(stale.themes).includes('临河镇'));
});

console.log('\n引用扫描与手动处理');
test('扫描列出主题定义、备忘录、示例的位置并计数', () => {
  const state = baseState();
  const needles = collectNeedles(state.segments.filter((s) => s.transcriptId === 'tr-1'));
  const found = scanReferences(state.themes, needles);
  const fields = found.map((f) => `${f.themeId}:${f.field}`).sort();
  assert.ok(fields.includes('t-a:definition'));
  assert.ok(fields.includes('t-b:memo'));
  assert.ok(!fields.some((f) => f.startsWith('t-c')));
});
test('标记为 manual 的位置系统不改写，redacted 的位置被抹除', () => {
  const state = baseState();
  const needles = collectNeedles(state.segments.filter((s) => s.transcriptId === 'tr-1'));
  const found = scanReferences(state.themes, needles).map((location): import('../src/types').WithdrawnReferenceLocation =>
    location.themeId === 't-a' ? { ...location, action: 'manual' } : location
  );
  applyReferenceRedactions(state, found, needles);
  assert.ok(state.themes.find((t) => t.id === 't-a')!.definition.includes('旧地图'));
  assert.ok(!state.themes.find((t) => t.id === 't-b')!.memo.includes('临河镇'));
});
test('重复引用分别计数', () => {
  assert.equal(countMatches('他说临河镇长大，她也说临河镇长大', ['临河镇长大']), 2);
});

console.log(`\n全部 ${passed} 项测试通过`);
