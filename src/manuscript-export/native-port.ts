import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import type { ExportPort, ExportManifest, ExportReceipt } from './export-port';
export const nativeExportPort: ExportPort = {
  manifest: workId => invoke<ExportManifest>('manuscript_manifest', { workId }),
  chooseTarget: (format, name) => save({ title: '导出书稿', defaultPath: `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.${format}`, filters: [{ name: format === 'docx' ? 'Word 文档' : '纯文本', extensions: [format] }] }),
  export: request => invoke<ExportReceipt>('export_manuscript', { request }),
};
