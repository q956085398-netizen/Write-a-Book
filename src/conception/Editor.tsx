import { RichEditor } from '../RichEditor';
import type { Chapter } from '../model';
import type { EditorSession } from '../editor-session';
import type { ConceptionPort } from './types';

// Both content types use the same format, image tasks and composition barriers.
export function ConceptionEditor(props: { port: ConceptionPort; chapter: Chapter; session: EditorSession; disabled: boolean; label?: string }) {
  return <RichEditor chapter={props.chapter} session={props.session} disabled={props.disabled} label={props.label ?? '构思内容'} editorId="conception-body" imagePort={props.port}/>;
}
