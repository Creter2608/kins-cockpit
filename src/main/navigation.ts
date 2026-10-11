export function isAllowedNavigation(navigationUrl: string, allowedEntryUrl: string): boolean {
  try {
    const target = new URL(navigationUrl);
    const allowed = new URL(allowedEntryUrl);
    return (
      target.protocol === allowed.protocol &&
      target.host === allowed.host &&
      target.pathname === allowed.pathname &&
      target.search === allowed.search
    );
  } catch {
    return false;
  }
}