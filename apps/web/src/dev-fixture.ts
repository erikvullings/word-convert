export function devFixtureRequested(
  development: boolean,
  search: string,
): boolean {
  return (
    development &&
    new URLSearchParams(search).get('browser-fixture') === 'standard'
  );
}
