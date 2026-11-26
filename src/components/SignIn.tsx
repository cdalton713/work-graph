/** The screen of a page with a sign-in, before the session: one link that starts the sign-in and comes back here. */
import { signInSettings } from "../lib/site";

export function isInAppBrowser() {
  if ((navigator as Navigator & { standalone?: boolean }).standalone ||
      matchMedia("(display-mode: standalone)").matches) return false;
  const ua = navigator.userAgent;
  return /FBAN|FBAV|Instagram|Line\/|MicroMessenger|; wv\)|Slack|Discord/i.test(ua) ||
    /(?:iPhone|iPad|iPod).*AppleWebKit(?!.*(?:Safari|CriOS|FxiOS|EdgiOS))/i.test(ua);
}

export function BrowserSignInHelp() {
  return <p>If sign-in does not complete, open this page in your browser and try again.</p>;
}

export function SignIn() {
  const next = encodeURIComponent(location.pathname + location.search);
  return (
    <div className="app">
      <header className="bar"><span className="brand">work-graph</span></header>
      <main className="stage">
        <div className="blank signin">
          <p>Sign in to view this page.</p>
          <a className="signin-go" href={`/auth/login?next=${next}`}>Sign in with {signInSettings.provider === "linear" ? "Linear" : "Google"}</a>
          {isInAppBrowser() && <BrowserSignInHelp />}
        </div>
      </main>
    </div>
  );
}
