import { redirect } from "next/navigation";

// Public self-registration is DISABLED — accounts are created by an admin only.
// Any visit to /sign-up redirects to sign-in.
export default function SignUpPage() {
  redirect("/sign-in");
}
