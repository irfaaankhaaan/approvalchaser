import { describe, expect, it } from "vitest";
import { MockEmailProvider } from "@/lib/email/mock";
import {
  approvalConfirmationEmail,
  approvalRequestEmail,
  changesRequestedEmail,
  deadlineWarningEmail,
  reminderEmail,
  type EmailContext,
} from "@/lib/email/templates";
import { escapeHtml, safeExternalUrl } from "@/lib/format";

const context: EmailContext = {
  agencyName: "Northlight Studio",
  clientName: "ABC Clothing",
  contactName: "Sarah",
  creativeName: "Instagram Reel #14",
  creativeVersion: "v2",
  creativeUrl: "https://example.com/reel14",
  deadline: new Date("2026-09-18T16:00:00Z"),
  timezone: "UTC",
  approvalUrl: "https://chaser.test/approve/abc123",
  notes: "Focus on the first three seconds.",
};

describe("the mock provider", () => {
  it("records what it was asked to send", async () => {
    const provider = new MockEmailProvider(false);
    const result = await provider.send({
      to: "sarah@example.com",
      subject: "Hello",
      text: "Body",
      html: "<p>Body</p>",
    });

    expect(result.provider).toBe("mock");
    expect(provider.outbox).toHaveLength(1);
    expect(provider.messagesTo("SARAH@example.com")).toHaveLength(1);
  });

  it("clears", async () => {
    const provider = new MockEmailProvider(false);
    await provider.send({ to: "a@b.c", subject: "s", text: "t", html: "h" });
    provider.clear();
    expect(provider.outbox).toHaveLength(0);
  });
});

describe("the five templates", () => {
  it("puts the creative in the subject of the request", () => {
    const message = approvalRequestEmail(context);
    expect(message.subject).toBe("Approval required: Instagram Reel #14 (v2)");
    expect(message.text).toContain("https://chaser.test/approve/abc123");
    expect(message.html).toContain("https://chaser.test/approve/abc123");
  });

  it("says no account is needed, because that is the objection", () => {
    expect(approvalRequestEmail(context).text.toLowerCase()).toContain(
      "no account",
    );
  });

  it("carries the generated wording into the reminder", () => {
    const message = reminderEmail(context, "Just a nudge on the reel.");
    expect(message.text).toContain("Just a nudge on the reel.");
    expect(message.html).toContain("Just a nudge on the reel.");
    expect(message.subject).toContain("Reminder");
  });

  it("marks the deadline warning differently from an ordinary reminder", () => {
    expect(deadlineWarningEmail(context, "Last call.").subject).toContain(
      "Deadline today",
    );
  });

  it("confirms an approval without asking for anything else", () => {
    const message = approvalConfirmationEmail(context);
    expect(message.subject).toBe("Approved: Instagram Reel #14 (v2)");
    expect(message.text).toContain("Nothing else is needed");
  });

  it("echoes the change request back to the client", () => {
    const message = changesRequestedEmail(context, "Swap the opening shot.");
    expect(message.text).toContain("Swap the opening shot.");
    expect(message.html).toContain("Swap the opening shot.");
  });

  it("escapes a creative name that contains markup", () => {
    const message = approvalRequestEmail({
      ...context,
      creativeName: '<script>alert("xss")</script>',
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("escapes a change request that contains markup", () => {
    const message = changesRequestedEmail(
      context,
      '<img src=x onerror="alert(1)">',
    );
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;img");
  });

  it("drops a creative URL that is not http(s), so it cannot become an href", () => {
    const message = approvalRequestEmail({
      ...context,
      creativeUrl: "javascript:alert(1)",
    });
    expect(message.html).not.toContain("javascript:");
    expect(message.text).not.toContain("javascript:");
  });

  it("omits optional sections when there is nothing to show", () => {
    const message = approvalRequestEmail({
      ...context,
      notes: null,
      creativeUrl: null,
      creativeVersion: null,
      contactName: null,
    });
    expect(message.subject).toBe("Approval required: Instagram Reel #14");
    expect(message.text).toContain("Hi,");
    expect(message.text).not.toContain("Preview:");
  });
});

describe("html escaping and URL safety", () => {
  it("escapes every character that matters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(escapeHtml(null)).toBe("");
  });

  it("accepts http and https only", () => {
    expect(safeExternalUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeExternalUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,<script>")).toBeNull();
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});

describe("ResendEmailProvider", () => {
  it("sends the idempotency key as Resend's real request option, not a custom header", async () => {
    let capturedPayload: unknown;
    let capturedOptions: unknown;
    const fakeClient = {
      emails: {
        async send(payload: unknown, options?: unknown) {
          capturedPayload = payload;
          capturedOptions = options;
          return { data: { id: "email_123" }, error: null };
        },
      },
    };

    const { ResendEmailProvider } = await import("@/lib/email/resend");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = new ResendEmailProvider("unused", fakeClient as any);

    const result = await provider.send({
      to: "sarah@example.com",
      subject: "Approval required",
      text: "text",
      html: "<p>html</p>",
      idempotencyKey: "approval:abc:request",
    });

    expect(result).toEqual({ id: "email_123", provider: "resend" });
    // The key claim: idempotencyKey lands in the second argument, which is
    // what becomes Resend's real `Idempotency-Key` header — not stuffed into
    // a payload-level `headers` object Resend never dedupes on.
    expect(capturedOptions).toEqual({ idempotencyKey: "approval:abc:request" });
    expect(capturedPayload).not.toHaveProperty("headers");
  });

  it("omits the options argument entirely when there is no idempotency key", async () => {
    let capturedOptions: unknown = "not called";
    const fakeClient = {
      emails: {
        async send(_payload: unknown, options?: unknown) {
          capturedOptions = options;
          return { data: { id: "email_456" }, error: null };
        },
      },
    };

    const { ResendEmailProvider } = await import("@/lib/email/resend");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = new ResendEmailProvider("unused", fakeClient as any);
    await provider.send({ to: "a@b.com", subject: "s", text: "t", html: "h" });

    expect(capturedOptions).toBeUndefined();
  });

  it("throws EmailDeliveryError when Resend rejects the message", async () => {
    const fakeClient = {
      emails: {
        async send() {
          return { data: null, error: { message: "domain not verified" } };
        },
      },
    };

    const { ResendEmailProvider, } = await import("@/lib/email/resend");
    const { EmailDeliveryError } = await import("@/lib/email/provider");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const provider = new ResendEmailProvider("unused", fakeClient as any);

    await expect(
      provider.send({ to: "a@b.com", subject: "s", text: "t", html: "h" }),
    ).rejects.toThrow(EmailDeliveryError);
  });
});
