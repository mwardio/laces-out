import { describe, expect, it } from "vitest";

import type { EmailMessage, EmailTransport } from "@laces-out/email";

import {
  createEmailConfirmationDelivery,
  createPasswordResetEmailDelivery,
} from "./email-delivery.js";

const recipient = "member@example.com";

function transportWith(outcome: "sent" | "failed") {
  const messages: EmailMessage[] = [];
  const transport: EmailTransport = {
    send: (message) => {
      messages.push(message);
      return Promise.resolve(outcome);
    },
  };
  return { transport, messages };
}

describe("createEmailConfirmationDelivery", () => {
  const input = {
    email: recipient,
    displayName: "Member",
    confirmUrl: "https://lacesout.app/verify-email#abc",
    expiresHours: 24,
  };

  it("sends the rendered confirmation email to the requested address", async () => {
    const { transport, messages } = transportWith("sent");
    await createEmailConfirmationDelivery(transport).sendConfirmationEmail(input);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe(recipient);
    expect(messages[0]?.subject).toBe("Confirm your email to open your locker room");
    expect(messages[0]?.text).toContain(input.confirmUrl);
  });

  it("surfaces a transport failure without echoing the recipient", async () => {
    const { transport } = transportWith("failed");
    await expect(
      createEmailConfirmationDelivery(transport).sendConfirmationEmail(input),
    ).rejects.toThrow("Confirmation email transport failed");
    await expect(
      createEmailConfirmationDelivery(transport).sendConfirmationEmail(input),
    ).rejects.not.toThrow(recipient);
  });
});

describe("createPasswordResetEmailDelivery", () => {
  const input = {
    email: recipient,
    displayName: "Member",
    resetUrl: "https://lacesout.app/reset-password#abc",
    expiresMinutes: 30,
  };

  it("sends the rendered reset email to the requested address", async () => {
    const { transport, messages } = transportWith("sent");
    await createPasswordResetEmailDelivery(transport).sendPasswordResetEmail(input);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe(recipient);
    expect(messages[0]?.text).toContain(input.resetUrl);
  });

  it("surfaces a transport failure without echoing the recipient", async () => {
    const { transport } = transportWith("failed");
    await expect(
      createPasswordResetEmailDelivery(transport).sendPasswordResetEmail(input),
    ).rejects.toThrow("Password reset email transport failed");
    await expect(
      createPasswordResetEmailDelivery(transport).sendPasswordResetEmail(input),
    ).rejects.not.toThrow(recipient);
  });
});
