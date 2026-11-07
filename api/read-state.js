/**
 * 既読の同期 API（Vercel の関数）。既読の記事ごとに Notion の DB へ1行持つ。
 *
 * GET  /api/read-state                     → { read: { "./カテゴリ/記事/": 1, ... } }
 * POST /api/read-state { items: { "./カテゴリ/記事/": true|false, ... } }
 * どちらもヘッダー x-sync-key が必要。
 *
 * 環境変数（Vercel の設定画面で入れる。コードには書かない）：NOTION_TOKEN / READ_DB_ID / READ_SYNC_KEY
 */
const crypto = require('crypto');

const NOTION = 'https://api.notion.com/v1';
const TITLE_PROP = 'Article';
const ARTICLE_ID = /^\.\/[a-z0-9-]+\/[a-z0-9-]+\/$/;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sameKey(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

async function notion(token, path, method, body) {
  const r = await fetch(NOTION + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error('Notion ' + r.status);
  return r.json();
}

/* DB の全行を { 記事: [ページID, ...] } で返す。同じ記事が2行あっても扱えるよう配列で持つ */
async function loadRows(token, dbId) {
  const rows = {};
  let cursor;
  do {
    const page = await notion(token, '/databases/' + dbId + '/query', 'POST', cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 });
    page.results.forEach((p) => {
      const id = (p.properties[TITLE_PROP].title[0] || {}).plain_text;
      if (id) (rows[id] = rows[id] || []).push(p.id);
    });
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return rows;
}

module.exports = async (req, res) => {
  const { NOTION_TOKEN, READ_DB_ID, READ_SYNC_KEY } = process.env;
  if (!NOTION_TOKEN || !READ_DB_ID || !READ_SYNC_KEY) return send(res, 503, { error: 'not configured' });
  if (!sameKey(req.headers['x-sync-key'] || '', READ_SYNC_KEY)) return send(res, 401, { error: 'bad key' });

  try {
    const rows = await loadRows(NOTION_TOKEN, READ_DB_ID);

    if (req.method === 'GET') {
      const read = {};
      Object.keys(rows).forEach((id) => { read[id] = 1; });
      return send(res, 200, { read });
    }

    if (req.method === 'POST') {
      const items = (req.body && req.body.items) || {};
      const ids = Object.keys(items);
      if (ids.length > 500 || !ids.every((id) => ARTICLE_ID.test(id))) return send(res, 400, { error: 'bad items' });
      for (const id of ids) {
        if (items[id] && !rows[id]) {
          await notion(NOTION_TOKEN, '/pages', 'POST', {
            parent: { database_id: READ_DB_ID },
            properties: { [TITLE_PROP]: { title: [{ text: { content: id } }] } },
          });
        } else if (!items[id] && rows[id]) {
          for (const pageId of rows[id]) await notion(NOTION_TOKEN, '/pages/' + pageId, 'PATCH', { archived: true });
        }
      }
      return send(res, 200, { ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    return send(res, 502, { error: 'storage failed' });
  }
};
