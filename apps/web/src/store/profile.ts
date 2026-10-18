/** The learner's name and picture, kept in this browser. No account, no server. */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ProfileState {
  displayName: string;
  avatarUrl: string;
  setProfile: (patch: Partial<Pick<ProfileState, 'displayName' | 'avatarUrl'>>) => void;
}

export const useProfile = create<ProfileState>()(
  persist(
    (set) => ({
      displayName: '',
      avatarUrl: '',
      setProfile: (patch) => set(patch),
    }),
    { name: 'cslab-profile-v1', partialize: (s) => ({ displayName: s.displayName, avatarUrl: s.avatarUrl }) as ProfileState },
  ),
);
