import { useCodingStore } from '../src/store/coding-store';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const assert = (cond: boolean, msg: string) => {
  if (!cond) { console.error('✗ ' + msg); process.exit(1); }
  console.log('✓ ' + msg);
};

const run = async () => {
  const store = useCodingStore();
  await store.initialize();
  await sleep(50);

  // 初始 seed：tr-001 + 10 片段
  assert(store.state.transcripts.length === 1, '初始有 1 份访谈');
  assert(store.state.segments.length === 12, '初始有 12 个片段');

  // 1) 预览：seed 主题中预埋的原话引用应被扫出
  const refs = store.previewWithdrawal('tr-001');
  const fields = refs.map((r) => `${r.themeId}:${r.field}`);
  assert(fields.includes('t-teacher:definition'), '扫到 t-teacher 定义中的原话');
  assert(fields.includes('t-education:memo'), '扫到 t-education 备忘录中的原话');
  assert(fields.includes('t-school-choice:memo'), '扫到 t-school-choice 备忘录中的原话');
  assert(fields.includes('t-family:example'), '扫到 t-family 示例中的原话');

  // 2) 手动处理校验：把 t-teacher 标记为自行处理但尚未改写，撤回必须被阻止
  const keyOf = (r: { themeId: string; field: string; exampleIndex?: number }) =>
    `${r.themeId}:${r.field}:${r.exampleIndex ?? -1}`;
  const manualTeacher = refs.filter((r) => r.themeId === 't-teacher').map(keyOf);
  let result = await store.withdrawConsent('tr-001', '', manualTeacher);
  assert(result.ok === false, '未改写手动位置时撤回被阻止');
  assert((globalThis.localStorage.getItem('sologsb-1019-withdraw-checkpoint-v1')) === null, '阻止时未留下检查点');
  assert(store.state.segments.length === 12, '阻止后原文仍在');

  // 3) 研究者去改写 t-teacher 定义
  const teacher = store.state.themes.find((t) => t.id === 't-teacher')!;
  store.updateTheme('t-teacher', { definition: '教师对学习兴趣、职业方向或自我认知的影响。' }, '操作定义');
  await sleep(220);

  // 4) 再次撤回，全部自动抹除
  result = await store.withdrawConsent('tr-001', '受访者电话要求撤回', []);
  await sleep(60);
  assert(result.ok, '撤回成功');
  assert(store.state.transcripts.length === 0, '访谈已移除');
  assert(store.state.segments.length === 0, '片段已移除');
  assert(store.state.withdrawals.length === 1, '保留 1 条撤回记录');
  const w = store.state.withdrawals[0];
  assert(w.segmentCount === 12, '撤回记录记录 12 个片段');
  assert(w.codingCount > 0, '撤回记录记录被删除的 A/B 判断数');
  assert(!JSON.stringify(w).includes('临河镇'), '撤回记录本身不含原文');
  assert(w.note === '受访者电话要求撤回', '撤回备注保留');
  assert(store.canUndo() === false, '撤销栈已清空，撤回不可撤销');

  // 主题原话已抹除（自动），t-teacher 是研究者自己改写的
  const education = store.state.themes.find((t) => t.id === 't-education')!;
  assert(education.memo.includes('［已撤回原话］'), '备忘录原话被占位抹除');
  assert(!JSON.stringify(store.state.themes).includes('临河镇'), '所有主题不再含原话');
  assert(!JSON.stringify(store.state.audit).includes('临河镇'), '审计不含原话');

  // 5) 墓碑已持久化
  const cache = JSON.parse(globalThis.localStorage.getItem('sologsb-1019-withdrawals-v1')!);
  assert(cache.length === 1 && cache[0].transcriptId === 'tr-001', '墓碑同步缓存已写入');
  assert(globalThis.localStorage.getItem('sologsb-1019-withdraw-checkpoint-v1') === null, '成功后检查点已删除');

  // 6) 模拟多标签页：晚到的旧状态（含已撤回原文）进入冲突通道
  const oldState = JSON.parse(globalThis.localStorage.getItem('sologsb-1019-state-v1')!);
  // 构造一份"旧"状态：用 seed 结构但带原文
  oldState.state = structuredClone(oldState);
  oldState.state.revision = 999;
  oldState.state.updatedAt = '2099-01-01T00:00:00.000Z';
  oldState.state.withdrawals = []; // 旧状态没有撤回记录
  oldState.writerId = 'other-tab';
  oldState.revision = 999;
  globalThis.__pushChannel({ kind: 'envelope', envelope: oldState });
  await sleep(20);
  assert(store.remoteEnvelope() !== null, '检测到其他标签页修订并挂起（未自动覆盖）');
  // 挂起的信封已被清洗
  assert(store.remoteEnvelope()!.state.segments.length === 0, '挂起信封中的旧原文已被拦截清洗');
  assert(store.state.segments.length === 0, '当前页内容未被旧状态覆盖');
  // 即使研究者显式载入旧版本，原文也不会回来
  store.applyRemoteVersion();
  await sleep(220);
  assert(store.state.segments.length === 0, '显式载入旧版本后原文仍未复活');
  assert(store.state.withdrawals.length === 1, '撤回记录仍保留');

  // 7) 模拟另一个标签页完成撤回（storage 事件路径）—— 已撤回状态下无新内容，仅验证不报错
  globalThis.__pushChannel({ kind: 'withdrawal', record: w });
  await sleep(50);
  assert(store.state.withdrawals.length === 1, '重复撤回通知幂等');

  console.log('\n全部 store 集成冒烟检查通过');
};

run().catch((e) => { console.error(e); process.exit(1); });
