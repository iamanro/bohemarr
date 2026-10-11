import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import '@picocss/pico';

/** Account providers and the settings each uses, as in .env.example. */
const ACCOUNTS = {
  iprima: ['USERNAME', 'PASSWORD', 'PROFILE', 'DEVICE_ID'],
  oneplay: ['USERNAME', 'PASSWORD', 'ACCOUNT_ID', 'PROFILE', 'PROFILE_PIN'],
  markizavoyo: ['USERNAME', 'PASSWORD', 'COOKIES'],
  jojplay: ['USERNAME', 'PASSWORD'],
  sledovanitv: ['USERNAME', 'PASSWORD', 'DEVICE_ID', 'PROFILE', 'COOKIES'],
  tvbarrandov: ['USERNAME', 'PASSWORD'],
  youtube: ['CLIENT', 'COOKIES', 'PO_TOKEN', 'VISITOR_DATA', 'PLAYER_ID'],
};

function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('apiKey') ?? '');
  const [data, setData] = useState();
  const [changes, setChanges] = useState({});
  const [message, setMessage] = useState();

  const call = async (method, path, body) => {
    const response = await fetch(path, { method, headers: { 'x-api-key': apiKey, ...body && { 'content-type': 'application/json' } }, body: body && JSON.stringify(body) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
    return json;
  };
  const load = () => call('GET', '/v1/settings').then(setData, error => { setMessage({ error: error.message }); setData(); });
  useEffect(() => { if (apiKey) load(); }, [apiKey]);

  if (!data) {
    return (
      <form onSubmit={event => { event.preventDefault(); const key = new FormData(event.target).get('key'); localStorage.setItem('apiKey', key); setApiKey(key); }}>
        <h1>Bohemarr</h1>
        {message && <p><mark>{message.error}</mark></p>}
        <label>API key <input name="key" type="password" required /></label>
        <small>docker compose exec bohemarr cat /config/api-key</small>
        <button>Sign in</button>
      </form>
    );
  }

  const setting = name => data.settings[name];
  const value = name => changes[name] ?? setting(name).value ?? '';
  const change = (name, next) => setChanges({ ...changes, [name]: next });
  const field = (name, label = name, type = 'text') => {
    const { set, source } = setting(name);
    const secret = set && setting(name).value === undefined;
    return (
      <label key={name}>{label}
        <input type={secret || /PASSWORD|API_KEY|PIN|TOKEN|COOKIES/.test(name) ? 'password' : type} value={value(name)} disabled={source === 'env'}
          placeholder={source === 'env' ? 'set in .env' : secret ? 'saved, type to replace' : ''} onInput={event => change(name, event.target.value)} />
      </label>
    );
  };
  const checkbox = (name, label, fallback = 'false') => (
    <label><input type="checkbox" role="switch" checked={['true', '1'].includes(value(name) || fallback)} disabled={setting(name).source === 'env'}
      onChange={event => change(name, String(event.target.checked))} /> {label}</label>
  );
  // Providers not running now are greyed out and marked TBD.
  const idle = id => !data.enabled.includes(id) && { opacity: 0.5 };
  const tbd = id => !data.enabled.includes(id) && ' · TBD';
  const enabled = value('PROVIDERS').split(',').map(id => id.trim()).filter(Boolean);
  const toggle = id => change('PROVIDERS', (enabled.includes(id) ? enabled.filter(other => other !== id) : [...enabled, id]).join(','));
  const save = () => call('PUT', '/v1/settings', changes)
    .then(() => { setChanges({}); setMessage({ text: 'Saved. Restart to apply.' }); return load(); }, error => setMessage({ error: error.message }));
  const restart = () => call('POST', '/v1/restart').then(() => {
    setMessage({ text: 'Restarting…' });
    setTimeout(() => location.reload(), 5000);
  }, error => setMessage({ error: error.message }));
  const url = new URL(data.publicUrl);

  return (
    <>
      <nav><ul><li><strong>Bohemarr</strong></li></ul><ul><li><a href="#" onClick={() => { localStorage.removeItem('apiKey'); location.reload(); }}>Sign out</a></li></ul></nav>

      <article>
        <header><h2>Connect Sonarr and Radarr</h2></header>
        <p>With a URL and API key, Bohemarr adds its indexer, download client, delay profile and root folder at every start. To add them by hand instead:</p>
        <table>
          <tbody>
            <tr><th>Torznab indexer</th><td>URL <code>{data.publicUrl}</code>, API path <code>/api</code>, API key <code style="word-break: break-all">{apiKey}</code></td></tr>
            <tr><th>qBittorrent client</th><td>Host <code>{url.hostname}</code>, port <code>{url.port || (url.protocol === 'https:' ? 443 : 80)}</code>, any username, password = API key, category <code>{data.categories.join(' / ')}</code></td></tr>
          </tbody>
        </table>
        <div class="grid">
          {['SONARR', 'RADARR'].map(app => (
            <fieldset key={app}>
              <legend>{app[0] + app.slice(1).toLowerCase()} {data.arrs[app.toLowerCase()] && (data.arrs[app.toLowerCase()].ok ? '✅' : <mark title={data.arrs[app.toLowerCase()].message}>setup failing</mark>)}</legend>
              {field(`${app}_URL`, 'URL', 'url')}
              {field(`${app}_API_KEY`, 'API key')}
              {field(`${app}_ROOT_FOLDER`, 'Root folder')}
              {field(`${app}_CATEGORY`, 'Category')}
            </fieldset>
          ))}
        </div>
        {checkbox('ARR_RENAME', 'Rename imports with Bohemarr\'s naming formats (overwrites Media Management → naming)')}
        {checkbox('ARR_REMOVE_COMPLETED', 'Move completed downloads into the library and remove them', 'true')}
      </article>

      <article>
        <header><h2>Providers</h2></header>
        <p>{enabled.length ? 'Only the checked providers are enabled.' : 'None checked: every public provider and every account provider with credentials is enabled.'} Now running: {data.enabled.join(', ') || 'none'}.</p>
        <fieldset class="grid" style="grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr))" disabled={setting('PROVIDERS').source === 'env'}>
          {data.providerIds.map(id => <label key={id} style={idle(id)}><input type="checkbox" checked={enabled.includes(id)} onChange={() => toggle(id)} /> {id}{tbd(id)}</label>)}
        </fieldset>
      </article>

      <article>
        <header><h2>Accounts</h2></header>
        {Object.entries(ACCOUNTS).map(([id, fields]) => (
          <details key={id} open={fields.some(name => setting(`${id.toUpperCase()}_${name}`).set)}>
            <summary style={idle(id)}>{id}{tbd(id)}</summary>
            <div class="grid">{fields.map(name => field(`${id.toUpperCase()}_${name}`, name.toLowerCase().replace('_', ' ')))}</div>
          </details>
        ))}
      </article>

      <article>
        <header><h2>Downloads</h2></header>
        <div class="grid">{field('CATEGORIES', 'Categories (comma-separated)')}{field('CONCURRENCY', 'Simultaneous downloads', 'number')}</div>
      </article>

      <footer style="position: sticky; bottom: 0; padding: 1rem 0; background: var(--pico-background-color)">
        {message?.error && <p><mark>{message.error}</mark></p>}
        {message?.text && <p>{message.text}</p>}
        <div role="group">
          <button disabled={!Object.keys(changes).length} onClick={save}>Save</button>
          <button class="secondary" onClick={restart}>Restart to apply</button>
        </div>
      </footer>
    </>
  );
}

render(<App />, document.getElementById('app'));
