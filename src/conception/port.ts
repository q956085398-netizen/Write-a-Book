import { invoke } from '@tauri-apps/api/core';
import type { ConceptionPort } from './types';
// Registered by the App integration; this module does not touch the chapter API.
export const conceptionPort: ConceptionPort = {
  view: workId => invoke('conception_view', { workId }),
  defaults: () => invoke('conception_defaults'),
  changeDefaults: (expectedRevision, sections) => invoke('change_conception_defaults', { expectedRevision, sections }),
  changeSections: (workId, expectedRevision, sections) => invoke('change_conception_sections', { workId, expectedRevision, sections }),
  create: (workId, sectionId) => invoke('create_conception', { workId, sectionId }),
  reference: (workId, recordId, sectionId) => invoke('reference_conception', { workId, recordId, sectionId }),
  save: draft => invoke('save_conception', { draft }),
  checkpoint: snapshot => invoke('checkpoint_conception', { snapshot }),
  acknowledge: (sessionId, contentId, sequence) => invoke('acknowledge_conception_recovery', { sessionId, contentId, sequence }),
  listRecovery: workId => invoke('list_conception_recovery', { workId }),
  recover: (id, sequence, asCopy) => invoke('recover_conception', { id, sequence, asCopy }),
  importImage: (contentId, name, bytes) => invoke('import_image', { contentId, name, bytes }),
  readImage: (contentId, id) => invoke('read_image', { contentId, id }),
};
