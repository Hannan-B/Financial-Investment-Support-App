<script lang="ts">
  /**
   * First run: connect Trading 212 with a READ-ONLY key (§12.9).
   * The key goes straight to the macOS keychain and can never be read back.
   */
  let { save, cancel }: {
    save: (key: string, secret: string) => Promise<void>;
    /** Present when there is stored data to go back to. */
    cancel?: (() => void) | undefined;
  } = $props();

  let key = $state('');
  let secret = $state('');
  let error = $state('');
  let saving = $state(false);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    saving = true;
    try {
      await save(key, secret);
      key = '';
      secret = '';
    } catch (err) {
      error = String(err);
    } finally {
      saving = false;
    }
  }
</script>

<section class="setup">
  <h2>Connect Trading 212</h2>
  <p>The app reads your holdings from Trading 212. It needs an API key that can <strong>only read</strong>.</p>

  <ol>
    <li>In the Trading 212 app, go to <em>Settings → API</em> and generate a new key.</li>
    <li>Grant <strong>account data</strong> and <strong>portfolio</strong> access. Leave <strong>orders</strong> unticked — then
      Trading 212 itself will refuse any trade, whatever this app does.</li>
    <li>Turn on <strong>IP restriction</strong> for your home connection, so the key is useless anywhere else.</li>
    <li>Copy the key and the secret below. The secret is shown only once.</li>
  </ol>

  <form onsubmit={submit}>
    <label>API key <input bind:value={key} autocomplete="off" spellcheck="false" required /></label>
    <label>Secret <input bind:value={secret} type="password" autocomplete="off" required /></label>
    <div class="buttons">
      <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save to keychain'}</button>
      {#if cancel}<button type="button" class="secondary" onclick={cancel}>Cancel</button>{/if}
    </div>
  </form>
  {#if error}<p class="error">{error}</p>{/if}

  <p class="muted small">Stored in the macOS keychain, not in any file. The app cannot show it again — only replace or remove it.</p>
</section>

<style>
  .setup { max-width: 560px; margin: 48px auto; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 28px 32px; }
  h2 { margin-bottom: 8px; }
  ol { padding-left: 20px; }
  li { margin: 6px 0; }
  form { display: grid; gap: 12px; margin: 20px 0 12px; }
  label { display: grid; gap: 4px; font-weight: 500; }
  input { padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); }
  .buttons { display: flex; gap: 8px; }
  .secondary { background: none; border: 1px solid var(--line); color: var(--text); }
  button { padding: 8px 16px; border: 0; border-radius: 6px; background: var(--accent); color: var(--surface); }
  button:disabled { opacity: 0.6; cursor: default; }
  .error { color: var(--bad); }
</style>
