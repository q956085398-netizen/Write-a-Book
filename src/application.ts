import { invoke } from '@tauri-apps/api/core';
import type { ApplicationPort } from './model';

export const application: ApplicationPort = {
  bootstrap: () => invoke('bootstrap'),
  openLibrary: path => invoke('open_library', { path }),
  createWork: title => invoke('create_work', { title }),
  selectWork: id => invoke('select_work', { id }),
  saveChapter: draft => invoke('save_chapter', { draft }),
};
