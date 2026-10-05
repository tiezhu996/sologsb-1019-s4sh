import { For, Show, createMemo, createSignal } from 'solid-js';
import type { useCodingStore } from '../store/coding-store';

type Store = ReturnType<typeof useCodingStore>;

export default function WithdrawDialog(props: { store: Store; open: boolean; transcriptId: string; onClose: () => void }) {
  const [reason, setReason] = createSignal('');
  const [acknowledged, setAcknowledged] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');

  const transcript = createMemo(() => props.store.state.transcripts.find((item) => item.id === props.transcriptId));
  const references = createMemo(() => props.store.withdrawalReferences(props.transcriptId));
  const segmentCount = createMemo(() => props.store.state.segments.filter((segment) => segment.transcriptId === props.transcriptId).length);
  const codeCount = createMemo(() => props.store.state.segments
    .filter((segment) => segment.transcriptId === props.transcriptId)
    .reduce((count, segment) => count + segment.assignments.A.length + segment.assignments.B.length, 0));

  const reset = () => { setReason(''); setAcknowledged(false); setSubmitting(false); setError(''); };
  const close = () => { reset(); props.onClose(); };

  const submit = async () => {
    if (!acknowledged() || submitting()) return;
    setSubmitting(true);
    setError('');
    try {
      await props.store.performWithdrawal(props.transcriptId, reason());
      close();
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : '撤回写入失败，可从检查点恢复');
      setSubmitting(false);
    }
  };

  const fieldBadgeClass = (field: string) => `ref-badge ${field === 'definition' ? 'def' : field === 'memo' ? 'memo' : 'ex'}`;

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={submitting() ? undefined : close}>
      <section class="modal-card wide withdraw-card" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="withdraw-title">
        <header>
          <div><span class="eyebrow">CONSENT WITHDRAWAL</span><h2 id="withdraw-title">受访者撤回同意 · 清除访谈</h2></div>
          <button class="modal-close" disabled={submitting()} onClick={close}>×</button>
        </header>

        <Show when={transcript()} fallback={<div class="empty-state">该访谈已经被撤回或不存在，工作台只保留撤回记录。</div>}>
          {(current) => (
            <>
              <div class="withdraw-target">
                <div><strong>《{current().title}》</strong><span>受访者：{current().participant} · 来源：{current().sourceName}</span></div>
                <div class="withdraw-stats"><span>{segmentCount()} 个片段</span><span>{codeCount()} 条 A/B 判断</span></div>
              </div>

              <div class="warning-box withdraw-warning">
                撤回后将永久清除：访谈条目与全部片段原文、两位编码者的主题判断与片段备忘、主题中的相关引用，以及此前导出文件外的所有副本。
                撤回不可通过撤销/重做找回；本地数据库与 localStorage 中只留下<strong>不含原文</strong>的撤回记录。请同时自行销毁此前下载的 JSON / CSV 导出文件。
              </div>

              <div class="ref-section">
                <div class="ref-section-head">
                  <div><strong>引用原话的位置清单</strong><span>主题定义、研究备忘录、典型示例里引用过该访谈原话的位置，必须先处理，不能照旧保留。</span></div>
                  <Show when={references().length}>
                    <button class="button secondary tiny" disabled={submitting()} onClick={() => props.store.resolveAllReferences(props.transcriptId)}>一键清空全部 {references().length} 处</button>
                  </Show>
                </div>
                <Show when={references().length} fallback={
                  <div class="ref-empty">✓ 未在主题定义、备忘录和示例中检出该访谈的原话引用。较短或转述的引用系统无法自动识别，请研究者再人工确认一遍。</div>
                }>
                  <ul class="ref-list">
                    <For each={references()}>{(reference) => (
                      <li class="ref-item">
                        <div class="ref-head">
                          <span class={fieldBadgeClass(reference.field)}>{reference.fieldLabel}</span>
                          <strong>{reference.themeName}</strong>
                          <button class="link-button danger-link" disabled={submitting()} onClick={() => props.store.resolveReference(reference)}>清空此位置</button>
                        </div>
                        <p>{reference.excerpt}</p>
                      </li>
                    )}</For>
                  </ul>
                </Show>
              </div>

              <label class="field-label">撤回原因 / 备注（可空，将随撤回记录保留，请勿填写原话）
                <textarea class="native-textarea" value={reason()} onInput={(event) => setReason(event.currentTarget.value)} placeholder="例如：受访者于 2026-10-05 邮件要求撤回全部参与数据" />
              </label>

              <label class="ack-row">
                <input type="checkbox" checked={acknowledged()} onChange={(event) => setAcknowledged(event.currentTarget.checked)} />
                <span>我确认已处理上述引用位置，并知悉撤回后工作台只保留不含原文的撤回记录、此前导出文件需自行销毁。</span>
              </label>

              <Show when={error()}><div class="withdraw-error">⚠ {error()}。可关闭窗口后通过顶部提示“重试清除”或“从本地检查点恢复”。</div></Show>

              <footer>
                <button class="button secondary" disabled={submitting()} onClick={close}>取消</button>
                <button class="button danger" disabled={submitting() || !acknowledged() || !!references().length} onClick={submit}>
                  {submitting() ? '正在彻底清除…' : '确认撤回并彻底清除'}
                </button>
              </footer>
            </>
          )}
        </Show>
      </section>
    </div>
  );
}
