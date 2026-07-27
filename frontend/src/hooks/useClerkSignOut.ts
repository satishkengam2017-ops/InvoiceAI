// Native default: there is no ClerkProvider in the native root layout
// (app/_layout.tsx) at all - native Google sign-in uses useSSO()'s
// popup-based flow (GoogleSignInButton.tsx), which doesn't hit the cached-
// session/no-account-picker issue this exists to fix on web. See
// useClerkSignOut.web.ts for the real implementation.
export function useClerkSignOut(): () => Promise<void> {
  return async () => {};
}
