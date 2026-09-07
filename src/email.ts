/**
 * The only outbound email seam used by authentication.
 *
 * Keeping the transport here makes the auth flow deterministic in tests while
 * ensuring production fails closed when Resend is not configured. The magic
 * link token is deliberately never included in logs or error messages.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

export type EmailTransport = (message: EmailMessage) => Promise<void>;

const RESEND_URL = "https://api.resend.com/emails";

/**
 * Sender identity for outbound mail and Web Push. `MEMRACER_EMAIL_FROM` wins;
 * otherwise `memracer@<public host>` when `MEMRACER_PUBLIC_URL` is set, and
 * `memracer@localhost` for a bare local boot.
 */
export function senderAddress(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.MEMRACER_EMAIL_FROM?.trim();
  if (explicit) return explicit;
  const publicUrl = env.MEMRACER_PUBLIC_URL?.trim();
  if (publicUrl) {
    try {
      return `memracer@${new URL(publicUrl).hostname}`;
    } catch {
      // fall through to the local default
    }
  }
  return "memracer@localhost";
}

let testTransport: EmailTransport | null = null;

/** Install an in-memory sender for deterministic tests; never call in production. */
export function setEmailTransportForTests(transport: EmailTransport | null): void {
  testTransport = transport;
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  if (testTransport) {
    await testTransport(message);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("email delivery unavailable: RESEND_API_KEY is not configured");
  }

  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: senderAddress(),
      to: [message.to],
      subject: message.subject,
      html: message.html,
    }),
  });
  if (!response.ok) {
    throw new Error(`email delivery failed (${response.status})`);
  }
}

export async function sendMagicLinkEmail(email: string, url: string, context: "sign-in" | "invite"): Promise<void> {
  const subject = context === "invite" ? "Your memracer project invitation" : "Your memracer sign-in link";
  const greeting = context === "invite" ? "You have been invited to memracer." : "Use this link to sign in to memracer.";
  await sendEmail({
    to: email,
    subject,
    html: `<p>${greeting}</p><p><a href="${escapeHtmlAttribute(url)}">Continue to memracer</a></p><p>This single-use link expires in 15 minutes.</p>`,
  });
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
