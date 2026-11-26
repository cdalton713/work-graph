/** The screen of a page with a sign-in, before the session: one link that starts the sign-in and comes back here. */
import { isAppleMobile, isStandalone } from "../lib/screen";
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

export function InstalledSignInHelp() {
  if (!isStandalone() || !isAppleMobile()) return null;
  return <p className="installed-signin-help">
    If sign-in opens in your browser and does not return here, finish signing in there.
    Then use Share and Add to Home Screen from the signed-in page. Open the new icon.
  </p>;
}

export function SignIn() {
  const installed = isStandalone();
  const next = encodeURIComponent(location.pathname + location.search);
  return (
    <div className="app">
      <header className="bar"><span className="brand">work-graph</span>
        {installed && <><span className="station-fill" /><button type="button" className="installed-refresh"
          onClick={() => location.reload()}>Refresh</button></>}
      </header>
      <main className="stage">
        <div className="blank signin">
          <p>Sign in to view this page.</p>
          <a className="signin-go" href={`/auth/login?next=${next}`}>Sign in with {signInSettings.provider === "linear" ? "Linear" : "Google"}</a>
          <InstalledSignInHelp />
          {isInAppBrowser() && <BrowserSignInHelp />}
        </div>
      </main>
    </div>
  );
}
