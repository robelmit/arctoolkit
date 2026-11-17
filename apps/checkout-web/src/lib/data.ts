/** Reads the JSON the checkout server embedded in the page, or null when there is none (the page opened as a file). */
export function pageData<T>(): T | null {
  const element = document.getElementById('arc-data');
  try {
    const value: unknown = JSON.parse(element?.textContent ?? 'null');
    return value !== null && typeof value === 'object' && Object.keys(value).length > 0 ? (value as T) : null;
  } catch {
    return null;
  }
}

/** sessionStorage that never throws: a private window or blocked storage just forgets. */
export const session = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch {
      // Not kept: the merchant enters the key again next time.
    }
  },
};

/** Copies text, true when it worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
