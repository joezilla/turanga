import { redirect } from "@sveltejs/kit";

// Post-login landing is the Agents surface.
export function load() {
  redirect(307, "/agents");
}
