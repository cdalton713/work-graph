/** The screen of a page with a sign-in, before the session: one link that starts the sign-in and comes back here. */
export function SignIn() {
  const next = encodeURIComponent(location.pathname + location.search);
  return (
    <div className="app">
      <header className="bar"><span className="brand">work-graph</span></header>
      <main className="stage">
        <div className="blank signin">
          <p>Sign in to view this page.</p>
          <a className="signin-go" href={`/auth/login?next=${next}`}>Sign in with Google</a>
        </div>
      </main>
    </div>
  );
}
