export function devFixtureRequested(
  development: boolean,
  search: string,
): boolean {
  return devFixtureKind(development, search) === 'docx';
}

export function devFixtureKind(
  development: boolean,
  search: string,
): 'docx' | 'pdf' | undefined {
  if (!development) return undefined;
  const value = new URLSearchParams(search).get('browser-fixture');
  if (value === 'standard') return 'docx';
  if (value === 'pdf') return 'pdf';
  return undefined;
}
