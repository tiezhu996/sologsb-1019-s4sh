import type { CodingState, Segment, Theme, WithdrawalRecord, WithdrawnReferenceLocation } from '../types';

/** 抹除后留下的占位，不含任何可还原的原文信息 */
export const REDACTION_MARK = '［已撤回原话］';
/** 原话匹配的最小长度，过短的短语不视为引用，避免误伤 */
const MIN_NEEDLE = 6;
const NEEDLE_PUNCT = new Set(['。', '！', '？', '；', '，', '.', '!', '?', ';', ',', '\n', '\r']);

/** 归一化：忽略空白与全部标点（中英逗号、句号、引号、括号等）后比较，不改变语义 */
const isContentChar = (char: string) => {
  if (/\s/.test(char)) return false;
  if (/[a-z0-9]/i.test(char)) return true;
  // CJK 统一表意文字及扩展 A；其余视为标点或符号并忽略
  return /[一-鿿㐀-䶿]/.test(char);
};

const normalizeChar = (char: string) => (isContentChar(char) ? char.toLowerCase() : '');

export const normalizeText = (text: string): string => Array.from(text, normalizeChar).join('');

/** 从被撤回片段中提取可用于识别“引用原话”的语句片段 */
export const collectNeedles = (segments: Segment[]): string[] => {
  const needles = new Set<string>();
  segments.forEach((segment) => {
    const text = segment.text.trim();
    if (!text) return;
    let buffer = '';
    const push = () => {
      const normalized = normalizeText(buffer);
      if (Array.from(normalized).length >= MIN_NEEDLE) needles.add(normalized);
      buffer = '';
    };
    for (const char of text) {
      if (NEEDLE_PUNCT.has(char)) push();
      else buffer += char;
    }
    push();
    // 整句也加入，覆盖未加标点直接粘贴的引用
    const whole = normalizeText(text);
    if (Array.from(whole).length >= MIN_NEEDLE) needles.add(whole);
  });
  return [...needles].sort((a, b) => b.length - a.length);
};

interface Range {
  start: number;
  end: number;
}

/** 在原文坐标中找出所有被引用原话覆盖的区间（needles 已归一化） */
export const findRedactionRanges = (rawText: string, needles: string[]): Range[] => {
  const chars = Array.from(rawText);
  const normalized: string[] = [];
  const origin: number[] = [];
  chars.forEach((char, index) => {
    const mapped = normalizeChar(char);
    if (mapped) {
      normalized.push(mapped);
      origin.push(index);
    }
  });
  const haystack = normalized.join('');
  const ranges: Range[] = [];
  needles.forEach((needle) => {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      ranges.push({ start: origin[at], end: origin[at + needle.length - 1] + 1 });
      from = at + needle.length;
    }
  });
  if (!ranges.length) return [];
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  ranges.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  });
  return merged;
};

export const redactText = (text: string, ranges: Range[]): string => {
  if (!ranges.length) return text;
  const chars = Array.from(text);
  let result = '';
  let cursor = 0;
  ranges.forEach((range) => {
    result += chars.slice(cursor, range.start).join('') + REDACTION_MARK;
    cursor = range.end;
  });
  result += chars.slice(cursor).join('');
  return result;
};

/** 文本中命中的原话数量（重复引用分别计数） */
export const countMatches = (text: string, needles: string[]): number =>
  findRedactionRanges(text, needles).length;

const FIELD_LABELS: Record<'definition' | 'memo' | 'example', string> = {
  definition: '操作定义',
  memo: '研究备忘录',
  example: '典型示例'
};

/** 扫描主题定义、备忘录与示例，定位引用了被撤回原话的位置 */
export const scanReferences = (themes: Theme[], needles: string[]): WithdrawnReferenceLocation[] => {
  const found: WithdrawnReferenceLocation[] = [];
  themes.forEach((theme) => {
    (['definition', 'memo'] as const).forEach((field) => {
      const matchedCount = countMatches(theme[field], needles);
      if (matchedCount) found.push({ themeId: theme.id, themeName: theme.name, field, fieldLabel: FIELD_LABELS[field], matchedCount, action: 'redacted' });
    });
    theme.examples.forEach((example, exampleIndex) => {
      const matchedCount = countMatches(example, needles);
      if (matchedCount) found.push({ themeId: theme.id, themeName: theme.name, field: 'example', fieldLabel: FIELD_LABELS.example, exampleIndex, matchedCount, action: 'redacted' });
    });
  });
  return found;
};

/** 按位置清单抹除主题文本里的原话；manual 表示研究者已自行处理，系统不改写 */
export const applyReferenceRedactions = (state: CodingState, locations: WithdrawnReferenceLocation[], needles: string[]) => {
  const keyOf = (location: WithdrawnReferenceLocation) =>
    `${location.themeId}:${location.field}:${location.exampleIndex ?? -1}`;
  const manual = new Set(locations.filter((location) => location.action === 'manual').map(keyOf));
  const redact = new Set(locations.filter((location) => location.action === 'redacted').map(keyOf));
  state.themes.forEach((theme) => {
    (['definition', 'memo'] as const).forEach((field) => {
      const key = `${theme.id}:${field}:-1`;
      if (redact.has(key)) {
        const ranges = findRedactionRanges(theme[field], needles);
        if (ranges.length) theme[field] = redactText(theme[field], ranges);
      } else if (manual.has(key)) {
        // 研究者承诺自行改写，系统不保留原话也不自动改动
      }
    });
    theme.examples = theme.examples.map((example, exampleIndex) => {
      const key = `${theme.id}:example:${exampleIndex}`;
      if (!redact.has(key)) return example;
      const ranges = findRedactionRanges(example, needles);
      return ranges.length ? redactText(example, ranges) : example;
    });
  });
};

/** 清洗审计记录中残留的原话：对每条记录再扫描一遍，命中即整体替换为占位说明 */
export const scrubAuditTrail = (state: CodingState, needles: string[]): number => {
  let count = 0;
  state.audit = state.audit.map((entry) => {
    const ranges = findRedactionRanges(`${entry.action} ${entry.detail}`, needles);
    if (!ranges.length) return entry;
    count += 1;
    return { ...entry, action: '撤回清洗', detail: '本条记录含被撤回访谈的原话，已随同意撤回一并抹除' };
  });
  return count;
};

const mergeRecord = (target: WithdrawalRecord[], incoming: WithdrawalRecord): WithdrawalRecord[] => {
  const existing = target.find((record) => record.id === incoming.id || record.transcriptId === incoming.transcriptId);
  if (existing) {
    // 保留信息更完整的一份（按引用处理结果与导出清除数量比较）
    const richer = (incoming.references.length + incoming.purgedExports.length)
      > (existing.references.length + existing.purgedExports.length) ? incoming : existing;
    return target.map((record) => (record === existing ? richer : record));
  }
  return [incoming, ...target];
};

/**
 * 将一次撤回墓碑应用到任意状态：删除对应访谈、片段、A/B 判断，
 * 确定性抹除主题文本与审计中的原话，清理对应导出记录。
 * 返回是否发生了实际变更。
 */
export const applyTombstoneToState = (state: CodingState, record: WithdrawalRecord): boolean => {
  state.withdrawals = Array.isArray(state.withdrawals) ? state.withdrawals : [];
  state.exportLogs = Array.isArray(state.exportLogs) ? state.exportLogs : [];
  const hadRecord = state.withdrawals.some((item) => item.id === record.id || item.transcriptId === record.transcriptId);

  const beforeSegments = state.segments.length;
  const removed = state.segments.filter((segment) => segment.transcriptId === record.transcriptId);
  if (removed.length || state.transcripts.some((item) => item.id === record.transcriptId)) {
    const needles = collectNeedles(removed);
    // 确定性二次抹除：即使旧状态的主题文本里仍含原话，也在此清除
    const locations = scanReferences(state.themes, needles).map((location) => ({ ...location, action: 'redacted' as const }));
    if (locations.length) applyReferenceRedactions(state, locations, needles);
    scrubAuditTrail(state, needles);
    state.segments = state.segments.filter((segment) => segment.transcriptId !== record.transcriptId);
    state.transcripts = state.transcripts.filter((item) => item.id !== record.transcriptId);
    state.exportLogs = state.exportLogs.filter((log) => !log.transcriptIds.includes(record.transcriptId));
  }

  state.withdrawals = mergeRecord(state.withdrawals, record);

  if (state.activeTranscriptId === record.transcriptId) {
    state.activeTranscriptId = state.transcripts[0]?.id ?? '';
    const first = state.segments.find((segment) => segment.transcriptId === state.activeTranscriptId);
    state.activeSegmentId = first?.id ?? '';
  }
  if (!state.segments.some((segment) => segment.id === state.activeSegmentId)) state.activeSegmentId = '';

  return beforeSegments !== state.segments.length || !hadRecord;
};

/** 把一组墓碑应用到状态，返回本次新生效的记录数 */
export const reconcileWithdrawals = (state: CodingState, records: WithdrawalRecord[]): number => {
  const knownIds = new Set(state.withdrawals.map((record) => record.id));
  let applied = 0;
  records.forEach((record) => {
    const changed = applyTombstoneToState(state, record);
    if (changed || !knownIds.has(record.id)) applied += 1;
  });
  return applied;
};

/** 兜底：清除已不在任何片段中出现的失效主题引用 */
export const pruneDanglingAssignments = (state: CodingState) => {
  const themeIds = new Set(state.themes.map((theme) => theme.id));
  state.segments.forEach((segment) => {
    segment.assignments.A = segment.assignments.A.filter((id) => themeIds.has(id));
    segment.assignments.B = segment.assignments.B.filter((id) => themeIds.has(id));
  });
};
