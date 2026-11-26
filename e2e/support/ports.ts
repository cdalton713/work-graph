function fixtureUrl(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`Fixture server did not provide ${name}`);
  return url;
}

export const pageUrl = () => fixtureUrl("WG_E2E_PAGE_URL");
export const serviceUrl = () => fixtureUrl("WG_E2E_SERVICE_URL");
