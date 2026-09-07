import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail, sendMagicLinkEmail, senderAddress, setEmailTransportForTests } from "../src/email.js";

const originalKey = process.env.RESEND_API_KEY;
const originalFrom = process.env.MEMRACER_EMAIL_FROM;
const originalPublicUrl = process.env.MEMRACER_PUBLIC_URL;

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEmailTransportForTests(null);
  restore("RESEND_API_KEY", originalKey);
  restore("MEMRACER_EMAIL_FROM", originalFrom);
  restore("MEMRACER_PUBLIC_URL", originalPublicUrl);
  vi.unstubAllGlobals();
});

describe("senderAddress", () => {
  it("prefers MEMRACER_EMAIL_FROM", () => {
    expect(senderAddress({ MEMRACER_EMAIL_FROM: " ops@example.com ", MEMRACER_PUBLIC_URL: "https://app.example" }))
      .toBe("ops@example.com");
  });

  it("derives the mailbox from the public host, and falls back to localhost", () => {
    expect(senderAddress({ MEMRACER_PUBLIC_URL: "https://app.example/" })).toBe("memracer@app.example");
    expect(senderAddress({ MEMRACER_PUBLIC_URL: "not a url" })).toBe("memracer@localhost");
    expect(senderAddress({})).toBe("memracer@localhost");
  });
});

describe("passwordless email transport", () => {
  it("fails closed when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendEmail({ to: "a@example.com", subject: "x", html: "<p>x</p>" }))
      .rejects.toThrow(/RESEND_API_KEY is not configured/);
  });

  it("sends through Resend with the configured sender and bearer key", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.MEMRACER_EMAIL_FROM = "memracer@mail.example";
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendEmail({ to: "a@example.com", subject: "Subject", html: "<p>Body</p>" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer re_test_key" }),
      }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      from: "memracer@mail.example",
      to: ["a@example.com"],
      subject: "Subject",
    });
  });

  it("escapes the magic-link URL and identifies invitation mail", async () => {
    let message: { to: string; subject: string; html: string } | undefined;
    setEmailTransportForTests(async (next) => { message = next; });
    const url = "https://memracer.example/join?token=a&x=<secret>";
    await sendMagicLinkEmail("invite@example.com", url, "invite");
    expect(message?.to).toBe("invite@example.com");
    expect(message?.subject).toContain("invitation");
    expect(message?.html).toContain("a&amp;x=&lt;secret&gt;");
    expect(message?.html).not.toContain("x=<secret>");
    expect(message?.html).toContain("single-use link expires in 15 minutes");
  });
});
