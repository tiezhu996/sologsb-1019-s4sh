import type { CodingState, Theme, Withdrawal, WithdrawalCheckpoint } from '../types';

/**
 * 撤回账本独立持久化在 localStorage 中，且不随任何“完整状态快照”流转。
 * 任何标签页、任何来源（IndexedDB / BroadcastChannel / 撤销重做 / 本地检查点恢复之外的状态）
 * 写入或展示状态前，都必须经过 sanitizeState 与账本对账——这是防止旧状态把已撤回内容带回来的咽喉。
 */
const LEDGER_KEY = 'sologsb-1019-withdrawal-ledger-v1';
const CHECKPOINT_KEY = 'sologsb-1019-withdrawal-checkpoint-v1';

/** 原文被清除后在主题定义 / 备忘录 / 示例中留下的标记。 */
export const REDACTION_MARK = '［受访者撤回同意，原文已清除］';

/* ------------------------------------------------------------------ */
/* 撤回账本                                                            */
/* ------------------------------------------------------------------ */

export const readLedger = (): Withdrawal[] => {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Withdrawal[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    localStorage.removeItem(LEDGER_KEY);
  }
  return [];
};

export const writeLedger = (ledger: Withdrawal[]): void => {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
};

export const addToLedger = (entry: Withdrawal): Withdrawal[] => {
  const ledger = readLedger().filter((item) => item.transcriptId !== entry.transcriptId);
  const next = [entry, ...ledger].sort((a, b) => b.withdrawnAt.localeCompare(a.withdrawnAt));
  writeLedger(next);
  return next;
};

export const removeFromLedger = (transcriptId: string): Withdrawal[] => {
  const next = readLedger().filter((item) => item.transcriptId !== transcriptId);
  writeLedger(next);
  return next;
};

export const isWithdrawn = (transcriptId: string): boolean =>
  readLedger().some((item) => item.transcriptId === transcriptId);

/* ------------------------------------------------------------------ */
/* 本地检查点（撤回写入失败后恢复用）                                   */
/* ------------------------------------------------------------------ */

export const readCheckpoint = (): WithdrawalCheckpoint | null => {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WithdrawalCheckpoint;
      if (parsed && parsed.state && parsed.transcriptId) return parsed;
    }
  } catch {
    localStorage.removeItem(CHECKPOINT_KEY);
  }
  return null;
};

export const writeCheckpoint = (snapshot: CodingState, transcriptId: string): WithdrawalCheckpoint => {
  const transcript = snapshot.transcripts.find((item) => item.id === transcriptId);
  const checkpoint: WithdrawalCheckpoint = {
    id: `cp-${crypto.randomUUID()}`,
    transcriptId,
    title: transcript?.title ?? '已撤回访谈',
    participant: transcript?.participant ?? '受访者',
    createdAt: new Date().toISOString(),
    state: snapshot
  };
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
  return checkpoint;
};

export const clearCheckpoint = (): void => {
  localStorage.removeItem(CHECKPOINT_KEY);
};

/* ------------------------------------------------------------------ */
/* 原文匹配（用于净化主题定义/备忘录/示例，以及撤回前列位置清单）         */
/* ------------------------------------------------------------------ */

const normalize = (value: string): string => value.replace(/[\s，。！？、；：“”"‘’'（）()【】\[\]…—\-,.!?;:]/g, '');

/** 直接引用匹配的最短长度，避免“她”“学校”这类常用词误伤主题文本。 */
const MIN_QUOTE_NEEDLE = 8;

const quoteNeedles = (text: string): string[] => {
  const normalized = normalize(text);
  if (normalized.length < MIN_QUOTE_NEEDLE) return [];
  return [normalized];
};

/** 用已撤回片段的原话清理一段文本；命中则整句级替换为撤回标记。 */
export const scrubText = (input: string, needles: string[]): string => {
  if (!input.trim() || !needles.length) return input;
  let output = input;
  needles.forEach((needle) => {
    const normalizedNeedle = normalize(needle);
    if (normalizedNeedle.length < MIN_QUOTE_NEEDLE) return;
    // 按常见中文断句切分，命中原话的整句替换，保留研究者自己写的分析文字。
    output = output.split(/(?<=[。！？!?；;\n])/).map((sentence) => {
      if (!sentence.trim()) return sentence;
      const normalizedSentence = normalize(sentence);
      if (!normalizedSentence.includes(normalizedNeedle)) return sentence;
      // 整句几乎都是原话（如直接粘贴的示例）→ 整句清除；只是研究分析中顺带提及 → 同样清除该句。
      return REDACTION_MARK;
    }).join('');
  });
  const normalizedOutput = normalize(output);
  needles.forEach((needle) => {
    const normalizedNeedle = normalize(needle);
    // 无句读文本：原话占绝大部分时整体替换。
    if (normalizedNeedle.length >= MIN_QUOTE_NEEDLE && normalizedOutput.includes(normalizedNeedle) &&
        normalizedNeedle.length / Math.max(normalizedOutput.length, 1) > 0.8) {
      output = REDACTION_MARK;
    }
  });
  return output.replace(new RegExp(`${REDACTION_MARK}\\s*${REDACTION_MARK}(?:\\s*${REDACTION_MARK})*`, 'g'), REDACTION_MARK).trim();
};

export type ReferenceField = 'definition' | 'memo' | 'example';

export interface WithdrawalReference {
  themeId: string;
  themeName: string;
  field: ReferenceField;
  fieldLabel: string;
  /** 示例条目在 examples 中的下标；定义/备忘录为空字符串。 */
  key: string;
  excerpt: string;
}

/** 撤回前扫描：列出主题定义、备忘录、示例里引用过该访谈原话的位置，交研究者处理。 */
export const findReferences = (state: CodingState, transcriptId: string): WithdrawalReference[] => {
  const texts = state.segments.filter((segment) => segment.transcriptId === transcriptId).map((segment) => segment.text);
  const needles = texts.flatMap(quoteNeedles);
  const hits: WithdrawalReference[] = [];
  if (!needles.length) return hits;
  state.themes.forEach((theme) => {
    const check = (field: ReferenceField, fieldLabel: string, value: string, key: string) => {
      const normalized = normalize(value);
      if (needles.some((needle) => normalized.includes(needle))) {
        hits.push({ themeId: theme.id, themeName: theme.name, field, fieldLabel, key, excerpt: value });
      }
    };
    check('definition', '操作定义', theme.definition, '');
    check('memo', '研究备忘录', theme.memo, '');
    theme.examples.forEach((example, index) => check('example', `典型示例 ${index + 1}`, example, String(index)));
  });
  return hits;
};

/* ------------------------------------------------------------------ */
/* 状态净化：以账本为准，从任意状态快照中清除全部已撤回内容              */
/* ------------------------------------------------------------------ */

export interface SanitizeResult {
  state: CodingState;
  /** 净化过程中在主题文本里发现并替换了原话的主题（用于审计提示）。 */
  scrubbedThemes: string[];
}

export const sanitizeState = (input: CodingState, ledger: Withdrawal[] = readLedger()): SanitizeResult => {
  if (!ledger.length) return { state: input, scrubbedThemes: [] };
  const state: CodingState = structuredClone(input);
  const withdrawnIds = new Set(ledger.map((item) => item.transcriptId));
  const scrubbedThemes: string[] = [];

  // 1. 账本是权威来源：以账本合并状态里的镜像（去重、按时间倒序）。
  const byTranscript = new Map<string, Withdrawal>();
  [...state.withdrawals ?? [], ...ledger].forEach((item) => {
    if (withdrawnIds.has(item.transcriptId) && (!byTranscript.has(item.transcriptId) || byTranscript.get(item.transcriptId)!.withdrawnAt < item.withdrawnAt)) {
      byTranscript.set(item.transcriptId, item);
    }
  });
  state.withdrawals = [...byTranscript.values()].sort((a, b) => b.withdrawnAt.localeCompare(a.withdrawnAt));

  if (!state.segments.some((segment) => withdrawnIds.has(segment.transcriptId)) &&
      !state.transcripts.some((transcript) => withdrawnIds.has(transcript.id))) {
    return { state, scrubbedThemes };
  }

  // 2. 原话与 A/B 判断、片段备忘一并删除。
  state.segments = state.segments.filter((segment) => !withdrawnIds.has(segment.transcriptId));

  // 3. 访谈条目本身删除，只在 withdrawals 中留下不含原文的撤回记录。
  state.transcripts = state.transcripts.filter((transcript) => !withdrawnIds.has(transcript.id));

  // 4. 主题定义 / 备忘录 / 示例中若仍含原话（来自旧标签页、旧撤销栈等），就地清除。
  //    复活的旧状态里同时带着将被删除的片段，用它们的原话作为清理依据。
  const themeNeedles = input.segments
    .filter((segment) => withdrawnIds.has(segment.transcriptId))
    .flatMap((segment) => quoteNeedles(segment.text));
  if (themeNeedles.length) {
    state.themes.forEach((theme: Theme) => {
      const before = JSON.stringify([theme.definition, theme.memo, theme.examples]);
      theme.definition = scrubText(theme.definition, themeNeedles);
      theme.memo = scrubText(theme.memo, themeNeedles);
      theme.examples = theme.examples.map((example) => scrubText(example, themeNeedles)).filter((example) => example !== '');
      if (JSON.stringify([theme.definition, theme.memo, theme.examples]) !== before) scrubbedThemes.push(theme.name);
    });
  }

  // 5. 审计记录里可能内联过原文（导入、编辑片段等动作的详情），逐条剔除含原话的旧条目。
  const auditNeedles = input.segments
    .filter((segment) => withdrawnIds.has(segment.transcriptId))
    .flatMap((segment) => quoteNeedles(segment.text));
  if (auditNeedles.length) {
    state.audit = state.audit.filter((entry) => {
      const normalized = normalize(entry.detail);
      return !auditNeedles.some((needle) => normalized.includes(needle));
    });
  }

  // 6. 活动选择不允许指向已不存在的内容。
  if (state.activeTranscriptId && withdrawnIds.has(state.activeTranscriptId)) {
    state.activeTranscriptId = state.transcripts[0]?.id ?? '';
  }
  if (state.activeSegmentId && !state.segments.some((segment) => segment.id === state.activeSegmentId)) {
    state.activeSegmentId = state.segments.find((segment) => segment.transcriptId === state.activeTranscriptId)?.id ?? '';
  }

  return { state, scrubbedThemes };
};

/** 撤回瞬间在当前状态上执行彻底清除（原文在此时可用，因此主题文本能被精准清理）。 */
export const applyWithdrawal = (
  input: CodingState,
  entry: Withdrawal
): { state: CodingState; scrubbedThemes: string[] } => {
  const state: CodingState = structuredClone(input);
  const removedSegments = state.segments.filter((segment) => segment.transcriptId === entry.transcriptId);
  const needles = removedSegments.flatMap((segment) => quoteNeedles(segment.text));
  const scrubbedThemes: string[] = [];

  state.themes.forEach((theme: Theme) => {
    const before = JSON.stringify([theme.definition, theme.memo, theme.examples]);
    theme.definition = scrubText(theme.definition, needles);
    theme.memo = scrubText(theme.memo, needles);
    theme.examples = theme.examples.map((example) => scrubText(example, needles)).filter((example) => example !== '');
    if (JSON.stringify([theme.definition, theme.memo, theme.examples]) !== before) scrubbedThemes.push(theme.name);
  });

  state.segments = state.segments.filter((segment) => segment.transcriptId !== entry.transcriptId);
  state.transcripts = state.transcripts.filter((transcript) => transcript.id !== entry.transcriptId);
  state.withdrawals = [entry, ...(state.withdrawals ?? []).filter((item) => item.transcriptId !== entry.transcriptId)]
    .sort((a, b) => b.withdrawnAt.localeCompare(a.withdrawnAt));

  // 审计：剔除内联过原话的旧条目，追加撤回记录（详情不含任何原文）。
  state.audit = state.audit.filter((auditEntry) => {
    const normalized = normalize(auditEntry.detail);
    return !needles.some((needle) => normalized.includes(needle));
  });
  state.audit.unshift({
    id: crypto.randomUUID(),
    at: entry.withdrawnAt,
    action: '受访者撤回同意',
    detail: `《${entry.title}》（受访者：${entry.participant}）的 ${entry.segmentCount} 个片段、双编码者判断与引用已按撤回要求清除${scrubbedThemes.length ? `；已同步清理主题文本：${[...new Set(scrubbedThemes)].join('、')}` : ''}`
  });
  state.audit = state.audit.slice(0, 250);

  if (state.activeTranscriptId === entry.transcriptId) {
    state.activeTranscriptId = state.transcripts[0]?.id ?? '';
    state.activeSegmentId = state.segments.find((segment) => segment.transcriptId === state.activeTranscriptId)?.id ?? '';
  }

  return { state, scrubbedThemes };
};

/** 构造不含任何原文的撤回墓碑记录。 */
export const buildWithdrawalEntry = (
  state: CodingState,
  transcriptId: string,
  reason: string,
  writerId: string
): Withdrawal | null => {
  const transcript = state.transcripts.find((item) => item.id === transcriptId);
  if (!transcript) return null;
  const segments = state.segments.filter((segment) => segment.transcriptId === transcriptId);
  return {
    id: `w-${crypto.randomUUID()}`,
    transcriptId,
    title: transcript.title,
    participant: transcript.participant,
    sourceName: transcript.sourceName,
    segmentCount: segments.length,
    codeCount: segments.reduce((count, segment) => count + segment.assignments.A.length + segment.assignments.B.length, 0),
    withdrawnAt: new Date().toISOString(),
    reason: reason.trim(),
    writerId
  };
};
