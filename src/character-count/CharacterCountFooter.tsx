import { countingRule, type DisplayCharacterCounts, type EditorCharacterCounts } from './index';

// Plain footer text, independent of optional goals, timers and progress records.
export function CharacterCountFooter({ counts, live, kind }: { counts: DisplayCharacterCounts | null; live: EditorCharacterCounts | null; kind: 'chapter' | 'fragment' }) {
  return <span title={countingRule} aria-label="字数（含标点）">字数（含标点） · {live ? `选区 ${live.selection} · 当前${kind === 'chapter' ? '章节' : '片段'} ${live.current}` : '当前统计暂不可用'} · {counts
    ? `全书章节 ${counts.chapters} · 未编章片段 ${counts.fragments}`
    : '全书章节 暂不可用 · 未编章片段 暂不可用'}</span>;
}
