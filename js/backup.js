import { getTsuchoRecords, saveTsuchoRecords } from './storage.js';

export function exportBackup() {
  const data = { version: 1, exportedAt: new Date().toISOString(), tsuchoRecords: getTsuchoRecords() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tsucho-app-backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function importBackup(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const records = data.tsuchoRecords || [];
  saveTsuchoRecords(records);
  return { count: records.length };
}
