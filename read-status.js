/* 既読の状態管理と、記事末尾の既読ボタン。目次と全記事が読み込む。
   端末内は localStorage の ra_read に、目次の url と同じ形（./カテゴリ/記事/）で持つ。
   同期キーを入れた端末は /api/read-state 経由で Notion と同期する。キーが無ければ端末内だけで動く。
   ra_read_pending は、まだサーバーへ送れていない変更（送れたら消す）。 */
window.RARead = (function () {
  var KEY = 'ra_read', SYNC_KEY = 'ra_sync_key', PENDING = 'ra_read_pending', API = '/api/read-state';
  var listeners = [], status = 'off', lastPull = 0;

  function get(k) {
    try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; }
  }
  function set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function syncKey() {
    try { return localStorage.getItem(SYNC_KEY) || ''; } catch (e) { return ''; }
  }
  function notify() {
    listeners.forEach(function (fn) { fn(); });
  }
  function setStatus(s) {
    if (s !== status) { status = s; notify(); }
  }

  function call(method, body, key) {
    return fetch(API, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'x-sync-key': key || syncKey() },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  function flush() {
    var sent = get(PENDING), ids = Object.keys(sent);
    if (!ids.length) return Promise.resolve();
    return call('POST', { items: sent }).then(function () {
      var now = get(PENDING);
      ids.forEach(function (id) { if (now[id] === sent[id]) delete now[id]; });
      set(PENDING, now);
    });
  }

  function pull() {
    if (!syncKey()) { setStatus('off'); return Promise.resolve(); }
    lastPull = Date.now();
    return flush().then(function () { return call('GET'); }).then(function (data) {
      var read = data.read || {}, pending = get(PENDING);
      Object.keys(pending).forEach(function (id) {
        if (pending[id]) read[id] = 1; else delete read[id];
      });
      var changed = JSON.stringify(sortKeys(read)) !== JSON.stringify(sortKeys(get(KEY)));
      if (changed) set(KEY, read);
      status = 'on';
      notify();
    }).catch(function () { setStatus('error'); });
  }

  function sortKeys(map) {
    return Object.keys(map).sort();
  }

  function toggle(id) {
    var map = get(KEY), next = !map[id];
    if (next) map[id] = 1; else delete map[id];
    set(KEY, map);
    if (syncKey()) {
      var pending = get(PENDING);
      pending[id] = next;
      set(PENDING, pending);
      flush().then(function () { setStatus('on'); }).catch(function () { setStatus('error'); });
    }
    notify();
  }

  /* 端末を同期につなぐ。この端末の既読はサーバーへ足す。キーが違えば保存しない */
  function connect(key) {
    return call('GET', null, key).then(function () {
      try { localStorage.setItem(SYNC_KEY, key); } catch (e) {}
      var pending = get(PENDING);
      Object.keys(get(KEY)).forEach(function (id) { pending[id] = true; });
      set(PENDING, pending);
      return pull();
    });
  }

  function disconnect() {
    try { localStorage.removeItem(SYNC_KEY); localStorage.removeItem(PENDING); } catch (e) {}
    setStatus('off');
  }

  window.addEventListener('storage', function (e) {
    if (e.key === KEY || e.key === null) notify();
    if (e.key === SYNC_KEY) setStatus(syncKey() ? 'on' : 'off');
  });

  /* 枠の中の記事は親の目次が同期するので、取りに行くのは最上位のページだけ */
  if (window.self === window.top) {
    var refresh = function () { if (Date.now() - lastPull > 10000) pull(); };
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', function (e) { if (e.persisted) { notify(); refresh(); } });
    pull();
  }

  return {
    isRead: function (id) { return !!get(KEY)[id]; },
    toggle: toggle,
    connect: connect,
    disconnect: disconnect,
    status: function () { return status; },
    onChange: function (fn) { listeners.push(fn); },
  };
})();

/* ---- 記事末尾のボタン（/カテゴリ/記事/ のページだけ） ---- */
(function () {
  var path = location.pathname.replace(/index\.html$/, '').replace(/\/?$/, '/');
  if (!/^\/[^/]+\/[^/]+\/$/.test(path)) return;
  var id = '.' + path;

  var style = document.createElement('style');
  style.textContent =
    '.rs-end{padding:40px 24px 56px;text-align:center;font-size:14px;color:var(--muted);}' +
    '.rs-btn{appearance:none;border:0;background:none;padding:12px 8px;font:inherit;color:var(--ink);cursor:pointer;' +
    'text-decoration:underline;text-underline-offset:4px;}' +
    '.rs-btn:hover{color:var(--ink-soft);}' +
    '.rs-btn:focus-visible{outline:1px solid var(--ink);outline-offset:2px;}';
  document.head.appendChild(style);

  var box = document.createElement('div');
  box.className = 'rs-end';
  var state = document.createElement('span');
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rs-btn';
  box.appendChild(state);
  box.appendChild(btn);

  function render() {
    var read = window.RARead.isRead(id);
    state.textContent = read ? 'この記事は既読です' : '';
    btn.textContent = read ? '未読に戻す' : '既読にする';
  }

  btn.addEventListener('click', function () { window.RARead.toggle(id); });
  window.RARead.onChange(render);

  var sections = document.querySelectorAll('body > section, body > main > section');
  if (sections.length) sections[sections.length - 1].after(box);
  else document.body.appendChild(box);
  render();
})();
