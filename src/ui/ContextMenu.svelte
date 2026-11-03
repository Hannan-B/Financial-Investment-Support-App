<script lang="ts">
  /** A small menu at the pointer, as a right-click menu is. Escape, scrolling or a click elsewhere closes it. */
  interface Item { readonly label: string; readonly run: () => void }
  let { x, y, items, onClose }: { x: number; y: number; items: readonly Item[]; onClose: () => void } = $props();

  let menu = $state<HTMLElement>();
  $effect(() => {
    const away = (e: Event) => { if (!menu?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    window.addEventListener('scroll', onClose, true);
    menu?.querySelector('button')?.focus();
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('scroll', onClose, true);
    };
  });
</script>

<div class="menu" role="menu" bind:this={menu}
  style:left="{Math.max(8, Math.min(x, window.innerWidth - 300))}px" style:top="{Math.max(8, Math.min(y, window.innerHeight - items.length * 34 - 16))}px">
  {#each items as it (it.label)}
    <button role="menuitem" onclick={() => { it.run(); onClose(); }}>{it.label}</button>
  {/each}
</div>

<style>
  .menu { position: fixed; z-index: 20; min-width: 200px; max-width: 290px; background: var(--surface); border: 1px solid var(--line);
    border-radius: 8px; padding: 4px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.15); display: grid; }
  button { border: 0; background: none; color: var(--text); text-align: left; padding: 6px 10px; border-radius: 5px; font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button:hover, button:focus-visible { background: var(--accent-soft); color: var(--accent); outline: none; }
</style>
