import { getStoredAdminApiKey } from './adminApiKey';
import { supabase } from './supabase';

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

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

  const resp = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers
  });

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
