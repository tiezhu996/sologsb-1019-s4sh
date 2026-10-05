import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type { ChannelMessage, CoderId, CodingState, PersistedEnvelope, Segment, Theme, Withdrawal } from '../types';
import {
  addToLedger,
  applyWithdrawal,
  buildWithdrawalEntry,
  clearCheckpoint,
  findReferences,
  readCheckpoint,
  readLedger,
  removeFromLedger,
  sanitizeState,
  writeCheckpoint,
  type WithdrawalReference
} from '../utils/withdrawal';
import {
  clearCheckpointMirror,
  readCheckpointMirror,
  readEnvelope,
  writeCheckpointMirror,
  writeEnvelope
} from '../utils/db';

const STORAGE_KEY = 'sologsb-1019-state-v1';
const LEDGER_STORAGE_EVENT = 'sologsb-1019-withdrawal-ledger-v1';
const TAB_ID = crypto.randomUUID();

const normalizeState = (raw: CodingState): CodingState => ({ ...raw, withdrawals: raw.withdrawals ?? [] });

const loadLocal = (): CodingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = normalizeState(JSON.parse(raw) as CodingState);
      // 任何进入内存的状态都先和撤回账本对账，绝不把已撤回内容带进工作台。
      return sanitizeState(parsed).state;
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return seedState();
};

const cloneState = (state: CodingState): CodingState => structuredClone(unwrap(state));

const [state, setState] = createStore<CodingState>(loadLocal());
const [undoStack, setUndoStack] = createSignal<CodingState[]>([]);
const [redoStack, setRedoStack] = createSignal<CodingState[]>([]);
const [remoteEnvelope, setRemoteEnvelope] = createSignal<PersistedEnvelope | null>(null);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [staleBlockedCount, setStaleBlockedCount] = createSignal(0);
const [externalWithdrawal, setExternalWithdrawal] = createSignal<Withdrawal | null>(null);
const [withdrawError, setWithdrawError] = createSignal<{ transcriptId: string; title: string; message: string } | null>(null);
const [lastWithdrawal, setLastWithdrawal] = createSignal<Withdrawal | null>(null);
let channel: BroadcastChannel | null = null;
let saveTimer: number | undefined;
let applyingExternal: Withdrawal['transcriptId'] | null = null;

/** 净化后构造信封。撤回账本是咽喉：快照写入、广播的状态都必须经过它。 */
const buildEnvelope = (snapshot: CodingState): PersistedEnvelope => {
  const clean = sanitizeState(snapshot).state;
  return { revision: clean.revision, updatedAt: clean.updatedAt, writerId: TAB_ID, state: clean };
};

const postMessage = (message: ChannelMessage) => {
  try { channel?.postMessage(message); } catch { /* 频道关闭时忽略 */ }
};

const persist = (snapshot: CodingState) => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const envelope = buildEnvelope(snapshot);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope.state));
      await writeEnvelope(envelope);
      setLastSavedAt(new Date());
      postMessage({ kind: 'snapshot', ...envelope });
    } catch (error) {
      console.error('写入本地数据库失败', error);
    }
  }, 180);
};

/** 撤回路径使用的即时持久化：失败要能被研究者感知并从检查点恢复。 */
const persistNow = async (snapshot: CodingState): Promise<PersistedEnvelope> => {
  window.clearTimeout(saveTimer);
  const envelope = buildEnvelope(snapshot);
  // 先写 IndexedDB（抛错可被撤回流程捕获），成功后再覆盖 localStorage，
  // 避免“本地快照已删原文而 IndexedDB 仍残留旧原文”的泄露窗口。
  await writeEnvelope(envelope);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope.state));
  setLastSavedAt(new Date());
  postMessage({ kind: 'snapshot', ...envelope });
  return envelope;
};

createEffect(() => {
  const snapshot = cloneState(state);
  if (!storageReady()) return;
  if (applyingExternal) return; // 跨标签页应用撤回时不要用本页旧数据再写一遍
  persist(snapshot);
});

const transaction = (action: string, detail: string, mutator: (draft: CodingState) => void) => {
  setUndoStack((items) => [...items.slice(-49), cloneState(state)]);
  setRedoStack([]);
  const next = cloneState(state);
  mutator(next);
  next.revision = state.revision + 1;
  next.updatedAt = new Date().toISOString();
  next.audit.unshift({ id: crypto.randomUUID(), at: next.updatedAt, action, detail });
  next.audit = next.audit.slice(0, 250);
  setState(reconcile(next, { merge: false }));
  persist(next);
};

/** 撤销/重做栈也必须是净化过的，防止通过历史把原话捞回来。 */
const rememberUndo = (snapshot: CodingState) => {
  setUndoStack((items) => [...items.slice(-49), sanitizeState(snapshot).state]);
};

const clearHistory = () => {
  setUndoStack([]);
  setRedoStack([]);
};

const buildTreeOrder = (themes: Theme[]) => {
  const children = new Map<string | null, Theme[]>();
  themes.forEach((theme) => children.set(theme.parentId, [...(children.get(theme.parentId) ?? []), theme]));
  const result: Theme[] = [];
  const visit = (parentId: string | null, depth: number) => {
    [...(children.get(parentId) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).forEach((theme) => {
      result.push({ ...theme, name: `${'　'.repeat(depth)}${theme.name}` });
      visit(theme.id, depth + 1);
    });
  };
  visit(null, 0);
  return result;
};

const parseTranscript = (raw: string, speakerFallback: string): Array<Pick<Segment, 'time' | 'speaker' | 'text'>> => {
  const rows = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.map((line, index) => {
    const timed = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*(?:[-—])?\s*([^:：]{1,24})[:：]\s*(.+)$/);
    if (timed) return { time: timed[1], speaker: timed[2].trim(), text: timed[3].trim() };
    return { time: `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`, speaker: index % 2 === 0 ? speakerFallback : '访谈者', text: line };
  });
};

/** 应用来自其他标签页的撤回：本页不提升修订号（撤回页已提升），只做净化对账。 */
const applyExternalWithdrawal = (withdrawal: Withdrawal) => {
  const already = state.withdrawals.some((item) => item.transcriptId === withdrawal.transcriptId);
  const hadContent = state.segments.some((segment) => segment.transcriptId === withdrawal.transcriptId);
  applyingExternal = withdrawal.transcriptId;
  const next = sanitizeState(cloneState(state)).state;
  setState(reconcile(next, { merge: false }));
  window.setTimeout(() => { applyingExternal = null; }, 0);
  clearHistory();
  setRemoteEnvelope(null);
  if (!already && hadContent) setExternalWithdrawal(withdrawal);
};

export function useCodingStore() {
  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    // 启动即与持久撤回账本对账（本地快照可能比账本旧，或被其他标签页先撤回）。
    const ledger = readLedger();
    if (ledger.length) {
      const { state: cleaned, scrubbedThemes } = sanitizeState(cloneState(state));
      const before = cloneState(state);
      if (scrubbedThemes.length ||
          cleaned.segments.length !== before.segments.length ||
          cleaned.transcripts.length !== before.transcripts.length ||
          cleaned.withdrawals.length !== (before.withdrawals ?? []).length) {
        setState(reconcile(cleaned, { merge: false }));
      }
    }

    try {
      const stored = await readEnvelope();
      const local = cloneState(state);
      if (stored) {
        // IndexedDB 快照先过账本，防止库里残留旧副本。
        const incoming = sanitizeState(normalizeState(stored.state)).state;
        if (incoming.revision > local.revision || incoming.updatedAt > local.updatedAt) {
          setRemoteEnvelope({ ...stored, state: incoming });
        }
      }
    } finally {
      setStorageReady(true);
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('sologsb-1019-coding');
      channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
        const message = event.data;
        if (!message) return;

        if (message.kind === 'withdrawal') {
          if (message.writerId === TAB_ID) return;
          // 墓碑消息幂等：已撤回则只做一次净化对账。
          applyExternalWithdrawal(message.withdrawal);
          return;
        }

        if (message.kind === 'rollback') {
          if (message.writerId === TAB_ID) return;
          // 其他标签页撤回写入失败后恢复了检查点：把它视为一次新修订，走显式冲突流程，
          // 绝不用它覆盖本页；若本页仍保留撤回结果则由账本在载入时净化。
          setStaleBlockedCount((count) => count + 1);
          return;
        }

        const incoming = message;
        if (incoming.writerId === TAB_ID) return;
        if (incoming.revision === state.revision && incoming.updatedAt === state.updatedAt) return;
        const rawIncoming = normalizeState(incoming.state);
        const { state: cleanState, scrubbedThemes } = sanitizeState(rawIncoming);

        // 关键防护：晚到的旧标签页状态若仍带着已撤回的访谈/片段/原话，净化时会被剥除，
        // 或其修订早于本页 —— 一律拦截，绝不提供“载入旧版本”，已撤回内容不能回来。
        const carriedWithdrawnContent = readLedger().some((entry) =>
          rawIncoming.transcripts.some((transcript) => transcript.id === entry.transcriptId) ||
          rawIncoming.segments.some((segment) => segment.transcriptId === entry.transcriptId));
        if ((carriedWithdrawnContent || scrubbedThemes.length || incoming.revision < state.revision) && state.withdrawals.length) {
          setStaleBlockedCount((count) => count + 1);
          return;
        }
        // 干净的新快照仍交给既有的显式冲突流程，不会静默覆盖。
        setRemoteEnvelope({ revision: cleanState.revision, updatedAt: cleanState.updatedAt, writerId: incoming.writerId, state: cleanState });
      };
    }

    // localStorage 存储事件：撤回账本是同步写入的，其他标签页能立即收到，不等异步快照。
    window.addEventListener('storage', (event) => {
      if (event.key !== LEDGER_STORAGE_EVENT || !event.newValue) return;
      try {
        const ledger = JSON.parse(event.newValue) as Withdrawal[];
        const newest = ledger[0];
        if (newest && newest.writerId !== TAB_ID && !state.withdrawals.some((item) => item.id === newest.id)) {
          applyExternalWithdrawal(newest);
        }
      } catch { /* 账本损坏时忽略，本页账本仍完整 */ }
    });

    // 上次会话撤回写入失败留下检查点：提示研究者恢复或重试。
    const checkpoint = readCheckpoint() ?? await readCheckpointMirror();
    if (checkpoint && readLedger().some((item) => item.transcriptId === checkpoint.transcriptId)) {
      setWithdrawError({
        transcriptId: checkpoint.transcriptId,
        title: checkpoint.title,
        message: '上次撤回同意的清除写入未完成。可以重试彻底清除，或从本地检查点恢复撤回前状态后再处理。'
      });
    }
  };

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = sanitizeState(items[items.length - 1]).state;
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, sanitizeState(cloneState(state)).state]);
    setState(reconcile(previous, { merge: false }));
    persist(previous);
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = sanitizeState(items[items.length - 1]).state;
    setRedoStack(items.slice(0, -1));
    rememberUndo(cloneState(state));
    setState(reconcile(next, { merge: false }));
    persist(next);
  };

  const selectSegment = (id: string) => setState('activeSegmentId', id);
  const selectTranscript = (id: string) => setState('activeTranscriptId', id);
  const selectTheme = (id: string) => setState('activeThemeId', id);
  const setCoder = (coder: CoderId, name: string) => {
    if (coder === 'A') setState('coderA', name);
    else setState('coderB', name);
  };

  const toggleAssignment = (segmentId: string, coder: CoderId, themeId: string, enabled: boolean) => {
    transaction('调整编码', `${coder === 'A' ? state.coderA : state.coderB} ${enabled ? '添加' : '移除'}主题`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (!segment) return;
      const codes = new Set(segment.assignments[coder]);
      if (enabled) codes.add(themeId);
      else codes.delete(themeId);
      segment.assignments[coder] = [...codes];
    });
  };

  const batchAssign = (segmentIds: string[], coder: CoderId, themeId: string) => {
    if (!segmentIds.length) return;
    transaction('批量重编码', `将 ${segmentIds.length} 个片段分配给主题`, (draft) => {
      draft.segments.forEach((segment) => {
        if (segmentIds.includes(segment.id) && !segment.assignments[coder].includes(themeId)) segment.assignments[coder].push(themeId);
      });
    });
  };

  const addTheme = (name: string, parentId: string | null) => {
    const id = `t-${crypto.randomUUID()}`;
    transaction('新建主题', name, (draft) => {
      draft.themes.push({ id, name, parentId, color: parentId ? '#57978c' : '#267365', definition: '', memo: '', examples: [] });
      draft.activeThemeId = id;
    });
    return id;
  };

  const updateTheme = (themeId: string, patch: Partial<Theme>, fieldLabel: string) => {
    transaction('编辑主题', fieldLabel, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme) Object.assign(theme, patch);
    });
  };

  const deleteTheme = (themeId: string) => {
    const theme = state.themes.find((item) => item.id === themeId);
    if (!theme) return;
    transaction('删除主题', theme.name, (draft) => {
      draft.themes = draft.themes.filter((item) => item.id !== themeId);
      draft.themes.forEach((item) => { if (item.parentId === themeId) item.parentId = null; });
      draft.segments.forEach((segment) => {
        segment.assignments.A = segment.assignments.A.filter((id) => id !== themeId);
        segment.assignments.B = segment.assignments.B.filter((id) => id !== themeId);
      });
      if (draft.activeThemeId === themeId) draft.activeThemeId = draft.themes[0]?.id ?? '';
    });
  };

  const mergeThemes = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    transaction('合并主题', `${state.themes.find((item) => item.id === sourceId)?.name ?? sourceId} → ${state.themes.find((item) => item.id === targetId)?.name ?? targetId}`, (draft) => {
      draft.segments.forEach((segment) => {
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          const codes = new Set(segment.assignments[coder].filter((id) => id !== sourceId));
          if (segment.assignments[coder].includes(sourceId)) codes.add(targetId);
          segment.assignments[coder] = [...codes];
        });
      });
      draft.themes.forEach((theme) => { if (theme.parentId === sourceId) theme.parentId = targetId; });
      draft.themes = draft.themes.filter((theme) => theme.id !== sourceId);
      draft.activeThemeId = targetId;
    });
  };

  const splitTheme = (sourceId: string, newName: string, segmentIds: string[]) => {
    const newId = `t-${crypto.randomUUID()}`;
    transaction('拆分主题', newName, (draft) => {
      const source = draft.themes.find((theme) => theme.id === sourceId);
      if (!source) return;
      draft.themes.push({ ...source, id: newId, name: newName, examples: [] });
      draft.segments.forEach((segment) => {
        if (!segmentIds.includes(segment.id)) return;
        (['A', 'B'] as CoderId[]).forEach((coder) => {
          if (segment.assignments[coder].includes(sourceId)) {
            segment.assignments[coder] = segment.assignments[coder].map((id) => id === sourceId ? newId : id);
          }
        });
      });
      draft.activeThemeId = newId;
    });
    return newId;
  };

  const updateSegment = (segmentId: string, patch: Pick<Segment, 'speaker' | 'time' | 'text' | 'note'>) => {
    transaction('编辑片段', `片段 ${segmentId}`, (draft) => {
      const segment = draft.segments.find((item) => item.id === segmentId);
      if (segment) Object.assign(segment, patch);
    });
  };

  const importTranscript = (raw: string, title: string, participant: string, sourceName: string) => {
    const transcriptId = `tr-${crypto.randomUUID()}`;
    const rows = parseTranscript(raw, participant);
    transaction('导入转写', `${title}（${rows.length} 个片段）`, (draft) => {
      draft.transcripts.push({ id: transcriptId, title, participant, importedAt: new Date().toISOString(), sourceName });
      const start = draft.segments.length;
      const segments: Segment[] = rows.map((row, index) => ({
        id: `s-${crypto.randomUUID()}`,
        transcriptId,
        order: start + index,
        speaker: row.speaker,
        time: row.time,
        text: row.text,
        assignments: { A: [], B: [] },
        note: ''
      }));
      draft.segments.push(...segments);
      draft.activeTranscriptId = transcriptId;
      draft.activeSegmentId = segments[0]?.id ?? draft.activeSegmentId;
    });
  };

  const addExample = (themeId: string, example: string) => {
    const trimmed = example.trim();
    if (!trimmed) return;
    transaction('添加主题示例', trimmed, (draft) => {
      const theme = draft.themes.find((item) => item.id === themeId);
      if (theme && !theme.examples.includes(trimmed)) theme.examples.push(trimmed);
    });
  };

  /* ---------------- 撤回同意 ---------------- */

  const withdrawalReferences = (transcriptId: string): WithdrawalReference[] =>
    findReferences(cloneState(state), transcriptId);

  /** 研究者在撤回对话框中逐条处理引用：清空该位置内容，不允许把原话留到撤回后。 */
  const resolveReference = (reference: WithdrawalReference) => {
    transaction('处理撤回引用', `清空“${reference.themeName}”的${reference.fieldLabel}`, (draft) => {
      const theme = draft.themes.find((item) => item.id === reference.themeId);
      if (!theme) return;
      if (reference.field === 'definition') theme.definition = '';
      else if (reference.field === 'memo') theme.memo = '';
      else theme.examples = theme.examples.filter((_, index) => String(index) !== reference.key);
    });
  };

  const resolveAllReferences = (transcriptId: string) => {
    const references = withdrawalReferences(transcriptId);
    if (!references.length) return;
    transaction('批量处理撤回引用', `清空 ${references.length} 处引用了原话的主题文本`, (draft) => {
      references.forEach((reference) => {
        const theme = draft.themes.find((item) => item.id === reference.themeId);
        if (!theme) return;
        if (reference.field === 'definition') theme.definition = '';
        else if (reference.field === 'memo') theme.memo = '';
        else theme.examples = theme.examples.filter((_, index) => String(index) !== reference.key);
      });
    });
  };

  const performWithdrawal = async (transcriptId: string, reason: string): Promise<Withdrawal> => {
    const snapshot = cloneState(state);
    const entry = buildWithdrawalEntry(snapshot, transcriptId, reason, TAB_ID);
    if (!entry) throw new Error('找不到要撤回的访谈');

    // 1. 撤回前本地检查点（localStorage + IndexedDB 双写），写入失败期间可恢复。
    const checkpoint = writeCheckpoint(snapshot, transcriptId);
    try {
      await writeCheckpointMirror(checkpoint);
    } catch (error) {
      console.warn('检查点 IndexedDB 镜像写入失败，仍可从 localStorage 恢复', error);
    }

    // 2. 撤回墓碑先持久化到独立账本——即使后面的状态写入失败，账本也已生效，
    //    任何旧状态重新写入都会被 sanitizeState 拦截净化。
    addToLedger(entry);

    // 3. 在内存中彻底清除：访谈、片段原文、A/B 判断、片段备忘、主题文本中的原话。
    const { state: withdrawn } = applyWithdrawal(snapshot, entry);
    withdrawn.revision = snapshot.revision + 1;
    withdrawn.updatedAt = entry.withdrawnAt;

    setWithdrawError(null);
    applyingExternal = transcriptId;
    setState(reconcile(withdrawn, { merge: false }));
    window.setTimeout(() => { applyingExternal = null; }, 0);
    clearHistory(); // 撤回不可通过撤销重做找回

    // 4. 状态即时持久化；失败则保留检查点并提示，账本依然阻止原话回流。
    try {
      await persistNow(withdrawn);
    } catch (error) {
      setWithdrawError({ transcriptId, title: entry.title, message: `清除结果写入本地数据库失败：${error instanceof Error ? error.message : '未知错误'}。撤回墓碑已生效，可重试写入或从本地检查点恢复。` });
      throw error;
    }

    // 5. 写入成功后删除检查点：彻底清除后工作台只剩处理结果。
    clearCheckpoint();
    try { await clearCheckpointMirror(); } catch { /* 镜像清理失败不影响撤回效力 */ }

    postMessage({ kind: 'withdrawal', withdrawal: entry, writerId: TAB_ID, at: entry.withdrawnAt });
    setLastWithdrawal(entry);
    return entry;
  };

  /** 写入失败后的重试：以检查点状态为基础重新执行清除并持久化。 */
  const retryWithdrawal = async (reason: string): Promise<Withdrawal | null> => {
    const checkpoint = readCheckpoint() ?? await readCheckpointMirror();
    if (!checkpoint) {
      setWithdrawError(null);
      return null;
    }
    const snapshot = sanitizeState(normalizeState(checkpoint.state)).state;
    const existing = readLedger().find((item) => item.transcriptId === checkpoint.transcriptId);
    const entry: Withdrawal = existing ?? {
      ...(buildWithdrawalEntry(snapshot, checkpoint.transcriptId, reason, TAB_ID)!),
      withdrawnAt: checkpoint.createdAt
    };
    const { state: withdrawn } = applyWithdrawal(snapshot, entry);
    withdrawn.revision = Math.max(snapshot.revision, state.revision) + 1;
    withdrawn.updatedAt = new Date().toISOString();
    applyingExternal = checkpoint.transcriptId;
    setState(reconcile(withdrawn, { merge: false }));
    window.setTimeout(() => { applyingExternal = null; }, 0);
    clearHistory();
    try {
      await persistNow(withdrawn);
      clearCheckpoint();
      await clearCheckpointMirror();
      setWithdrawError(null);
      setLastWithdrawal(entry);
      postMessage({ kind: 'withdrawal', withdrawal: entry, writerId: TAB_ID, at: entry.withdrawnAt });
      return entry;
    } catch (error) {
      setWithdrawError({ transcriptId: checkpoint.transcriptId, title: checkpoint.title, message: `重试写入仍失败：${error instanceof Error ? error.message : '未知错误'}。检查点继续保留。` });
      throw error;
    }
  };

  /** 从本地检查点恢复撤回前状态（仅本标签页），并回滚本页账本，随后研究者可重新处理。 */
  const restoreFromCheckpoint = async (): Promise<boolean> => {
    const checkpoint = readCheckpoint() ?? await readCheckpointMirror();
    if (!checkpoint) return false;
    const restored = normalizeState(checkpoint.state);
    removeFromLedger(checkpoint.transcriptId);
    restored.withdrawals = restored.withdrawals.filter((item) => item.transcriptId !== checkpoint.transcriptId);
    restored.revision = state.revision + 1;
    restored.updatedAt = new Date().toISOString();
    restored.audit.unshift({
      id: crypto.randomUUID(),
      at: restored.updatedAt,
      action: '恢复撤回前检查点',
      detail: `《${checkpoint.title}》因撤回写入失败，已从本地检查点恢复到撤回前状态，请处理后重新发起撤回`
    });
    setState(reconcile(restored, { merge: false }));
    clearHistory();
    try {
      await persistNow(restored);
      clearCheckpoint();
      await clearCheckpointMirror();
      setWithdrawError(null);
      postMessage({ kind: 'rollback', transcriptId: checkpoint.transcriptId, writerId: TAB_ID, at: restored.updatedAt });
      return true;
    } catch (error) {
      setWithdrawError({ transcriptId: checkpoint.transcriptId, title: checkpoint.title, message: `恢复写入失败：${error instanceof Error ? error.message : '未知错误'}。检查点仍保留，可再次尝试。` });
      return false;
    }
  };

  const dismissExternalNotice = () => setExternalWithdrawal(null);
  const dismissWithdrawalResult = () => setLastWithdrawal(null);
  const dismissStaleNotice = () => setStaleBlockedCount(0);
  const dismissWithdrawError = () => setWithdrawError(null);

  const exportCoding = (format: 'json' | 'csv') => {
    // 导出前再与账本对账：已撤回访谈、片段与任何原话都不会进入导出文件。
    const clean = sanitizeState(cloneState(state)).state;
    const themeMap = new Map(clean.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), ...clean }, null, 2);
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    clean.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? clean.coderA : clean.coderB;
        const themeIds = segment.assignments[coder];
        const paths = themeIds.length ? themeIds.map((id) => {
          const names: string[] = [];
          let current = themeMap.get(id);
          while (current) {
            names.unshift(current.name);
            current = current.parentId ? themeMap.get(current.parentId) : undefined;
          }
          return names.join(' / ');
        }) : ['未编码'];
        rows.push([segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segment.note].map(escape).join(','));
      });
    });
    return `﻿${rows.join('\n')}`;
  };

  const downloadExport = (format: 'json' | 'csv') => {
    const content = exportCoding(format);
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const keepLocalVersion = () => {
    setRemoteEnvelope(null);
    transaction('处理多标签冲突', '保留当前标签页版本并生成新修订', () => undefined);
  };

  const applyRemoteVersion = () => {
    const remote = remoteEnvelope();
    if (!remote) return;
    rememberUndo(cloneState(state));
    setRedoStack([]);
    // 载入的外部版本同样要过账本，且撤回相关的历史不可带回原话。
    setState(reconcile(sanitizeState(normalizeState(remote.state)).state, { merge: false }));
    setRemoteEnvelope(null);
  };

  const orderedThemes = () => buildTreeOrder(state.themes);

  return {
    state,
    initialize,
    undo,
    redo,
    canUndo: () => undoStack().length > 0,
    canRedo: () => redoStack().length > 0,
    selectSegment,
    selectTranscript,
    selectTheme,
    setCoder,
    toggleAssignment,
    batchAssign,
    addTheme,
    updateTheme,
    deleteTheme,
    mergeThemes,
    splitTheme,
    updateSegment,
    importTranscript,
    addExample,
    exportCoding,
    downloadExport,
    orderedThemes,
    remoteEnvelope,
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt,
    // 撤回同意
    withdrawalReferences,
    resolveReference,
    resolveAllReferences,
    performWithdrawal,
    retryWithdrawal,
    restoreFromCheckpoint,
    staleBlockedCount,
    externalWithdrawal,
    withdrawError,
    lastWithdrawal,
    dismissExternalNotice,
    dismissWithdrawalResult,
    dismissStaleNotice,
    dismissWithdrawError
  };
}
