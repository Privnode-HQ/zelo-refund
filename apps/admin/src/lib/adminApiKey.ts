const STORAGE_KEY = 'zelo_admin_api_key';

export const getStoredAdminApiKey = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

export const setStoredAdminApiKey = (value: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
  }
};

export const clearStoredAdminApiKey = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
};
