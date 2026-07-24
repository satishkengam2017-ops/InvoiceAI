// Native (iOS/Android): Google sign-in ships web-only for now — Clerk's
// React Native SDK needs a compiled dev build, which isn't set up yet.
// Metro resolves GoogleSignInButton.web.tsx instead of this file on web.
export function GoogleSignInButton(_props: { onError: (message: string) => void }) {
  return null;
}
