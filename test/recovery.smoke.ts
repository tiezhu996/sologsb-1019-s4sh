import { useCodingStore } from '../src/store/coding-store';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('✗ ' + msg); process.exit(1); } console.log('✓ ' + msg); };

(async () => {
  const store = useCodingStore();
  await store.initialize();
  await sleep(60);
  const before = store.state.segments.length;

  // 故障注入：让 IndexedDB 事务失败
  (globalThis as any).__idbFail = true;

  const result = await store.withdrawConsent('tr-001', '', []);
  assert(result.ok === false, '写入失败时撤回返回失败');
  assert(store.withdrawError() !== null, '界面显示撤回失败横幅');
  assert(store.pendingCheckpoint() !== null, '本地检查点已保留');
  assert(globalThis.localStorage.getItem('sologsb-1019-withdraw-checkpoint-v1') !== null, 'localStorage 中存在检查点');
  assert(store.state.segments.length === 0, '界面已按撤回后状态展示（乐观更新）');

  // 恢复：从检查点回到撤回前
  await store.restoreFromCheckpoint();
  await sleep(220);
  assert(store.state.segments.length === before, '恢复后原文片段回来了');
  assert(store.state.transcripts.length === 1, '恢复后访谈回来了');
  assert(store.state.withdrawals.length === 0, '恢复后没有撤回记录');
  assert(store.pendingCheckpoint() === null, '检查点已清除');
  assert(store.recoveredNotice() !== null, '提示已从检查点恢复');
  assert(globalThis.localStorage.getItem('sologsb-1019-withdraw-checkpoint-v1') === null, '检查点 key 已删除');

  // 恢复后的持久化会尝试 IDB（仍失败），但 localStorage 是好的，墓碑缓存无撤回记录
  const persisted = JSON.parse(globalThis.localStorage.getItem('sologsb-1019-state-v1')!);
  assert(persisted.segments.length === before, 'localStorage 已写回恢复状态');

  console.log('\n写入失败与检查点恢复流程全部通过');
})();
