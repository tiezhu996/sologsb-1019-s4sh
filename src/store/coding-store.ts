import { createEffect, createSignal } from 'solid-js';
import { createStore, reconcile, unwrap } from 'solid-js/store';
import { seedState } from '../data/seed';
import type {
  CoderId,
  ChannelMessage,
  CodingState,
  ExportLogEntry,
  PersistedEnvelope,
  Segment,
  Theme,
  WithdrawCheckpoint,
  WithdrawalRecord,
  WithdrawnReferenceLocation
} from '../types';
import {
  commitWithdrawal,
  deleteCheckpoint,
  readCheckpoint,
  readEnvelope,
  readTombstones,
  saveCheckpoint,
  saveExport,
  writeEnvelope,
  type SavedExport
} from '../utils/db';
import {
  applyReferenceRedactions,
  collectNeedles,
  reconcileWithdrawals,
  scanReferences,
  scrubAuditTrail
} from '../utils/withdrawal';

const STORAGE_KEY = 'sologsb-1019-state-v1';
const TOMBSTONE_CACHE_KEY = 'sologsb-1019-withdrawals-v1';
const CHECKPOINT_KEY = 'sologsb-1019-withdraw-checkpoint-v1';
const TAB_ID = crypto.randomUUID();

const cloneState = (state: CodingState): CodingState => structuredClone(unwrap(state));

/** 补齐历史版本状态里缺失的撤回字段 */
const normalizeState = (input: CodingState): CodingState => ({
  ...input,
  withdrawals: Array.isArray(input.withdrawals) ? input.withdrawals : [],
  exportLogs: Array.isArray(input.exportLogs) ? input.exportLogs : []
});

const loadLocal = (): CodingState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeState(JSON.parse(raw) as CodingState);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return seedState();
};

const readTombstoneCache = (): WithdrawalRecord[] => {
  try {
    const raw = localStorage.getItem(TOMBSTONE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as WithdrawalRecord[]) : [];
  } catch {
    return [];
  }
};

const writeTombstoneCache = (records: WithdrawalRecord[]) => {
  const merged = new Map<string, WithdrawalRecord>();
  records.forEach((record) => merged.set(record.id, record));
  readTombstoneCache().forEach((record) => {
    if (!merged.has(record.id)) merged.set(record.id, record);
  });
  localStorage.setItem(TOMBSTONE_CACHE_KEY, JSON.stringify([...merged.values()]));
};

const writeCheckpointStorage = async (checkpoint: WithdrawCheckpoint) => {
  // localStorage 同步副本是主检查点（跨标签页即时可读）；它失败才真正中止撤回
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  // IndexedDB 仅作冗余备份，失败不影响后续提交与恢复
  try {
    await saveCheckpoint(checkpoint);
  } catch {
    /* localStorage 检查点仍可用于恢复或重试 */
  }
};

const readCheckpointStorage = (): WithdrawCheckpoint | null => {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (raw) return JSON.parse(raw) as WithdrawCheckpoint;
  } catch {
    /* fall through to IndexedDB */
  }
  return null;
};

const clearCheckpointStorage = async (id: string) => {
  localStorage.removeItem(CHECKPOINT_KEY);
  try {
    await deleteCheckpoint(id);
  } catch {
    /* localStorage 主检查点已删除，IndexedDB 冗余副本可在下次启动时清理 */
  }
};

const [state, setState] = createStore<CodingState>(initialState());
const [undoStack, setUndoStack] = createSignal<CodingState[]>([]);
const [redoStack, setRedoStack] = createSignal<CodingState[]>([]);
const [remoteEnvelope, setRemoteEnvelope] = createSignal<PersistedEnvelope | null>(null);
const [storageReady, setStorageReady] = createSignal(false);
const [lastSavedAt, setLastSavedAt] = createSignal<Date | null>(null);
const [saveError, setSaveError] = createSignal<string | null>(null);
const [withdrawError, setWithdrawError] = createSignal<{ transcriptId: string; message: string } | null>(null);
const [pendingCheckpoint, setPendingCheckpoint] = createSignal<WithdrawCheckpoint | null>(null);
const [recoveredNotice, setRecoveredNotice] = createSignal<string | null>(null);
const [suppressedNotice, setSuppressedNotice] = createSignal<string | null>(null);
let channel: BroadcastChannel | null = null;
let saveTimer: number | undefined;
let cachedTombstones: WithdrawalRecord[] = readTombstoneCache();

/** 模块加载即应用同步墓碑缓存：任何路径写出的状态都不含已撤回原文 */
function initialState(): CodingState {
  const loaded = normalizeState(loadLocal());
  reconcileWithdrawals(loaded, readTombstoneCache());
  return loaded;
}

/** 写出前最后一道防线：用同步墓碑缓存清洗快照 */
const sanitizeSnapshot = (snapshot: CodingState): CodingState => {
  reconcileWithdrawals(snapshot, cachedTombstones);
  return snapshot;
};

const persist = (snapshot: CodingState, immediate = false) => {
  window.clearTimeout(saveTimer);
  const flush = async () => {
    const clean = sanitizeSnapshot(snapshot);
    const envelope: PersistedEnvelope = {
      revision: clean.revision,
      updatedAt: clean.updatedAt,
      writerId: TAB_ID,
      state: clean
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
      await writeEnvelope(envelope);
      setSaveError(null);
      setLastSavedAt(new Date());
      const message: ChannelMessage = { kind: 'envelope', envelope };
      channel?.postMessage(message);
    } catch (error) {
      setSaveError(`本地数据库写入失败：${error instanceof Error ? error.message : String(error)}。内容已保存在浏览器本地缓存中。`);
    }
  };
  if (immediate) void flush();
  else saveTimer = window.setTimeout(flush, 180);
};

createEffect(() => {
  const snapshot = cloneState(state);
  if (!storageReady()) return;
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
  setState(reconcile(normalizeState(next), { merge: false }));
  persist(next);
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

export function useCodingStore() {
  /** 吸收其他标签页的撤回：本地立即清洗，绝不允许旧状态把原文带回 */
  const absorbWithdrawal = (record: WithdrawalRecord): boolean => {
    if (cachedTombstones.some((item) => item.id === record.id) &&
        state.withdrawals.some((item) => item.id === record.id)) return false;
    cachedTombstones = [...cachedTombstones.filter((item) => item.id !== record.id), record];
    writeTombstoneCache(cachedTombstones);
    const before = state.withdrawals.length;
    absorbWithdrawalsSilently([record]);
    return state.withdrawals.length > before;
  };

  const sanitizeIncomingEnvelope = (envelope: PersistedEnvelope): PersistedEnvelope => {
    normalizeState(envelope.state);
    // 纵深防御：信封自带的撤回记录同样作为墓碑应用，本端缓存缺失时也不会漏
    const incoming = envelope.state.withdrawals.filter(
      (record) => !cachedTombstones.some((item) => item.id === record.id)
    );
    if (incoming.length) {
      cachedTombstones = [...cachedTombstones, ...incoming];
      writeTombstoneCache(cachedTombstones);
    }
    reconcileWithdrawals(envelope.state, cachedTombstones);
    return envelope;
  };

  const initialize = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    // 1) 合并 IndexedDB 墓碑与同步缓存（其他标签页可能先撤回）
    try {
      const dbTombstones = await readTombstones();
      cachedTombstones = [...dbTombstones, ...cachedTombstones.filter((cache) => !dbTombstones.some((item) => item.id === cache.id))];
      writeTombstoneCache(cachedTombstones);
    } catch {
      /* 同步缓存仍是有效防线 */
    }

    // 2) 内存状态先按全部墓碑清洗
    const local = cloneState(state);
    reconcileWithdrawals(local, cachedTombstones);
    setState(reconcile(local, { merge: false }));

    // 3) 检查上次撤回是否留下未完成的检查点
    const checkpoint = readCheckpointStorage();
    let idbCheckpoint: WithdrawCheckpoint | null = null;
    try {
      idbCheckpoint = await readCheckpoint();
    } catch {
      /* ignore */
    }
    const failed = checkpoint ?? idbCheckpoint;
    if (failed) {
      setPendingCheckpoint(failed);
      setWithdrawError({ transcriptId: failed.transcriptId, message: '上次撤回写入未完成。可重试提交，或从本地检查点恢复到撤回前状态。' });
    }

    setStorageReady(true);

    // 4) 读取持久化状态，任何已知撤回都先清洗，再判断是否为更新修订
    try {
      const stored = await readEnvelope();
      if (stored) {
        normalizeState(stored.state);
        reconcileWithdrawals(stored.state, cachedTombstones);
        const current = cloneState(state);
        if (stored.revision > current.revision || stored.updatedAt > current.updatedAt) {
          setRemoteEnvelope(stored);
        }
      }
    } catch {
      /* 本地内存与 localStorage 仍可用 */
    }

    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('sologsb-1019-coding');
      channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
        const message = event.data;
        if (!message) return;
        if (message.kind === 'withdrawal') {
          absorbWithdrawal(message.record);
          return;
        }
        const incoming = message.envelope;
        if (!incoming || incoming.writerId === TAB_ID) return;
        sanitizeIncomingEnvelope(incoming);
        if (incoming.revision === state.revision && incoming.updatedAt === state.updatedAt) return;
        setRemoteEnvelope(incoming);
      };
    }

    // localStorage 在多标签页间即时同步：即使广播晚到，撤回墓碑也会先一步
    // 更新到本标签页，保证任何待执行的写入都带着最新墓碑清洗。
    window.addEventListener('storage', (event) => {
      if (event.key !== TOMBSTONE_CACHE_KEY) return;
      try {
        const latest = event.newValue ? (JSON.parse(event.newValue) as WithdrawalRecord[]) : [];
        const known = new Set(cachedTombstones.map((record) => record.id));
        const arrived = latest.filter((record) => !known.has(record.id));
        if (arrived.length) {
          cachedTombstones = latest;
          absorbWithdrawalsSilently(arrived);
        }
      } catch {
        /* ignore malformed cache */
      }
    });
  };

  /** 只做确定性清洗，不弹窗（用于 storage 事件等被动同步场景） */
  const absorbWithdrawalsSilently = (records: WithdrawalRecord[]) => {
    const next = cloneState(state);
    const changed = reconcileWithdrawals(next, records);
    if (!changed) return;
    next.revision = state.revision + 1;
    next.updatedAt = new Date().toISOString();
    setUndoStack([]);
    setRedoStack([]);
    setRemoteEnvelope(null);
    setState(reconcile(next, { merge: false }));
    persist(next, true);
    setSuppressedNotice(`其他标签页完成了 ${records.length} 份同意撤回，本页原文已同步清除，旧状态无法将其带回。`);
  };

  const undo = () => {
    const items = undoStack();
    if (!items.length) return;
    const previous = items[items.length - 1];
    // 撤销栈里的历史状态同样必须先过墓碑清洗
    reconcileWithdrawals(previous, cachedTombstones);
    setUndoStack(items.slice(0, -1));
    setRedoStack((redo) => [...redo, cloneState(state)]);
    setState(reconcile(previous, { merge: false }));
    persist(previous);
  };

  const redo = () => {
    const items = redoStack();
    if (!items.length) return;
    const next = items[items.length - 1];
    reconcileWithdrawals(next, cachedTombstones);
    setRedoStack(items.slice(0, -1));
    setUndoStack((undoItems) => [...undoItems, cloneState(state)]);
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
            segment.assignments[coder] = segment.assignments[coder].map((id) => (id === sourceId ? newId : id));
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

  /** 预览某次撤回会波及的原话引用位置 */
  const previewWithdrawal = (transcriptId: string): WithdrawnReferenceLocation[] => {
    const segments = state.segments.filter((segment) => segment.transcriptId === transcriptId);
    if (!segments.length) return [];
    return scanReferences(unwrap(state.themes), collectNeedles(segments.map((segment) => unwrap(segment))));
  };

  /**
   * 执行同意撤回。manualKeys 中的引用位置由研究者自行改写，
   * 其余位置系统自动抹除原话。
   */
  const withdrawConsent = async (transcriptId: string, note: string, manualKeys: string[]): Promise<{ ok: true; record: WithdrawalRecord } | { ok: false; message: string; remaining: WithdrawnReferenceLocation[] }> => {
    const transcript = state.transcripts.find((item) => item.id === transcriptId);
    const segments = state.segments.filter((segment) => segment.transcriptId === transcriptId);
    if (!transcript || !segments.length) return { ok: false, message: '找不到要撤回的访谈。', remaining: [] };

    const needles = collectNeedles(segments.map((segment) => unwrap(segment)));
    const scanned = scanReferences(unwrap(state.themes), needles);
    const keyOf = (location: WithdrawnReferenceLocation) =>
      `${location.themeId}:${location.field}:${location.exampleIndex ?? -1}`;
    const manualSet = new Set(manualKeys);
    const locations: WithdrawnReferenceLocation[] = scanned.map((location) => ({
      ...location,
      action: manualSet.has(keyOf(location)) ? 'manual' : 'redacted'
    }));
    const stillQuoted = locations.filter((location) => location.action === 'manual');

    // 研究者选择自行处理的位置，必须先把原话真正改写掉，否则撤回不允许完成
    if (stillQuoted.length) {
      const probe = cloneState(state);
      const autoLocations = locations.filter((location) => location.action === 'redacted');
      applyReferenceRedactions(probe, autoLocations, needles);
      const rescanned = scanReferences(probe.themes, needles);
      const remaining = rescanned.filter((location) =>
        stillQuoted.some((item) => item.themeId === location.themeId && item.field === location.field && item.exampleIndex === location.exampleIndex)
      );
      if (remaining.length) {
        return { ok: false, message: '仍有主题定义、备忘录或示例保留了原话，请先抹除或改写后再完成撤回。', remaining: rescanned };
      }
    }

    const now = new Date().toISOString();
    const recordId = `w-${crypto.randomUUID()}`;
    const codingCount = segments.reduce(
      (count, segment) => count + segment.assignments.A.length + segment.assignments.B.length,
      0
    );
    const themeIds = new Set<string>();
    segments.forEach((segment) => {
      segment.assignments.A.forEach((id) => themeIds.add(id));
      segment.assignments.B.forEach((id) => themeIds.add(id));
    });

    // 1) 先写本地检查点（撤回前完整快照），写入失败时可恢复
    const preState = cloneState(state);
    const checkpoint: WithdrawCheckpoint = { id: `cp-${recordId}`, transcriptId, at: now, state: preState };
    try {
      await writeCheckpointStorage(checkpoint);
    } catch (error) {
      return { ok: false, message: `检查点保存失败，撤回已中止：${error instanceof Error ? error.message : String(error)}`, remaining: scanned };
    }

    // 2) 构造撤回后的状态（不经过普通事务与撤销栈）
    const next = cloneState(state);
    applyReferenceRedactions(next, locations, needles);
    const scrubbedAuditCount = scrubAuditTrail(next, needles);
    const purgedExportLogs: ExportLogEntry[] = next.exportLogs.filter((log) => log.transcriptIds.includes(transcriptId));
    next.exportLogs = next.exportLogs.filter((log) => !log.transcriptIds.includes(transcriptId));
    next.segments = next.segments.filter((segment) => segment.transcriptId !== transcriptId);
    next.transcripts = next.transcripts.filter((item) => item.id !== transcriptId);

    const record: WithdrawalRecord = {
      id: recordId,
      transcriptId,
      transcriptTitle: transcript.title,
      participantLabel: transcript.participant,
      sourceName: transcript.sourceName,
      importedAt: transcript.importedAt,
      requestedAt: now,
      completedAt: now,
      segmentCount: segments.length,
      codingCount,
      assignmentThemeIds: [...themeIds],
      references: locations,
      purgedExports: purgedExportLogs,
      scrubbedAuditCount,
      note: note.trim()
    };
    next.withdrawals = [record, ...next.withdrawals.filter((item) => item.id !== recordId)];
    if (next.activeTranscriptId === transcriptId) {
      next.activeTranscriptId = next.transcripts[0]?.id ?? '';
      next.activeSegmentId = next.segments.find((segment) => segment.transcriptId === next.activeTranscriptId)?.id ?? '';
    }
    next.revision = state.revision + 1;
    next.updatedAt = now;
    next.audit.unshift({ id: crypto.randomUUID(), at: now, action: '同意撤回', detail: `${transcript.title}：原文、片段与判断已彻底移除，仅保留撤回记录` });
    next.audit = next.audit.slice(0, 250);

    // 3) 乐观更新界面（此时不经过撤销栈，撤回不可撤销）
    setUndoStack([]);
    setRedoStack([]);
    setRemoteEnvelope(null);
    setWithdrawError(null);
    setState(reconcile(next, { merge: false }));

    // 4) 墓碑与状态同事务落盘；失败则保留检查点，等待重试或恢复
    const envelope: PersistedEnvelope = { revision: next.revision, updatedAt: next.updatedAt, writerId: TAB_ID, state: next };
    try {
      await commitWithdrawal(record, envelope);
      // 墓碑只在持久化成功后发布：失败时恢复检查点才能真正回到撤回前状态
      cachedTombstones = [...cachedTombstones.filter((item) => item.id !== recordId), record];
      writeTombstoneCache(cachedTombstones);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      await clearCheckpointStorage(checkpoint.id);
      setPendingCheckpoint(null);
      setLastSavedAt(new Date());
      const message: ChannelMessage = { kind: 'withdrawal', record };
      channel?.postMessage(message);
    } catch (error) {
      setPendingCheckpoint(checkpoint);
      setWithdrawError({ transcriptId, message: `撤回写入失败：${error instanceof Error ? error.message : String(error)}。可重试，或从本地检查点恢复。` });
      return { ok: false, message: '撤回写入失败，已保留本地检查点，可重试或恢复。', remaining: stillQuoted };
    }

    return { ok: true, record };
  };

  /** 上次写入失败后重试提交 */
  const retryWithdrawal = async () => {
    const checkpoint = pendingCheckpoint();
    const failed = withdrawError();
    if (!checkpoint || !failed) return { ok: false as const, message: '没有可重试的撤回。' };
    const record = state.withdrawals.find((item) => item.transcriptId === checkpoint.transcriptId);
    if (!record) return { ok: false as const, message: '撤回记录缺失，无法重试，请改从检查点恢复。' };
    const next = cloneState(state);
    const envelope: PersistedEnvelope = { revision: next.revision, updatedAt: next.updatedAt, writerId: TAB_ID, state: next };
    try {
      await commitWithdrawal(record, envelope);
      cachedTombstones = [...cachedTombstones.filter((item) => item.id !== record.id), record];
      writeTombstoneCache(cachedTombstones);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      await clearCheckpointStorage(checkpoint.id);
      setPendingCheckpoint(null);
      setWithdrawError(null);
      setLastSavedAt(new Date());
      channel?.postMessage({ kind: 'withdrawal', record } satisfies ChannelMessage);
      return { ok: true as const, record };
    } catch (error) {
      setWithdrawError({ transcriptId: checkpoint.transcriptId, message: `撤回写入仍失败：${error instanceof Error ? error.message : String(error)}。` });
      return { ok: false as const, message: '重试失败，检查点仍保留。' };
    }
  };

  /** 从检查点恢复到撤回前状态（仅在撤回未成功落盘时允许） */
  const restoreFromCheckpoint = async () => {
    const checkpoint = pendingCheckpoint();
    if (!checkpoint) return;
    const restored = normalizeState(structuredClone(checkpoint.state));
    setUndoStack([]);
    setRedoStack([]);
    setState(reconcile(restored, { merge: false }));
    try {
      await clearCheckpointStorage(checkpoint.id);
    } finally {
      setPendingCheckpoint(null);
      setWithdrawError(null);
      setRecoveredNotice('已从本地检查点恢复到撤回前状态，原文未被清除。');
      persist(restored, true);
    }
  };

  const dismissWithdrawError = () => setWithdrawError(null);
  const clearSuppressedNotice = () => setSuppressedNotice(null);
  const clearRecoveredNotice = () => setRecoveredNotice(null);

  const exportCoding = (format: 'json' | 'csv') => {
    const segmentMap = new Map(state.segments.map((segment) => [segment.id, segment]));
    const themeMap = new Map(state.themes.map((theme) => [theme.id, theme]));
    if (format === 'json') return JSON.stringify({ exportedAt: new Date().toISOString(), ...cloneState(state) }, null, 2);
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const rows = [['片段编号', '时间', '发言人', '原文', '编码者', '主题路径', '备忘录'].map(escape).join(',')];
    state.segments.forEach((segment) => {
      (['A', 'B'] as CoderId[]).forEach((coder) => {
        const name = coder === 'A' ? state.coderA : state.coderB;
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
        rows.push([segment.id, segment.time, segment.speaker, segment.text, name, paths.join(' | '), segmentMap.get(segment.id)?.note ?? ''].map(escape).join(','));
      });
    });
    return `﻿${rows.join('\n')}`;
  };

  const downloadExport = async (format: 'json' | 'csv') => {
    const transcriptIds = [...new Set(state.segments.map((segment) => segment.transcriptId))];
    if (cachedTombstones.some((record) => transcriptIds.includes(record.transcriptId))) {
      setSuppressedNotice('导出内容包含已撤回访谈，已被系统阻止。');
      return;
    }
    const content = exportCoding(format);
    const id = `e-${crypto.randomUUID()}`;
    const fileName = `访谈编码结果-${new Date().toISOString().slice(0, 10)}.${format}`;
    const saved: SavedExport = {
      id,
      at: new Date().toISOString(),
      format,
      fileName,
      transcriptIds,
      content
    };
    // 工作台内导出物本身也可能保存原文，先尝试落盘；墓碑检查不通过则直接拒绝
    try {
      await saveExport(saved);
    } catch (error) {
      setSuppressedNotice(error instanceof Error ? error.message : '导出保存被阻止。');
      return;
    }
    transaction('导出编码', `${format.toUpperCase()}（${state.segments.length} 个片段）`, (draft) => {
      const log: ExportLogEntry = { id, at: saved.at, format, transcriptIds };
      draft.exportLogs = [log, ...draft.exportLogs.filter((item) => item.id !== id)].slice(0, 100);
    });
    const blob = new Blob([content], { type: format === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
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
    // 载入旧版本前再次清洗：晚到状态无法把已撤回内容带回
    sanitizeIncomingEnvelope(remote);
    setUndoStack((items) => [...items, cloneState(state)]);
    setRedoStack([]);
    setState(reconcile(remote.state, { merge: false }));
    setRemoteEnvelope(null);
    persist(remote.state);
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
    previewWithdrawal,
    withdrawConsent,
    retryWithdrawal,
    restoreFromCheckpoint,
    dismissWithdrawError,
    withdrawError,
    pendingCheckpoint,
    suppressedNotice,
    clearSuppressedNotice,
    recoveredNotice,
    clearRecoveredNotice,
    exportCoding,
    downloadExport,
    orderedThemes,
    remoteEnvelope,
    keepLocalVersion,
    applyRemoteVersion,
    storageReady,
    lastSavedAt,
    saveError
  };
}

export type CodingStore = ReturnType<typeof useCodingStore>;
