import { useAuth as useClerkAuth } from "@clerk/expo";

// Ends the web Clerk session on sign-out. Without this, Clerk's session
// (created by GoogleSignInButton.web.tsx's signIn.sso() redirect flow)
// outlives our own app's sign-out, so the next "Continue with Google"
// click hits the isSignedIn branch there and silently reuses the cached
// session instead of showing Google's account picker - a user could never
// switch Google accounts after signing out.
export function useClerkSignOut(): () => Promise<void> {
  const { signOut } = useClerkAuth();
  return async () => {
    await signOut();
  };
}
