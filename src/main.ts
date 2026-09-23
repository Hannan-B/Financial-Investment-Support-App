/**
 * Frontend entry point. Inside the app, the real backend; in an ordinary
 * browser (`npm run demo`), a replayed demo portfolio.
 */
import { mount } from 'svelte';
import App from './ui/App.svelte';
import { isTauri } from './ui/backend.ts';
import { tauriBackend } from './ui/tauri-backend.ts';
import { demoBackend } from './ui/demo-backend.ts';

mount(App, {
  target: document.querySelector('#app')!,
  props: { backend: isTauri() ? tauriBackend() : demoBackend() },
});
