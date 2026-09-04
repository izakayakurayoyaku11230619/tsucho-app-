const API_KEY_STORAGE = 'tsucho-app:gemini-api-key';

export function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE) || '';
}

export function setApiKey(key) {
  if (key) localStorage.setItem(API_KEY_STORAGE, key);
  else localStorage.removeItem(API_KEY_STORAGE);
}

export function hasApiKey() {
  return getApiKey().length > 0;
}
