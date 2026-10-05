import { For, Show, createMemo, createSignal } from 'solid-js';
import type { WithdrawalRecord, WithdrawnReferenceLocation } from '../types';
import type { CodingStore } from '../store/coding-store';

const locationKey = (location: WithdrawnReferenceLocation) =>
  `${location.themeId}:${location.field}:${location.exampleIndex ?? -1}`;

const ACTION_LABEL = { redacted: '系统已抹除原话', manual: '研究者自行改写' } as const;

export default function WithdrawDialog(props: { open: boolean; store: CodingStore; transcriptId: string; onClose: () => void }) {
  const [manualKeys, setManualKeys] = createSignal<string[]>([]);
  const [note, setNote] = createSignal('');
  const [confirmed, setConfirmed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [done, setDone] = createSignal<WithdrawalRecord | null>(null);
  const [scanVersion, setScanVersion] = createSignal(0);

  const transcript = createMemo(() => props.store.state.transcripts.find((item) => item.id === props.transcriptId));
  const segments = createMemo(() => props.store.state.segments.filter((segment) => segment.transcriptId === props.transcriptId));
  const codingCount = createMemo(() => segments().reduce((count, segment) => count + segment.assignments.A.length + segment.assignments.B.length, 0));
  const exportCount = createMemo(() => props.store.state.exportLogs.filter((log) => log.transcriptIds.includes(props.transcriptId)).length);

  const scanned = createMemo<WithdrawnReferenceLocation[]>(() => {
    scanVersion();
    return props.transcriptId ? props.store.previewWithdrawal(props.transcriptId) : [];
  });

  const reset = () => {
    setManualKeys([]);
    setNote('');
    setConfirmed(false);
    setBusy(false);
    setError('');
    setDone(null);
    setScanVersion((version) => version + 1);
  };

  const close = () => {
    reset();
    props.onClose();
  };

  const toggleMode = (location: WithdrawnReferenceLocation) => {
    const key = locationKey(location);
    setManualKeys((keys) => keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key]);
    setError('');
  };

  const jumpToTheme = (themeId: string) => {
    props.store.selectTheme(themeId);
    close();
  };

  const submit = async () => {
    if (!confirmed() || busy()) return;
    setBusy(true);
    setError('');
    const result = await props.store.withdrawConsent(props.transcriptId, note(), manualKeys());
    setBusy(false);
    if (result.ok) {
      setDone(result.record);
      return;
    }
    setError(result.message);
    setScanVersion((version) => version + 1);
  };

  return (
    <div class="modal-backdrop" classList={{ hidden: !props.open }} onClick={close}>
      <section class="modal-card wide" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <Show when={!done()} fallback={<DoneView record={done()!} onClose={close} />}>
          <header>
            <div><span class="eyebrow">CONSENT WITHDRAWAL</span><h2>撤回访谈同意</h2></div>
            <button class="modal-close" onClick={close}>×</button>
          </header>

          <Show when={transcript()} fallback={<div class="empty-state">该访谈已不存在。</div>}>
            {(item) => <>
              <p class="modal-intro">
                受访者 <strong>{item().participant}</strong> 行使撤回同意后，本访谈的<strong>全部原文片段、A/B 编码判断、主题引用与工作台内导出物</strong>将被彻底移除，
                撤销栈同时清空（不可撤销恢复）；系统只保留一份不含原文的撤回处理记录。
              </p>

              <div class="withdraw-summary">
                <div><strong>{segments().length}</strong><span>将删除片段</span></div>
                <div><strong>{codingCount()}</strong><span>A/B 判断</span></div>
                <div><strong>{exportCount()}</strong><span>工作台内导出</span></div>
              </div>

              <div class="withdraw-section-title">主题定义、备忘录与示例中的原话引用</div>
              <Show when={scanned().length} fallback={
                <div class="muted">未在主题定义、备忘录或示例中检出该访谈的原话片段。如果之前手动粘贴过引文，请自行确认。</div>
              }>
                <p class="modal-intro">下列位置引用了该访谈原话。默认由系统抹除原话并保留占位；取消勾选即表示你已在主题记事中自行改写，校验通过后才会完成撤回。</p>
                <ul class="withdraw-ref-list">
                  <For each={scanned()}>{(location) => {
                    const isManual = () => manualKeys().includes(locationKey(location));
                    return (
                      <li class="withdraw-ref-item">
                        <label class="withdraw-ref-check">
                          <input type="checkbox" checked={!isManual()} onChange={() => toggleMode(location)} />
                          <span classList={{ 'manual-mode': isManual() }}>{isManual() ? '自行改写（不再自动抹除）' : '自动抹除原话'}</span>
                        </label>
                        <div class="withdraw-ref-body">
                          <strong>{location.themeName}</strong>
                          <span>{location.fieldLabel}{location.field === 'example' && typeof location.exampleIndex === 'number' ? ` #${location.exampleIndex + 1}` : ''} · 命中 {location.matchedCount} 处</span>
                        </div>
                        <button class="link-button" onClick={() => jumpToTheme(location.themeId)}>前往处理 →</button>
                      </li>
                    );
                  }}</For>
                </ul>
              </Show>

              <div class="warning-box withdraw-warning">
                已通过浏览器下载到本机或分享给他人的 JSON/CSV 文件无法被远程删除，撤回记录会列出这些导出的时间与格式，请研究者自行销毁外部副本。
              </div>

              <label class="field-label">撤回处理备注（可选）
                <textarea class="native-textarea" value={note()} onInput={(event) => setNote(event.currentTarget.value)} placeholder="记录撤回请求的来源、时间或交接说明" />
              </label>

              <label class="withdraw-confirm">
                <input type="checkbox" checked={confirmed()} onChange={(event) => setConfirmed(event.currentTarget.checked)} />
                <span>我理解原文与判断将被彻底清除、无法通过撤销恢复，工作台仅保留撤回记录。</span>
              </label>

              <Show when={error()}><div class="disagreement withdraw-error" role="alert">{error()}</div></Show>

              <footer>
                <button class="button secondary" onClick={close}>取消</button>
                <button class="button danger" disabled={!confirmed() || busy()} onClick={submit}>
                  {busy() ? '正在写入…' : '确认彻底撤回'}
                </button>
              </footer>
            </>}
          </Show>
        </Show>
      </section>
    </div>
  );
}

function DoneView(props: { record: WithdrawalRecord; onClose: () => void }) {
  const record = props.record;
  return (
    <div class="withdraw-done">
      <header>
        <div><span class="eyebrow">WITHDRAWAL COMPLETE</span><h2>撤回已完成</h2></div>
      </header>
      <div class="withdraw-done-mark">✓ 原文已彻底清除，以下为仅存的处理记录</div>
      <dl class="withdraw-ledger">
        <div><dt>访谈</dt><dd>{record.transcriptTitle}</dd></div>
        <div><dt>受访者标识</dt><dd>{record.participantLabel}</dd></div>
        <div><dt>来源</dt><dd>{record.sourceName}</dd></div>
        <div><dt>处理时间</dt><dd>{new Date(record.completedAt).toLocaleString('zh-CN')}</dd></div>
        <div><dt>删除片段 / 判断</dt><dd>{record.segmentCount} 段 · {record.codingCount} 条 A/B 判断</dd></div>
        <div><dt>审计原话清洗</dt><dd>{record.scrubbedAuditCount} 条操作记录</dd></div>
      </dl>
      <Show when={record.references.length}>
        <div class="withdraw-section-title">已处理的原话引用位置（{record.references.length}）</div>
        <ul class="withdraw-ref-list compact">
          <For each={record.references}>{(location) => (
            <li class="withdraw-ref-item readonly">
              <span class="withdraw-badge" classList={{ manual: location.action === 'manual' }}>{ACTION_LABEL[location.action]}</span>
              <div class="withdraw-ref-body"><strong>{location.themeName}</strong><span>{location.fieldLabel} · {location.matchedCount} 处</span></div>
            </li>
          )}</For>
        </ul>
      </Show>
      <Show when={record.purgedExports.length}>
        <div class="withdraw-section-title">已删除的工作台内导出（{record.purgedExports.length}）</div>
        <ul class="withdraw-export-list">
          <For each={record.purgedExports}>{(log) => (
            <li>{log.format.toUpperCase()} · {new Date(log.at).toLocaleString('zh-CN')}</li>
          )}</For>
        </ul>
      </Show>
      <div class="warning-box withdraw-warning">请确认已销毁此前下载或外发的导出副本，它们不受本地清除控制。</div>
      <Show when={record.note}><p class="modal-intro">备注：{record.note}</p></Show>
      <footer><button class="button primary" onClick={props.onClose}>完成</button></footer>
    </div>
  );
}
