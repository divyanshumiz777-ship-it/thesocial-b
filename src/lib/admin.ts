export const ADMIN_EMAIL = (
  process.env.ADMIN_EMAIL || "divyanshumishra2004@gmail.com"
).toLowerCase();

export function isAdminEmail(email: string | undefined | null): boolean {
  return !!email && email.toLowerCase() === ADMIN_EMAIL;
}
