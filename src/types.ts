export type CoderId = 'A' | 'B';

export interface Theme {
  id: string;
  name: string;
  parentId: string | null;
  color: string;
  definition: string;
  memo: string;
  examples: string[];
}

export interface Segment {
  id: string;
  transcriptId: string;
  order: number;
  speaker: string;
  time: string;
  text: string;
  assignments: Record<CoderId, string[]>;
  note: string;
}

export interface Transcript {
  id: string;
  title: string;
  participant: string;
  importedAt: string;
  sourceName: string;
}

/** 主题定义、备忘录或示例中引用了被撤回原话的位置 */
export interface WithdrawnReferenceLocation {
  themeId: string;
  themeName: string;
  field: 'definition' | 'memo' | 'example';
  fieldLabel: string;
  exampleIndex?: number;
  /** 撤回时在该位置检测到的原话片段数量 */
  matchedCount: number;
  /** redacted=系统已抹除原话；manual=研究者自行改写 */
  action: 'redacted' | 'manual';
}

/** 工作台内导出文件的记录（不含原文时仅保留元数据） */
export interface ExportLogEntry {
  id: string;
  at: string;
  format: 'json' | 'csv';
  transcriptIds: string[];
  /** 随某次撤回一并清除时，记录对应撤回编号 */
  removedWithWithdrawal?: string;
}

/** 撤回同意后仅保留的处理记录，不含任何访谈原文 */
export interface WithdrawalRecord {
  id: string;
  transcriptId: string;
  transcriptTitle: string;
  participantLabel: string;
  sourceName: string;
  importedAt: string;
  requestedAt: string;
  completedAt: string;
  segmentCount: number;
  /** 一并删除的 A/B 判断总数 */
  codingCount: number;
  assignmentThemeIds: string[];
  references: WithdrawnReferenceLocation[];
  purgedExports: ExportLogEntry[];
  scrubbedAuditCount: number;
  note: string;
}

export interface CodingState {
  revision: number;
  updatedAt: string;
  activeTranscriptId: string;
  activeSegmentId: string;
  activeThemeId: string;
  coderA: string;
  coderB: string;
  transcripts: Transcript[];
  segments: Segment[];
  themes: Theme[];
  audit: Array<{ id: string; at: string; action: string; detail: string }>;
  withdrawals: WithdrawalRecord[];
  exportLogs: ExportLogEntry[];
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}

/** 撤回写入失败前保存的本地检查点，仅用于恢复，成功后立即删除 */
export interface WithdrawCheckpoint {
  id: string;
  transcriptId: string;
  at: string;
  state: CodingState;
}

export type ChannelMessage =
  | { kind: 'envelope'; envelope: PersistedEnvelope }
  | { kind: 'withdrawal'; record: WithdrawalRecord };
