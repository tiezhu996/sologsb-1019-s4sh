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

/**
 * 撤回同意记录（“墓碑”）。
 * 不保存任何原文、片段或编码判断，仅保留证明撤回已发生所需的元数据。
 */
export interface Withdrawal {
  id: string;
  transcriptId: string;
  title: string;
  participant: string;
  sourceName: string;
  segmentCount: number;
  codeCount: number;
  withdrawnAt: string;
  reason: string;
  writerId: string;
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
  /** 撤回账本的镜像，真实账本独立持久化，任何状态写入都会以账本为准重新净化。 */
  withdrawals: Withdrawal[];
  audit: Array<{ id: string; at: string; action: string; detail: string }>;
}

export interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  writerId: string;
  state: CodingState;
}

/** 撤回前的本地检查点，仅在撤回写入失败期间保留，成功清除后立即删除。 */
export interface WithdrawalCheckpoint {
  id: string;
  transcriptId: string;
  title: string;
  participant: string;
  createdAt: string;
  state: CodingState;
}

/** 多标签页广播消息：状态快照 / 撤回墓碑 / 撤回前检查点回滚。 */
export type ChannelMessage =
  | ({ kind: 'snapshot' } & PersistedEnvelope)
  | { kind: 'withdrawal'; withdrawal: Withdrawal; writerId: string; at: string }
  | { kind: 'rollback'; transcriptId: string; writerId: string; at: string };
