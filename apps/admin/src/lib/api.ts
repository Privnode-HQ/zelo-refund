import { getStoredAdminApiKey } from './adminApiKey';
import { supabase } from './supabase';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

const fetchJson = async <T = any>(url: string, init?: RequestInit): Promise<T> => {
  const resp = await fetch(url, init);

  const text = await resp.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!resp.ok) {
    const message =
      (json && typeof json === 'object' && json !== null && ('message' in json || 'error' in json)
        ? (json as any).message || (json as any).error
        : null) ?? `HTTP ${resp.status}`;
    throw new Error(String(message));
  }
  return json as T;
};

export const apiFetch = async <T = any>(path: string, init?: RequestInit): Promise<T> => {
  const token = await (async () => {
    const apiKey = getStoredAdminApiKey();
    if (apiKey) return apiKey;

    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  })().catch(() => null);

  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  return fetchJson<T>(`${apiBaseUrl}${path}`, {
    ...init,
    headers
  });
};

export const publicApiFetch = async <T = any>(path: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers);
  headers.set('content-type', 'application/json');

  return fetchJson<T>(`${apiBaseUrl}${path}`, {
    ...init,
    headers
  });
};
