export const SOURCE_LABEL = { hongguo: '红果', xifan: '西饭', hema: '河马' };

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = n => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + pad(m) + ':' + pad(s % 60) : pad(m) + ':' + pad(s % 60);
}

export function timeAgo(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + ' 天前';
  const d = new Date(Number(ts));
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

export function errorMessage(error, fallback) {
  const msg = error && (error.message || String(error));
  return msg || fallback || '出了点问题，请重试';
}
