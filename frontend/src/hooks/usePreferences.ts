// UI preferences (theme, language). Stored in localStorage as a per-browser
// convenience; every access is guarded because storage can be unavailable
// (private windows, blocked site data).

import { create } from 'zustand';

export type Language = 'en' | 'ar';
export type ThemeMode = 'light' | 'dark';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* preference simply not remembered */ }
}

interface Preferences {
  language: Language;
  theme: ThemeMode;
  setLanguage: (l: Language) => void;
  setTheme: (t: ThemeMode) => void;
}

export const usePreferences = create<Preferences>()((set) => ({
  language: read('aigh-lang') === 'ar' ? 'ar' : 'en',
  theme: read('aigh-theme') === 'dark' ? 'dark' : 'light',
  setLanguage: (language) => { write('aigh-lang', language); set({ language }); },
  setTheme: (theme) => { write('aigh-theme', theme); set({ theme }); },
}));
