import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { AppBar, Button, Chip, Paper, Toolbar, Typography } from '@suid/material';
import TranscriptPanel from './components/TranscriptPanel';
import ThemeTree from './components/ThemeTree';
import Inspector from './components/Inspector';
import ImportDialog from './components/ImportDialog';
import WithdrawDialog from './components/WithdrawDialog';
import { CreateThemeDialog, MergeThemeDialog, SplitThemeDialog } from './components/ThemeDialogs';
import { useCodingStore } from './store/coding-store';

export default function App() {
  const store = useCodingStore();
  const [importOpen, setImportOpen] = createSignal(false);
  const [createOpen, setCreateOpen] = createSignal(false);
  const [createParent, setCreateParent] = createSignal<string | undefined>();
  const [mergeOpen, setMergeOpen] = createSignal(false);
  const [splitOpen, setSplitOpen] = createSignal(false);
  const [shortcutsOpen, setShortcutsOpen] = createSignal(false);
  const [withdrawId, setWithdrawId] = createSignal('');

  const activeSegments = createMemo(() => store.state.segments
    .filter((segment) => segment.transcriptId === store.state.activeTranscriptId)
    .sort((a, b) => a.order - b.order));

  const moveSegment = (delta: number) => {
    const segments = activeSegments();
    const index = segments.findIndex((segment) => segment.id === store.state.activeSegmentId);
    const next = segments[Math.max(0, Math.min(segments.length - 1, index + delta))];
    if (next) {
      store.selectSegment(next.id);
      document.querySelector('.segment-card.active')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleKeys = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? store.redo() : store.undo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      store.redo();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      store.downloadExport('json');
      return;
    }
    if (editing) return;
    if (event.key.toLowerCase() === 'j') { event.preventDefault(); moveSegment(1); }
    if (event.key.toLowerCase() === 'k') { event.preventDefault(); moveSegment(-1); }
    if (event.key === '/') {
      event.preventDefault();
      document.querySelector<HTMLInputElement>('.transcript-panel .native-input')?.focus();
    }
    if (event.key === '?') setShortcutsOpen((open) => !open);
    if (/^[1-9]$/.test(event.key)) {
      const theme = store.orderedThemes()[Number(event.key) - 1];
      if (theme) store.selectTheme(theme.id);
    }
    if (event.altKey && event.key.toLowerCase() === 'a' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'A', store.state.activeThemeId, true);
    }
    if (event.altKey && event.key.toLowerCase() === 'b' && store.state.activeThemeId) {
      event.preventDefault();
      store.toggleAssignment(store.state.activeSegmentId, 'B', store.state.activeThemeId, true);
    }
  };

  onMount(() => {
    void store.initialize();
    window.addEventListener('keydown', handleKeys);
  });
  onCleanup(() => window.removeEventListener('keydown', handleKeys));

  return (
    <div class="app-shell">
      <AppBar position="static" class="topbar">
        <Toolbar class="toolbar">
          <div class="brand">
            <div class="brand-mark">码</div>
            <div><Typography variant="h6" component="div">访谈主题编码台</Typography><span>INTERPRETIVE CODING WORKBENCH</span></div>
          </div>
          <div class="top-actions">
            <div class="save-state"><span classList={{ pulsing: !store.storageReady() }} />{store.remoteEnvelope() ? '检测到其他标签页修订' : store.storageReady() ? `已保存 · r${store.state.revision}` : '正在载入本地库'}</div>
            <Button color="inherit" size="small" disabled={!store.canUndo()} onClick={store.undo}>撤销</Button>
            <Button color="inherit" size="small" disabled={!store.canRedo()} onClick={store.redo}>重做</Button>
            <Button variant="outlined" color="inherit" size="small" onClick={() => setImportOpen(true)}>导入转写</Button>
            <Button variant="contained" color="secondary" size="small" onClick={() => store.downloadExport('json')}>导出编码</Button>
          </div>
        </Toolbar>
      </AppBar>

      <Show when={store.remoteEnvelope()}>
        {(remote) => (
          <div class="conflict-banner" role="alert">
            <div><strong>另一个标签页写入了较新的版本</strong><span>本地数据库修订 r{remote().revision}。载入前已按撤回账本净化，系统不会自动覆盖任何数据，请明确选择保留哪一份。</span></div>
            <div><Button size="small" color="inherit" onClick={store.applyRemoteVersion}>载入其他标签页版本</Button><Button size="small" variant="contained" color="warning" onClick={store.keepLocalVersion}>保留本页并建立新修订</Button></div>
          </div>
        )}
      </Show>

      {/* 撤回写入失败：可重试彻底清除，或从本地检查点恢复撤回前状态 */}
      <Show when={store.withdrawError()}>
        {(failure) => (
          <div class="withdraw-banner error" role="alert">
            <div>
              <strong>《{failure().title}》撤回清除的写入未完成</strong>
              <span>{failure().message} 撤回墓碑已生效，已撤回的原话不会因任何旧状态回到工作台。</span>
            </div>
            <div class="banner-actions">
              <Button size="small" color="inherit" onClick={() => void store.restoreFromCheckpoint()}>从本地检查点恢复</Button>
              <Button size="small" variant="contained" color="warning" onClick={() => void store.retryWithdrawal('')}>重试彻底清除</Button>
              <button class="banner-dismiss" onClick={store.dismissWithdrawError} title="稍后处理">×</button>
            </div>
          </div>
        )}
      </Show>

      {/* 其他标签页完成撤回：本页已自动净化清除 */}
      <Show when={store.externalWithdrawal()}>
        {(notice) => (
          <div class="withdraw-banner external" role="status">
            <div>
              <strong>另一标签页已执行撤回：《{notice().title}》</strong>
              <span>本页已同步清除 {notice().segmentCount} 个片段原文、A/B 判断与引用，并清空撤销/重做历史，撤回内容无法从本页恢复。</span>
            </div>
            <div class="banner-actions"><Button size="small" variant="contained" onClick={store.dismissExternalNotice}>知道了</Button></div>
          </div>
        )}
      </Show>

      {/* 晚到的旧标签页状态被拦截 */}
      <Show when={store.staleBlockedCount()}>
        <div class="withdraw-banner stale" role="alert">
          <div>
            <strong>已拦截 {store.staleBlockedCount()} 次来自旧标签页的过期写入</strong>
            <span>该状态早于撤回同意的修订，载入它会把已撤回内容带回工作台，系统已直接忽略并保持撤回结果。请在仍打开的旧标签页中刷新页面。</span>
          </div>
          <div class="banner-actions"><Button size="small" variant="contained" onClick={store.dismissStaleNotice}>知道了</Button></div>
        </div>
      </Show>

      {/* 彻底清除成功后的处理结果 */}
      <Show when={store.lastWithdrawal()}>
        {(result) => (
          <div class="withdraw-banner success" role="status">
            <div>
              <strong>撤回处理完成：《{result().title}》</strong>
              <span>已清除 {result().segmentCount} 个片段原文、{result().codeCount} 条 A/B 判断与全部相关引用；工作台仅保留不含原文的撤回记录，撤销/重做历史已清空。请自行销毁此前下载的导出文件。</span>
            </div>
            <div class="banner-actions"><Button size="small" variant="contained" onClick={store.dismissWithdrawalResult}>查看处理结果</Button></div>
          </div>
        )}
      </Show>

      <section class="project-strip">
        <div><span class="eyebrow">CODING PROJECT</span><h1>{store.state.transcripts.find((item) => item.id === store.state.activeTranscriptId)?.title ?? '访谈语料库'}</h1></div>
        <div class="project-metrics">
          <div><strong>{store.state.segments.length}</strong><span>转写片段</span></div>
          <div><strong>{store.state.themes.length}</strong><span>层级主题</span></div>
          <div><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>编码分歧</span></div>
          <div><strong>{store.state.withdrawals.length}</strong><span>撤回记录</span></div>
        </div>
      </section>

      <main class="workspace-grid">
        <TranscriptPanel store={store} onWithdraw={(transcriptId) => setWithdrawId(transcriptId)} />
        <ThemeTree store={store} onCreate={(parentId) => { setCreateParent(parentId); setCreateOpen(true); }} onMerge={() => setMergeOpen(true)} onSplit={() => setSplitOpen(true)} />
        <Inspector store={store} />
      </main>

      <section class="lower-grid">
        <Paper class="panel codebook-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">CODEBOOK HEALTH</span><h3>编码册质量检查</h3></div><Chip label="实时" size="small" /></div>
          <div class="health-grid">
            <div class="health-item"><strong>{store.state.segments.filter((segment) => !segment.assignments.A.length && !segment.assignments.B.length).length}</strong><span>未编码片段</span><small>可批量选择后重新编码</small></div>
            <div class="health-item"><strong>{store.state.themes.filter((theme) => !theme.definition).length}</strong><span>缺少定义的主题</span><small>定义会帮助后续编码保持一致</small></div>
            <div class="health-item"><strong>{store.state.segments.filter((segment) => segment.assignments.A.join('|') !== segment.assignments.B.join('|')).length}</strong><span>双编码分歧</span><small>使用双人比较逐条处理</small></div>
          </div>
        </Paper>
        <Paper class="panel export-panel" elevation={0}>
          <div class="panel-heading"><div><span class="eyebrow">EXPORT & BACKUP</span><h3>研究数据出口</h3></div></div>
          <p>导出包含完整主题路径、双编码者判断、备忘录、主题示例和审计记录；已撤回的访谈与原文不会进入导出文件。CSV 适合表格复核，JSON 可完整回档。撤回前下载的旧文件请按合规要求自行销毁。</p>
          <div class="button-row"><Button variant="contained" onClick={() => store.downloadExport('json')}>下载 JSON 完整包</Button><Button variant="outlined" onClick={() => store.downloadExport('csv')}>下载 CSV 编码表</Button></div>
        </Paper>
      </section>

      <footer class="app-footer">
        <span>快捷键 J / K 切换片段 · 1–9 选择主题 · Alt+A / Alt+B 编码 · Ctrl+Z 撤销 · ? 查看帮助</span>
        <span>IndexedDB 本地保存 · 撤回同意后原文不可恢复 · 多标签页显式冲突处理</span>
      </footer>

      <ImportDialog open={importOpen()} onClose={() => setImportOpen(false)} onImport={store.importTranscript} />
      <WithdrawDialog store={store} open={!!withdrawId()} transcriptId={withdrawId()} onClose={() => setWithdrawId('')} />
      <CreateThemeDialog store={store} open={createOpen()} parentId={createParent()} onClose={() => { setCreateOpen(false); setCreateParent(undefined); }} />
      <MergeThemeDialog store={store} open={mergeOpen()} onClose={() => setMergeOpen(false)} />
      <SplitThemeDialog store={store} open={splitOpen()} onClose={() => setSplitOpen(false)} />

      <div class="modal-backdrop" classList={{ hidden: !shortcutsOpen() }} onClick={() => setShortcutsOpen(false)}>
        <section class="modal-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
          <header><div><span class="eyebrow">KEYBOARD</span><h2>键盘操作</h2></div><button class="modal-close" onClick={() => setShortcutsOpen(false)}>×</button></header>
          <div class="shortcut-list">
            <For each={[['J / K', '下一条 / 上一条片段'], ['1–9', '选择主题树中的主题'], ['Alt+A / Alt+B', '将当前主题分配给编码者'], ['/', '聚焦正文搜索'], ['Ctrl+Z / Ctrl+Y', '撤销 / 重做'], ['Ctrl+E', '导出 JSON'], ['?', '显示或隐藏此面板']]}>{([key, text]) => <div><kbd>{key}</kbd><span>{text}</span></div>}</For>
          </div>
        </section>
      </div>
    </div>
  );
}
