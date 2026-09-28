const STATUS = {
  overdue: { key: 'overdue', label: 'Overdue', fg: '#B23B2E', bg: '#F7E2DE' },
  critical: { key: 'critical', label: 'Due soon', fg: '#9C5A17', bg: '#F6E4CB' },
  warning: { key: 'warning', label: 'Upcoming', fg: '#8A7412', bg: '#F2ECC9' },
  ok: { key: 'ok', label: 'Active', fg: '#3F6B4F', bg: '#DEEBE1' },
};

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function computeStatus(expiryStr, today = startOfToday()) {
  if (!expiryStr) return { daysLeft: 9999, ...STATUS.ok };
  const expiry = new Date(expiryStr + 'T00:00:00');
  const daysLeft = Math.round((expiry - today) / 86400000);
  let key = 'ok';
  if (daysLeft < 0) key = 'overdue';
  else if (daysLeft <= 14) key = 'critical';
  else if (daysLeft <= 30) key = 'warning';
  return { daysLeft, ...STATUS[key] };
}

module.exports = { STATUS, computeStatus, startOfToday };
