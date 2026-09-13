import { q } from '../db.js';

const esc = (s = '') =>
  String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log('\n' + text.replace(/<[^>]+>/g, '')); return false; }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) console.warn('telegram failed:', await res.text());
  return res.ok;
}

export async function notify({ threshold = 0.75 } = {}) {
  const { rows } = await q(
    `SELECT id, company, title, location, url, score, verdict
     FROM jobs
     WHERE stage = 'scored' AND notified_at IS NULL AND score >= $1 AND closed_at IS NULL
     ORDER BY score DESC LIMIT 15`,
    [threshold]
  );
  if (!rows.length) return { sent: 0 };

  const lines = rows.map((j) => {
    const v = j.verdict || {};
    return `<b>${esc(j.title)}</b> — ${esc(j.company)}\n` +
           `${(j.score * 100).toFixed(0)}% · ${esc(j.location || 'n/a')}\n` +
           `${esc(v.verdict || '')}\n` +
           (v.gaps?.length ? `gaps: ${esc(v.gaps.slice(0, 2).join('; '))}\n` : '') +
           `<a href="${esc(j.url)}">posting</a> · <code>npm run cli tailor ${j.id}</code>`;
  });

  await telegram(`<b>${rows.length} new match${rows.length > 1 ? 'es' : ''}</b>\n\n${lines.join('\n\n')}`);
  await q(`UPDATE jobs SET notified_at = now() WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
  return { sent: rows.length };
}
