import { invoke } from '@tauri-apps/api/core';
import type { ApiProfilesPort } from './api-profiles-model';

export const apiProfiles: ApiProfilesPort = {
  list: () => invoke('api_list_profiles'),
  save: draft => invoke('api_save_profile', { draft }),
  test: draft => invoke('api_test_connection', { draft }),
};
